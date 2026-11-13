import * as os from "os"
import { v7 as uuidv7 } from "uuid"
import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	type ModelInfo,
	openAiCodexDefaultModelId,
	OpenAiCodexModelId,
	openAiCodexModels,
	type ReasoningEffort,
	type ReasoningEffortExtended,
	ApiProviderError,
} from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import type { ApiHandlerOptions } from "../../shared/api"

import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"

import { BaseProvider } from "./base-provider"
import type { SingleCompletionHandler, ApiHandlerCreateMessageMetadata, ApiHandlerRequestOptions } from "../index"
import { getApiRequestTimeout } from "./utils/timeout-config"
import { isMcpTool } from "../../utils/mcp-name"
import { sanitizeOpenAiCallId } from "../../utils/tool-id"
import { openAiCodexOAuthManager } from "../../integrations/openai-codex/oauth"
import { t } from "../../i18n"

import { DEFAULT_HEADERS } from "./constants" // kilocode-change

// Get extension version for User-Agent header
const extensionVersion: string = require("../../package.json").version ?? "unknown"

export type OpenAiCodexModel = ReturnType<OpenAiCodexHandler["getModel"]>

/**
 * OpenAI Codex base URL for API requests
 * Per the implementation guide: requests are routed to chatgpt.com/backend-api/codex
 */
const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex"

/**
 * OpenAiCodexHandler - Uses OpenAI Responses API with OAuth authentication
 *
 * Key differences from OpenAiNativeHandler:
 * - Uses OAuth Bearer tokens instead of API keys
 * - Routes requests to Codex backend (chatgpt.com/backend-api/codex)
 * - Subscription-based pricing (no per-token costs)
 * - Limited model subset
 * - Custom headers for Codex backend
 */
type CodexRequestState = {
	eventsSeen: boolean
	completed: boolean
	responseId?: string
	responseOutput?: any[]
	pendingToolCallId?: string
	pendingToolCallName?: string
}

class CodexRequestError extends Error {
	readonly codexRequest = true
	readonly safeToRetry: boolean
	readonly code: "http" | "interrupted" | "cancelled" | "timeout" | "concurrent" | "auth"
	readonly retryAfterMs?: number

	constructor(
		message: string,
		code: CodexRequestError["code"],
		readonly status?: number,
		safeToRetry = false,
		retryAfterMs?: number,
	) {
		super(message)
		this.name = "CodexRequestError"
		this.code = code
		this.safeToRetry = safeToRetry
		this.retryAfterMs = retryAfterMs
	}
}

function codexAbortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new CodexRequestError("Codex request cancelled", "cancelled")
}

/** Awaiting a shared refresh may be cancelled without cancelling the refresh itself. */
function awaitCodexAuth<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(codexAbortReason(signal))
	return new Promise<T>((resolve, reject) => {
		const finish = () => signal.removeEventListener("abort", cancel)
		const cancel = () => { finish(); reject(codexAbortReason(signal)) }
		signal.addEventListener("abort", cancel, { once: true })
		operation.then(
			(value) => { finish(); resolve(value) },
			(error) => { finish(); reject(error) },
		)
	})
}

