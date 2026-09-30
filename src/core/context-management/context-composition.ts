// kilocode_change - new file
import { Anthropic } from "@anthropic-ai/sdk"

import { ApiMessage } from "../task-persistence/apiMessages"

/**
 * Context Composition Instrumentation (Phase 0 of the task-state integration plan).
 *
 * Pure, read-only analysis of what a request payload is composed of, by category:
 * - systemPrompt: the static system prompt sent with the request
 * - environmentDetails: `<environment_details>` blocks embedded in user messages
 * - toolResults: native `tool_result` content blocks
 * - taskState: the bounded U1 `TaskExecutionState` block when enabled
 * - otherHistory: remaining conversation content
 *
 * This module never mutates or filters messages; it only measures. It is invoked
 * from Task right before the API request is created, gated behind the
 * `contextCompositionInstrumentation` experiment (default off), so with the flag
 * disabled the outgoing request payload is bit-for-bit unchanged.
 *
 * Privacy: reports contain only char counts and token estimates - never content.
 */

/** Categories tracked by the composition report. */
export const CONTEXT_COMPOSITION_CATEGORIES = [
	"systemPrompt",
	"environmentDetails",
	"toolResults",
	"taskState",
	"otherHistory",
] as const

export type ContextCompositionCategory = (typeof CONTEXT_COMPOSITION_CATEGORIES)[number]

export type ContextCompositionCategorySize = {
	/** Total characters attributed to this category. */
	chars: number
	/** Cheap deterministic token estimate derived from `chars`. */
	estTokens: number
}

export type ContextCompositionReport = {
	/** Number of messages included in the measurement. */
	messageCount: number
	/** Sum of all category char counts. */
	totalChars: number
	/** Sum of all category token estimates. */
	totalEstTokens: number
	/** Per-category sizes. Every category is always present (zero-filled). */
	categories: Record<ContextCompositionCategory, ContextCompositionCategorySize>
}

/**
 * Rough chars-per-token ratio used for local, provider-agnostic estimates.
 * Intentionally constant and deterministic so reports are comparable over time;
 * exact provider token counting is intentionally NOT used here to keep the
 * instrumentation cheap and free of side effects.
 */
export const CHARS_PER_TOKEN_ESTIMATE = 4

export function estimateTokensFromChars(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE)
}

// `<environment_details> ... </environment_details>` blocks produced by
// getEnvironmentDetails() and embedded in user messages.
const ENVIRONMENT_DETAILS_PATTERN = /<environment_details>[\s\S]*?<\/environment_details>/g
const TASK_EXECUTION_STATE_PATTERN = /<task_execution_state\b[^>]*>[\s\S]*?<\/task_execution_state>/g

function emptyCategory(): ContextCompositionCategorySize {
	return { chars: 0, estTokens: 0 }
}

function emptyReport(): ContextCompositionReport {
	const categories = {} as Record<ContextCompositionCategory, ContextCompositionCategorySize>
	for (const category of CONTEXT_COMPOSITION_CATEGORIES) {
		categories[category] = emptyCategory()
	}
	return { messageCount: 0, totalChars: 0, totalEstTokens: 0, categories }
}

function addChars(report: ContextCompositionReport, category: ContextCompositionCategory, chars: number): void {
	if (chars <= 0) {
		return
	}
	report.categories[category].chars += chars
}

function finalize(report: ContextCompositionReport): ContextCompositionReport {
	report.totalChars = 0
	for (const category of CONTEXT_COMPOSITION_CATEGORIES) {
		const size = report.categories[category]
		size.estTokens = estimateTokensFromChars(size.chars)
		report.totalChars += size.chars
	}
	report.totalEstTokens = estimateTokensFromChars(report.totalChars)
	return report
}

/**
 * Splits a text block into environment-details segments and the remainder.
 * Returns the chars belonging to each category so overlapping tags are never
 * double counted.
 */
function classifyText(text: string, report: ContextCompositionReport): void {
	if (!text) {
		return
	}

	for (const match of text.matchAll(ENVIRONMENT_DETAILS_PATTERN)) {
		const environmentBlock = match[0]
		let taskStateChars = 0
		for (const stateMatch of environmentBlock.matchAll(TASK_EXECUTION_STATE_PATTERN)) {
			taskStateChars += stateMatch[0].length
		}
		addChars(report, "taskState", taskStateChars)
		addChars(report, "environmentDetails", environmentBlock.length - taskStateChars)
	}

	// split() with the same pattern yields everything outside the matched
	// blocks, regardless of duplicated blocks.
	const remainder = text.split(ENVIRONMENT_DETAILS_PATTERN).join("")
	addChars(report, "otherHistory", remainder.length)
}

/** Measures the size of a native `tool_result` block's content. */
function measureToolResultBlock(block: Anthropic.ToolResultBlockParam, report: ContextCompositionReport): void {
	const content = block.content
	if (typeof content === "string") {
		addChars(report, "toolResults", content.length)
		return
	}
	if (Array.isArray(content)) {
		for (const part of content) {
			if (part.type === "text") {
				addChars(report, "toolResults", part.text.length)
			} else {
				// Non-text tool result content (e.g. images) has no meaningful
				// char size; count nothing rather than guessing.
			}
		}
	}
}

function classifyMessage(message: ApiMessage, report: ContextCompositionReport): void {
	report.messageCount++

	const content = message.content
	if (typeof content === "string") {
		classifyText(content, report)
		return
	}

	if (!Array.isArray(content)) {
		return
	}

	for (const block of content) {
		switch (block.type) {
			case "text":
				classifyText(block.text, report)
				break
			case "tool_result":
				measureToolResultBlock(block as Anthropic.ToolResultBlockParam, report)
				break
			case "image":
				// Images carry base64 data whose length is not comparable to
				// text tokens; deliberately excluded from char accounting.
				break
			default:
				// thinking/redacted_thinking/reasoning/tool_use and any other
				// blocks: serialized conservatively via JSON length as an
				// approximation of their payload size.
				addChars(report, "otherHistory", JSON.stringify(block).length)
				break
		}
	}
}

/**
 * Computes the composition of an outgoing request by category.
 *
 * @param systemPrompt - The system prompt that will be sent with the request.
 * @param messages - The effective conversation history that will be sent.
 * @returns A report of char sizes and token estimates per category. The
 * `taskState` is measured separately when the U1 task-execution-state block
 * is present inside environment details.
 */
export function estimateContextComposition({
	systemPrompt,
	messages,
}: {
	systemPrompt: string
	messages: ApiMessage[]
}): ContextCompositionReport {
	const report = emptyReport()

	addChars(report, "systemPrompt", systemPrompt?.length ?? 0)

	for (const message of messages ?? []) {
		classifyMessage(message, report)
	}

	return finalize(report)
}
