import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"

import {
	type ModelInfo,
	deepSeekModels,
	deepSeekDefaultModelId,
	DEEP_SEEK_DEFAULT_TEMPERATURE,
	OPENAI_AZURE_AI_INFERENCE_PATH,
} from "@roo-code/types"

import { type ApiHandlerOptions, getModelMaxOutputTokens, shouldUseReasoningEffort } from "../../shared/api"

import { ApiStream, ApiStreamUsageChunk } from "../transform/stream"
import { getModelParams } from "../transform/model-params"
import { convertToR1Format } from "../transform/r1-format"

import { OpenAiHandler } from "./openai"
import type { ApiHandlerCreateMessageMetadata } from "../index"

// Custom interface for DeepSeek params to support thinking mode and reasoning effort.
// DeepSeek accepts "max" for reasoning_effort, which is not part of OpenAI's type,
// so we omit the OpenAI field and redefine it with DeepSeek's accepted values.
type DeepSeekChatCompletionParams = Omit<OpenAI.Chat.ChatCompletionCreateParamsStreaming, "reasoning_effort"> & {
	thinking?: { type: "enabled" | "disabled" }
	reasoning_effort?: "low" | "high" | "max"
	max_tokens?: number
}

// Maps the extension's reasoning effort values to DeepSeek's accepted values.
// DeepSeek only accepts "low" | "high" | "max", so we fold "minimal" into "low"
// and "xhigh" into "max". "medium", "high", and unset values map to "high".
function mapDeepSeekReasoningEffort(effort?: string): "low" | "high" | "max" {
	if (effort === "low" || effort === "minimal") return "low"
	if (effort === "xhigh") return "max"
	return "high"
}

export class DeepSeekHandler extends OpenAiHandler {
	constructor(options: ApiHandlerOptions) {
		super({
			...options,
			openAiApiKey: options.deepSeekApiKey ?? "not-provided",
			openAiModelId: options.apiModelId ?? deepSeekDefaultModelId,
			openAiBaseUrl: options.deepSeekBaseUrl ?? "https://api.deepseek.com",
			openAiStreamingEnabled: true,
			includeMaxTokens: true,
		})
	}

	override getModel() {
		const id = this.options.apiModelId ?? deepSeekDefaultModelId
		const info = deepSeekModels[id as keyof typeof deepSeekModels] || deepSeekModels[deepSeekDefaultModelId]
		const params = getModelParams({ format: "openai", modelId: id, model: info, settings: this.options })
		return { id, info, ...params }
	}

	override async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		const modelId = this.options.apiModelId ?? deepSeekDefaultModelId
		const modelInfo = this.getModel().info as ModelInfo

		// V4 thinking models advertise explicit reasoning effort support.
		const isThinkingModel = !!modelInfo.supportsReasoningEffort
		const useReasoning = shouldUseReasoningEffort({ model: modelInfo, settings: this.options })

		// Legacy reasoner (V3.2) uses the old user-wrapped system prompt path.
		const isLegacyReasoner = modelId.includes("deepseek-reasoner")

		// Convert messages to R1 format (merges consecutive same-role messages).
		// This is required for DeepSeek which does not support successive messages with the same role.
		// For thinking models (V4 and legacy reasoner), enable mergeToolResultText to preserve
		// reasoning_content during tool call sequences. Without this, environment_details text after
		// tool_results would create user messages that cause DeepSeek to drop all previous reasoning_content.
		// See: https://api-docs.deepseek.com/guides/thinking_mode
		const convertedMessages: OpenAI.Chat.ChatCompletionMessageParam[] = isLegacyReasoner
			? convertToR1Format([{ role: "user", content: systemPrompt }, ...messages], {
					mergeToolResultText: true,
				})
			: [
					{ role: "system", content: systemPrompt },
					...convertToR1Format(messages, { mergeToolResultText: isThinkingModel }),
				]

		const requestOptions: DeepSeekChatCompletionParams = {
			model: modelId,
			temperature: this.options.modelTemperature ?? DEEP_SEEK_DEFAULT_TEMPERATURE,
			messages: convertedMessages,
			stream: true as const,
			stream_options: { include_usage: true },
			// V4 thinking models support an explicit thinking toggle and reasoning effort.
			...(isThinkingModel && { thinking: useReasoning ? { type: "enabled" } : { type: "disabled" } }),
			...(isThinkingModel &&
				useReasoning && {
					reasoning_effort: mapDeepSeekReasoningEffort(
						this.options.reasoningEffort ?? modelInfo.reasoningEffort,
					),
				}),
			// DeepSeek V4 uses max_tokens (not max_completion_tokens).
			max_tokens:
				getModelMaxOutputTokens({
					modelId,
					model: modelInfo,
					settings: this.options,
					format: "openai",
				}) ?? undefined,
			...(metadata?.tools && { tools: this.convertToolsForOpenAI(metadata.tools) }),
			...(metadata?.tool_choice && { tool_choice: metadata.tool_choice }),
			...(metadata?.toolProtocol === "native" && {
				parallel_tool_calls: metadata.parallelToolCalls ?? false,
			}),
		}

		// Check if base URL is Azure AI Inference (for DeepSeek via Azure)
		const isAzureAiInference = this._isAzureAiInference(this.options.deepSeekBaseUrl)

		let stream
		try {
			stream = await this.client.chat.completions.create(
				requestOptions as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
				isAzureAiInference ? { path: OPENAI_AZURE_AI_INFERENCE_PATH } : {},
			)
		} catch (error) {
			const { handleOpenAIError } = await import("./utils/openai-error-handler")
			throw handleOpenAIError(error, "DeepSeek")
		}

		let lastUsage

		for await (const chunk of stream) {
			const delta = chunk.choices?.[0]?.delta ?? {}

			// Handle regular text content
			if (delta.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			// Handle reasoning_content from DeepSeek's interleaved thinking
			// This is the proper way DeepSeek sends thinking content in streaming
			if ("reasoning_content" in delta && delta.reasoning_content) {
				yield {
					type: "reasoning",
					text: (delta.reasoning_content as string) || "",
				}
			}

			// Handle tool calls
			if (delta.tool_calls) {
				for (const toolCall of delta.tool_calls) {
					yield {
						type: "tool_call_partial",
						index: toolCall.index,
						id: toolCall.id,
						name: toolCall.function?.name,
						arguments: toolCall.function?.arguments,
					}
				}
			}

			if (chunk.usage) {
				lastUsage = chunk.usage
			}
		}

		if (lastUsage) {
			yield this.processUsageMetrics(lastUsage, modelInfo)
		}
	}

	// Override to handle DeepSeek's usage metrics, including caching.
	protected override processUsageMetrics(usage: any, _modelInfo?: any): ApiStreamUsageChunk {
		return {
			type: "usage",
			inputTokens: usage?.prompt_tokens || 0,
			outputTokens: usage?.completion_tokens || 0,
			cacheWriteTokens: usage?.prompt_tokens_details?.cache_miss_tokens,
			cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens,
		}
	}
}