export class OpenAiCodexHandler extends BaseProvider /* kilocode_change: implements SingleCompletionHandler */ {
	protected options: ApiHandlerOptions
	private readonly providerName = "OpenAI Codex"
	private client?: OpenAI
	private activeRequest = false
	/** Transport is chosen before dispatch. Never switch after an SDK error. */
	private useManualSse = false
	// Complete response output array
	private lastResponseOutput: any[] | undefined
	// Last top-level response id
	private lastResponseId: string | undefined
	// Abort controller for cancelling ongoing requests
	private abortController?: AbortController
	// Session ID for the Codex API (persists for the lifetime of the handler)
	private readonly sessionId: string
	private activeDiagnosticRequests = 0 // kilocode_change

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		// Generate a new session ID for standalone handler usage (fallback)
		this.sessionId = uuidv7()
	}

	/** Independent handler for condensing or other concurrent request. */
	fork(): OpenAiCodexHandler {
		return new OpenAiCodexHandler(this.options)
	}

	private normalizeUsage(usage: any, model: OpenAiCodexModel): ApiStreamUsageChunk | undefined {
		if (!usage) return undefined

		const inputDetails = usage.input_tokens_details ?? usage.prompt_tokens_details

		const hasCachedTokens = typeof inputDetails?.cached_tokens === "number"
		const hasCacheMissTokens = typeof inputDetails?.cache_miss_tokens === "number"
		const cachedFromDetails = hasCachedTokens ? inputDetails.cached_tokens : 0
		const missFromDetails = hasCacheMissTokens ? inputDetails.cache_miss_tokens : 0

		let totalInputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0
		if (totalInputTokens === 0 && inputDetails && (cachedFromDetails > 0 || missFromDetails > 0)) {
			totalInputTokens = cachedFromDetails + missFromDetails
		}

		const totalOutputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0
		const cacheWriteTokens = usage.cache_creation_input_tokens ?? usage.cache_write_tokens ?? 0
		const cacheReadTokens =
			usage.cache_read_input_tokens ?? usage.cache_read_tokens ?? usage.cached_tokens ?? cachedFromDetails ?? 0

		const reasoningTokens =
			typeof usage.output_tokens_details?.reasoning_tokens === "number"
				? usage.output_tokens_details.reasoning_tokens
				: undefined

		// Subscription-based: no per-token costs
		const out: ApiStreamUsageChunk = {
			type: "usage",
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheWriteTokens,
			cacheReadTokens,
			...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
			totalCost: 0, // Subscription-based pricing
		}
		return out
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
		requestOptions?: ApiHandlerRequestOptions,
	): ApiStream {
		if (this.activeRequest) {
			throw new CodexRequestError("Codex handler is already processing a request", "concurrent")
		}
		const model = this.getModel()
		this.activeRequest = true
		this.lastResponseId = undefined
		this.lastResponseOutput = undefined
		const configuredTimeout = getApiRequestTimeout()
		const timeoutMs = typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout) && configuredTimeout > 0
			? configuredTimeout : 600_000
		const deadlineAt = typeof requestOptions?.deadlineAt === "number" && Number.isFinite(requestOptions.deadlineAt)
			? requestOptions.deadlineAt : Date.now() + timeoutMs
		const controller = new AbortController()
		const onAbort = () => controller.abort(new CodexRequestError("Codex request cancelled", "cancelled"))
		if (requestOptions?.signal?.aborted) onAbort()
		else requestOptions?.signal?.addEventListener("abort", onAbort, { once: true })
		const timer = setTimeout(
			() => controller.abort(new CodexRequestError("Codex request deadline exceeded", "timeout")),
			Math.max(0, deadlineAt - Date.now()),
		)
		timer.unref?.()
		const requestState: CodexRequestState = { eventsSeen: false, completed: false }
		// kilocode_change start: observe isolation and stalls without changing request behavior.
		const requestId = uuidv7()
		const started = Date.now()
		let phase = "request.start"
		this.activeDiagnosticRequests++
		const diagnostic = (nextPhase: string, details: Record<string, number | boolean> = {}) => {
			phase = nextPhase
			// Do not log credentials, account identifiers, prompts, error bodies, or tool arguments.
			try { console.info("[OpenAI Codex] Request diagnostic", {
				pid: process.pid,
				handlerId: this.sessionId,
				requestId,
				taskId: metadata?.taskId,
				phase,
				elapsedMs: Date.now() - started,
				activeHandlerRequests: this.activeDiagnosticRequests,
				...details,
			}) } catch { /* diagnostic logging must not break a request */ }
		}
		diagnostic(phase)
		const heartbeat = setInterval(() => diagnostic(phase, { waiting: true }), 30_000)
		heartbeat.unref()
		try {
			if (controller.signal.aborted) throw codexAbortReason(controller.signal)
			yield* this.handleResponsesApiMessage(model, systemPrompt, messages, requestState, controller.signal, deadlineAt, metadata, diagnostic)
			if (!requestState.completed) {
				throw new CodexRequestError("Codex stream closed without a completed response", "interrupted")
			}
			if (controller.signal.aborted) throw codexAbortReason(controller.signal)
			this.lastResponseOutput = requestState.responseOutput
			this.lastResponseId = requestState.responseId
			diagnostic("request.completed")
		} catch (error) {
			diagnostic("request.error", {
				...(typeof error?.status === "number" ? { httpStatus: error.status } : {}),
			})
			throw error
		} finally {
			// On early consumer return: abort first, then allow iterator/reader cleanup.
			if (!controller.signal.aborted) controller.abort()
			clearTimeout(timer)
			requestOptions?.signal?.removeEventListener("abort", onAbort)
			clearInterval(heartbeat)
			this.activeDiagnosticRequests--
			this.activeRequest = false
			diagnostic("request.closed")
		}
		// kilocode_change end
	}

	private async *handleResponsesApiMessage(
		model: OpenAiCodexModel,
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		state: CodexRequestState,
		signal: AbortSignal,
		deadlineAt: number,
		metadata?: ApiHandlerCreateMessageMetadata,
		diagnostic?: (phase: string, details?: Record<string, number | boolean>) => void,
	): ApiStream {
		diagnostic?.("auth.start")
		let snapshot = await awaitCodexAuth(openAiCodexOAuthManager.getTokenSnapshot(signal), signal)
		diagnostic?.("auth.end", { authenticated: !!snapshot })
		if (!snapshot) throw new CodexRequestError("Sign in to OpenAI Codex to continue", "auth")
		const formattedInput = this.formatFullConversation(systemPrompt, messages, metadata?.taskId)
		const body = this.buildRequestBody(model, formattedInput, systemPrompt, this.getReasoningEffort(model), metadata)

		for (let attempt = 0; attempt < 2; attempt++) {
			if (signal.aborted) throw codexAbortReason(signal)
			try {
				yield* this.executeRequest(body, model, snapshot, state, signal, deadlineAt, metadata?.taskId, diagnostic)
				return
			} catch (error) {
				if (signal.aborted) throw codexAbortReason(signal)
				if (!(error instanceof CodexRequestError) ||
					error.status !== 401 || state.eventsSeen || attempt !== 0) throw error

				diagnostic?.("auth.refresh.start")
				snapshot = await awaitCodexAuth(
					openAiCodexOAuthManager.forceRefreshTokenSnapshot(snapshot.accessToken, signal),
					signal,
				)
				diagnostic?.("auth.refresh.end", { authenticated: !!snapshot })
				if (!snapshot) throw new CodexRequestError("Sign in to OpenAI Codex to continue", "auth", 401)
			}
		}
	}

	private buildRequestBody(
		model: OpenAiCodexModel,
		formattedInput: any,
		systemPrompt: string,
		reasoningEffort: ReasoningEffortExtended | undefined,
		metadata?: ApiHandlerCreateMessageMetadata,
	): any {
		const ensureAllRequired = (schema: any): any => {
			if (!schema || typeof schema !== "object" || schema.type !== "object") {
				return schema
			}

			const result = { ...schema }
			if (result.additionalProperties !== false) {
				result.additionalProperties = false
			}

			if (result.properties) {
				const allKeys = Object.keys(result.properties)
				result.required = allKeys

				const newProps = { ...result.properties }
				for (const key of allKeys) {
					const prop = newProps[key]
					if (prop.type === "object") {
						newProps[key] = ensureAllRequired(prop)
					} else if (prop.type === "array" && prop.items?.type === "object") {
						newProps[key] = {
							...prop,
							items: ensureAllRequired(prop.items),
						}
					}
				}
				result.properties = newProps
			}

			return result
		}

		const ensureAdditionalPropertiesFalse = (schema: any): any => {
			if (!schema || typeof schema !== "object" || schema.type !== "object") {
				return schema
			}

			const result = { ...schema }
			if (result.additionalProperties !== false) {
				result.additionalProperties = false
			}

			if (result.properties) {
				const newProps = { ...result.properties }
				for (const key of Object.keys(result.properties)) {
					const prop = newProps[key]
					if (prop && prop.type === "object") {
						newProps[key] = ensureAdditionalPropertiesFalse(prop)
					} else if (prop && prop.type === "array" && prop.items?.type === "object") {
						newProps[key] = {
							...prop,
							items: ensureAdditionalPropertiesFalse(prop.items),
						}
					}
				}
				result.properties = newProps
			}

			return result
		}

		interface ResponsesRequestBody {
			model: string
			input: Array<{ role: "user" | "assistant"; content: any[] } | { type: string; content: string }>
			stream: boolean
			reasoning?: { effort?: ReasoningEffortExtended; summary?: "auto" }
			temperature?: number
			store?: boolean
			instructions?: string
			include?: string[]
			tools?: Array<{
				type: "function"
				name: string
				description?: string
				parameters?: any
				strict?: boolean
			}>
			tool_choice?: any
			parallel_tool_calls?: boolean
		}

		// Per the implementation guide: Codex backend may reject max_output_tokens
		// and prompt_cache_retention, so we omit them
		const body: ResponsesRequestBody = {
			model: model.id,
			input: formattedInput,
			stream: true,
			store: false,
			instructions: systemPrompt,
			// Only include encrypted reasoning content when reasoning effort is set
			...(reasoningEffort ? { include: ["reasoning.encrypted_content"] } : {}),
			...(reasoningEffort
				? {
						reasoning: {
							...(reasoningEffort ? { effort: reasoningEffort } : {}),
							summary: "auto" as const,
						},
					}
				: {}),
			...(metadata?.tools && {
				tools: metadata.tools
					.filter((tool) => tool.type === "function")
					.map((tool) => {
						const isMcp = isMcpTool(tool.function.name)
						return {
							type: "function",
							name: tool.function.name,
							description: tool.function.description,
							parameters: isMcp
								? ensureAdditionalPropertiesFalse(tool.function.parameters)
								: ensureAllRequired(tool.function.parameters),
							strict: !isMcp,
						}
					}),
			}),
			...(metadata?.tool_choice && { tool_choice: metadata.tool_choice }),
		}

		// For native tool protocol, control parallel tool calls
		if (metadata?.toolProtocol === "native") {
			body.parallel_tool_calls = metadata.parallelToolCalls ?? false
		}

		return body
	}

	private async *executeRequest(
		requestBody: any,
		model: OpenAiCodexModel,
		snapshot: { accessToken: string; accountId?: string },
		state: CodexRequestState,
		signal: AbortSignal,
		deadlineAt: number,
		taskId?: string,
		diagnostic?: (phase: string, details?: Record<string, number | boolean>) => void,
	): ApiStream {
		if (signal.aborted) throw codexAbortReason(signal)
		const codexHeaders: Record<string, string> = {
			originator: "kilo-code",
			session_id: taskId || this.sessionId,
			"User-Agent": DEFAULT_HEADERS["User-Agent"],
			...(snapshot.accountId ? { "ChatGPT-Account-Id": snapshot.accountId } : {}),
		}
		if (this.useManualSse) {
			yield* this.makeCodexRequest(requestBody, model, snapshot, state, signal, taskId, diagnostic)
			return
		}

		const client = this.client ?? new OpenAI({
			apiKey: snapshot.accessToken,
			baseURL: CODEX_API_BASE_URL,
			defaultHeaders: codexHeaders,
			maxRetries: 0,
		})
		try {
			diagnostic?.("sdk.open.start")
			const stream = await (client as any).responses.create(requestBody, {
				signal,
				headers: codexHeaders,
				maxRetries: 0,
				timeout: Math.max(1, deadlineAt - Date.now()),
			}) as AsyncIterable<any>
			diagnostic?.("sdk.open.end")
			if (typeof stream?.[Symbol.asyncIterator] !== "function") {
				throw new CodexRequestError("Codex SDK did not provide a stream", "interrupted")
			}
			for await (const event of stream) {
				if (signal.aborted) throw codexAbortReason(signal)
				state.eventsSeen = true
				for await (const output of this.processEvent(event, model, state)) {
					if (signal.aborted) throw codexAbortReason(signal)
					yield output
				}
			}
		} catch (error) {
			if (signal.aborted) throw codexAbortReason(signal)
			if (error instanceof CodexRequestError) throw error
			const status = typeof (error as any)?.status === "number" ? (error as any).status : undefined
			const headers = (error as any)?.headers
			const retryAfter = headers?.get?.("retry-after") ?? headers?.["retry-after"]
			const retryAfterSeconds = Number(retryAfter)
			const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
				? retryAfterSeconds * 1000 : undefined
			throw new CodexRequestError(
				status ? "Codex request rejected (HTTP " + status + ")" : "Codex transport interrupted",
				status ? "http" : "interrupted",
				status,
				!state.eventsSeen && status !== undefined && (status === 429 || status >= 500 && status <= 599),
				retryAfterMs,
			)
		}
	}

	private formatFullConversation(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		taskId?: string, // kilocode_change
	): any {
		const formattedInput: any[] = []

		for (const message of messages) {
			// Check if this is a reasoning item
			if ((message as any).type === "reasoning") {
				formattedInput.push(message)
				continue
			}

			if (message.role === "user") {
				const content: any[] = []
				const toolResults: any[] = []

				if (typeof message.content === "string") {
					content.push({ type: "input_text", text: message.content })
				} else if (Array.isArray(message.content)) {
					for (const block of message.content) {
						if (block.type === "text") {
							content.push({ type: "input_text", text: block.text })
						} else if (block.type === "image") {
							const image = block as Anthropic.Messages.ImageBlockParam
							const imageUrl =
								"media_type" in image.source && "data" in image.source
									? `data:${image.source.media_type};base64,${image.source.data}`
									: image.source.url // kilocode_change
							content.push({ type: "input_image", image_url: imageUrl })
						} else if (block.type === "tool_result") {
							const result =
								typeof block.content === "string"
									? block.content
									: block.content?.map((c) => (c.type === "text" ? c.text : "")).join("") || ""
							toolResults.push({
								type: "function_call_output",
								// Sanitize and truncate call_id to fit OpenAI's 64-char limit
								call_id: sanitizeOpenAiCallId(block.tool_use_id),
								output: result,
							})
						}
					}
				}

				if (content.length > 0) {
					formattedInput.push({ role: "user", content })
				}

				if (toolResults.length > 0) {
					formattedInput.push(...toolResults)
				}
			} else if (message.role === "assistant") {
				const content: any[] = []
				const toolCalls: any[] = []

				if (typeof message.content === "string") {
					content.push({ type: "output_text", text: message.content })
				} else if (Array.isArray(message.content)) {
					for (const block of message.content) {
						if (block.type === "text") {
							content.push({ type: "output_text", text: block.text })
						} else if (block.type === "tool_use") {
							toolCalls.push({
								type: "function_call",
								// Sanitize and truncate call_id to fit OpenAI's 64-char limit
								call_id: sanitizeOpenAiCallId(block.id),
								name: block.name,
								arguments: JSON.stringify(block.input),
							})
						}
					}
				}

				if (content.length > 0) {
					formattedInput.push({ role: "assistant", content })
				}

				if (toolCalls.length > 0) {
					formattedInput.push(...toolCalls)
				}
			}
		}

		// kilocode_change start
		// A completed task may be continued with an older attempt_completion still lacking
		// its result. Validate the final, normalized input, not just the last assistant turn.
		// Repair only this control tool: never invent execution results for other tools.
		const outputCallIds = new Set(
			formattedInput.filter((item) => item.type === "function_call_output").map((item) => item.call_id),
		)
		const repairedCompletionCallIds: string[] = []
		const unresolvedCallIds: string[] = []
		const validatedInput = formattedInput.flatMap((item) => {
			if (item.type !== "function_call" || outputCallIds.has(item.call_id)) {
				return [item]
			}
			if (item.name !== "attempt_completion") {
				unresolvedCallIds.push(item.call_id)
				return [item]
			}

			repairedCompletionCallIds.push(item.call_id)
			return [
				item,
				{
					type: "function_call_output",
					call_id: item.call_id,
					output: "The result of this earlier attempt_completion was not recorded. User acceptance is unknown. Continue using the subsequent conversation, if any.",
				},
			]
		})

		if (repairedCompletionCallIds.length > 0 || unresolvedCallIds.length > 0) {
			// Only protocol identifiers: no message contents, tool arguments, or credentials.
			console.warn("[OpenAI Codex] Incomplete tool history", {
				taskId,
				repairedCompletionCallIds,
				unresolvedCallIds,
			})
		}
		return validatedInput
		// kilocode_change end
	}

	private async *makeCodexRequest(
		requestBody: any,
		model: OpenAiCodexModel,
		snapshot: { accessToken: string; accountId?: string },
		state: CodexRequestState,
		signal: AbortSignal,
		taskId?: string,
		diagnostic?: (phase: string, details?: Record<string, number | boolean>) => void,
	): ApiStream {
		if (signal.aborted) throw codexAbortReason(signal)
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: "Bearer " + snapshot.accessToken,
			originator: "kilo-code",
			session_id: taskId || this.sessionId,
			"User-Agent": DEFAULT_HEADERS["User-Agent"],
			...(snapshot.accountId ? { "ChatGPT-Account-Id": snapshot.accountId } : {}),
		}
		let response: Response
		try {
			diagnostic?.("sse.open.start")
			response = await fetch(CODEX_API_BASE_URL + "/responses", {
				method: "POST", headers, body: JSON.stringify(requestBody), signal,
			})
			diagnostic?.("sse.open.end", { httpStatus: response.status })
		} catch (error) {
			if (signal.aborted) throw codexAbortReason(signal)
			throw new CodexRequestError("Codex SSE transport interrupted", "interrupted")
		}
		if (!response.ok) {
			// HTTP 429 / 5xx is an explicit pre-response refusal; do not log the response body.
			const retryAfter = Number(response.headers.get("retry-after"))
			const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
				? retryAfter * 1000 : undefined
			void response.body?.cancel().catch(() => {})
			throw new CodexRequestError(
				"Codex request rejected (HTTP " + response.status + ")",
				"http",
				response.status,
				response.status === 429 || response.status >= 500 && response.status <= 599,
				retryAfterMs,
			)
		}
		if (!response.body) throw new CodexRequestError("Codex response body missing", "interrupted")
		diagnostic?.("sse.read.start")
		yield* this.handleStreamResponse(response.body, model, state, signal)
		diagnostic?.("sse.read.end")
	}

	private async *handleStreamResponse(
		body: ReadableStream<Uint8Array>,
		model: OpenAiCodexModel,
		state: CodexRequestState,
		signal: AbortSignal,
	): ApiStream {
		const reader = body.getReader()
		const decoder = new TextDecoder()
		let pending = ""
		const parseFrame = (frame: string): any | null => {
			const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart()).join("\n")
			if (!data || data === "[DONE]") return null
			try {
				return JSON.parse(data)
			} catch {
				throw new CodexRequestError("Malformed Codex SSE frame", "interrupted")
			}
		}
		try {
			while (true) {
				if (signal.aborted) throw codexAbortReason(signal)
				const { done, value } = await reader.read()
				if (done) break
				pending += decoder.decode(value, { stream: true })
				const frames = pending.split(/\r?\n\r?\n/)
				pending = frames.pop() ?? ""
				for (const frame of frames) {
					const event = parseFrame(frame)
					if (!event) continue
					state.eventsSeen = true
					for await (const out of this.processEvent(event, model, state)) {
						if (signal.aborted) throw codexAbortReason(signal)
						yield out
					}
				}
			}
			pending += decoder.decode()
			// The final SSE frame need not end with a newline.
			if (pending.trim()) {
				const event = parseFrame(pending)
				if (event) {
					state.eventsSeen = true
					for await (const out of this.processEvent(event, model, state)) {
						if (signal.aborted) throw codexAbortReason(signal)
						yield out
					}
				}
			}
		} finally {
			// Abort is already signalled on cancellation. Cancel the reader on early return.
			void reader.cancel().catch(() => {})
			reader.releaseLock()
		}
	}

	private async *processEvent(event: any, model: OpenAiCodexModel, state: CodexRequestState): ApiStream {
		if (event?.response?.output && Array.isArray(event.response.output)) {
			state.responseOutput = event.response.output
		}
		if (event?.response?.id) {
			state.responseId = event.response.id as string
		}

		// Terminal states are authoritative: EOF or a failed/incomplete response is never success.
		const responseStatus = event?.response?.status
		if (
			event?.type === "response.failed" || event?.type === "response.error" || event?.type === "error" ||
			event?.type === "response.incomplete" || responseStatus === "failed" || responseStatus === "incomplete"
		) {
			throw new CodexRequestError("Codex response failed or incomplete", "interrupted")
		}
		if (event?.type === "response.completed" || event?.type === "response.done") {
			state.completed = true
		}

		// Handle text deltas
		/* kilocode_change: don't yield text deltas, the full text is yielded as part of response.output_item.done
		if (event?.type === "response.text.delta" || event?.type === "response.output_text.delta") {
			if (event?.delta) {
				yield { type: "text", text: event.delta }
			}
			return
		}
		*/

		// Handle reasoning deltas
		if (
			event?.type === "response.reasoning.delta" ||
			event?.type === "response.reasoning_text.delta" ||
			event?.type === "response.reasoning_summary.delta" ||
			event?.type === "response.reasoning_summary_text.delta"
		) {
			if (event?.delta) {
				yield { type: "reasoning", text: event.delta }
			}
			return
		}

		// Handle refusal deltas
		if (event?.type === "response.refusal.delta") {
			if (event?.delta) {
				yield { type: "text", text: `[Refusal] ${event.delta}` }
			}
			return
		}

		// Handle tool/function call deltas
		if (
			event?.type === "response.tool_call_arguments.delta" ||
			event?.type === "response.function_call_arguments.delta"
		) {
			const callId = event.call_id || event.tool_call_id || event.id || state.pendingToolCallId
			const name = event.name || event.function_name || state.pendingToolCallName
			const args = event.delta || event.arguments

			// Codex/Responses may stream tool-call arguments, but these delta events are not guaranteed
			// to include a stable id/name. Avoid emitting incomplete tool_call_partial chunks because
			// NativeToolCallParser requires a name to start a call.
			if (typeof callId === "string" && callId.length > 0 && typeof name === "string" && name.length > 0) {
				yield {
					type: "tool_call_partial",
					index: event.index ?? 0,
					id: callId,
					name,
					arguments: typeof args === "string" ? args : "",
				}
			}
			return
		}

		// Handle tool/function call completion
		if (
			event?.type === "response.tool_call_arguments.done" ||
			event?.type === "response.function_call_arguments.done"
		) {
			return
		}

		// Handle output item events
		if (event?.type === "response.output_item.added" || event?.type === "response.output_item.done") {
			const item = event?.item
			if (item) {
				// Capture tool identity so subsequent argument deltas can be attributed.
				if (item.type === "function_call" || item.type === "tool_call") {
					const callId = item.call_id || item.tool_call_id || item.id
					const name = item.name || item.function?.name || item.function_name
					if (typeof callId === "string" && callId.length > 0) {
						state.pendingToolCallId = callId
						state.pendingToolCallName = typeof name === "string" ? name : undefined
					}
				}

				if (item.type === "text" && item.text) {
					yield { type: "text", text: item.text }
				} else if (item.type === "reasoning" && item.text) {
					yield { type: "reasoning", text: item.text }
				} else if (item.type === "message" && Array.isArray(item.content)) {
					for (const content of item.content) {
						if ((content?.type === "text" || content?.type === "output_text") && content?.text) {
							yield { type: "text", text: content.text }
						}
					}
				} else if (
					(item.type === "function_call" || item.type === "tool_call") &&
					event.type === "response.output_item.done"
				) {
					const callId = item.call_id || item.tool_call_id || item.id
					if (callId) {
						const args = item.arguments || item.function?.arguments || item.function_arguments
						yield {
							type: "tool_call",
							id: callId,
							name: item.name || item.function?.name || item.function_name || "",
							arguments: typeof args === "string" ? args : "{}",
						}
					}
				}
			}
			return
		}

		// Handle completion events
		if (event?.type === "response.done" || event?.type === "response.completed") {
			const usage = event?.response?.usage || event?.usage || undefined
			const usageData = this.normalizeUsage(usage, model)
			if (usageData) {
				yield usageData
			}
			return
		}

		// Fallbacks
		if (event?.choices?.[0]?.delta?.content) {
			yield { type: "text", text: event.choices[0].delta.content }
			return
		}

		if (event?.usage) {
			const usageData = this.normalizeUsage(event.usage, model)
			if (usageData) {
				yield usageData
			}
		}
	}

	private getReasoningEffort(model: OpenAiCodexModel): ReasoningEffortExtended | undefined {
		const selected = (this.options.reasoningEffort as any) ?? (model.info.reasoningEffort as any)
		return selected && selected !== "disable" && selected !== "none" ? (selected as any) : undefined
	}

	override getModel() {
		const modelId = this.options.apiModelId

		let id = modelId && modelId in openAiCodexModels ? (modelId as OpenAiCodexModelId) : openAiCodexDefaultModelId

		const info: ModelInfo = openAiCodexModels[id]

		const params = getModelParams({
			format: "openai",
			modelId: id,
			model: info,
			settings: this.options,
			defaultTemperature: 0,
		})

		return { id, info, ...params }
	}

	getEncryptedContent(): { encrypted_content: string; id?: string } | undefined {
		if (!this.lastResponseOutput) return undefined

		const reasoningItem = this.lastResponseOutput.find(
			(item) => item.type === "reasoning" && item.encrypted_content,
		)

		if (!reasoningItem?.encrypted_content) return undefined

		return {
			encrypted_content: reasoningItem.encrypted_content,
			...(reasoningItem.id ? { id: reasoningItem.id } : {}),
		}
	}

	getResponseId(): string | undefined {
		return this.lastResponseId
	}

	async completePrompt_deleted_by_kilocode_because_streaming_is_required(prompt: string): Promise<string> {
		this.abortController = new AbortController()

		try {
			const model = this.getModel()

			// Get access token
			const accessToken = await openAiCodexOAuthManager.getAccessToken()
			if (!accessToken) {
				throw new Error(
					t("common:errors.openAiCodex.notAuthenticated", {
						defaultValue:
							"Not authenticated with OpenAI Codex. Please sign in using the OpenAI Codex OAuth flow.",
					}),
				)
			}

			const reasoningEffort = this.getReasoningEffort(model)

			const requestBody: any = {
				model: model.id,
				input: [
					{
						role: "user",
						content: [{ type: "input_text", text: prompt }],
					},
				],
				stream: false,
				store: false,
				...(reasoningEffort ? { include: ["reasoning.encrypted_content"] } : {}),
			}

			if (reasoningEffort) {
				requestBody.reasoning = {
					effort: reasoningEffort,
					summary: "auto" as const,
				}
			}

			const url = `${CODEX_API_BASE_URL}/responses`

			// Get ChatGPT account ID for organization subscriptions
			const accountId = await openAiCodexOAuthManager.getAccountId()

			// Build headers with required Codex-specific fields
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
				originator: "kilo-code", // kilocode_change
				session_id: this.sessionId,
				"User-Agent": DEFAULT_HEADERS["User-Agent"], // kilocode_change
			}

			// Add ChatGPT-Account-Id if available
			if (accountId) {
				headers["ChatGPT-Account-Id"] = accountId
			}

			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(requestBody),
				signal: this.abortController.signal,
			})

			if (!response.ok) {
				const errorText = await response.text()
				throw new Error(
					t("common:errors.openAiCodex.genericError", { status: response.status }) +
						(errorText ? `: ${errorText}` : ""),
				)
			}

			const responseData = await response.json()

			if (responseData?.output && Array.isArray(responseData.output)) {
				for (const outputItem of responseData.output) {
					if (outputItem.type === "message" && outputItem.content) {
						for (const content of outputItem.content) {
							if (content.type === "output_text" && content.text) {
								return content.text
							}
						}
					}
				}
			}

			if (responseData?.text) {
				return responseData.text
			}

			return ""
		} catch (error) {
			const errorModel = this.getModel()
			const errorMessage = error instanceof Error ? error.message : String(error)
			const apiError = new ApiProviderError(errorMessage, this.providerName, errorModel.id, "completePrompt")
			TelemetryService.instance.captureException(apiError)

			if (error instanceof Error) {
				throw new Error(t("common:errors.openAiCodex.completionError", { message: error.message }))
			}
			throw error
		} finally {
			this.abortController = undefined
		}
	}
}
