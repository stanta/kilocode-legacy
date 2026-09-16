// cd src && pnpm test core/context-management/__tests__/context-composition.spec.ts

import { estimateContextComposition, estimateTokensFromChars, CHARS_PER_TOKEN_ESTIMATE } from "../context-composition"
import { ApiMessage } from "../../task-persistence/apiMessages"

describe("Context Composition Instrumentation (Phase 0)", () => {
	describe("estimateContextComposition", () => {
		it("returns zero-filled categories for empty input", () => {
			const report = estimateContextComposition({ systemPrompt: "", messages: [] })

			expect(report.messageCount).toBe(0)
			expect(report.totalChars).toBe(0)
			expect(report.totalEstTokens).toBe(0)
			expect(report.categories.systemPrompt).toEqual({ chars: 0, estTokens: 0 })
			expect(report.categories.environmentDetails).toEqual({ chars: 0, estTokens: 0 })
			expect(report.categories.toolResults).toEqual({ chars: 0, estTokens: 0 })
			expect(report.categories.taskState).toEqual({ chars: 0, estTokens: 0 })
			expect(report.categories.otherHistory).toEqual({ chars: 0, estTokens: 0 })
		})

		it("attributes the system prompt to its own category", () => {
			const systemPrompt = "You are a coding assistant."
			const report = estimateContextComposition({ systemPrompt, messages: [] })

			expect(report.categories.systemPrompt.chars).toBe(systemPrompt.length)
			expect(report.categories.otherHistory.chars).toBe(0)
			expect(report.totalChars).toBe(systemPrompt.length)
		})

		it("classifies environment_details blocks inside string content separately from other history", () => {
			const envDetails = "<environment_details>\n# Current Mode\n[code]\n</environment_details>"
			const userText = "Please fix the bug."
			const message: ApiMessage = {
				role: "user",
				content: `${userText}\n\n${envDetails}`,
			}

			const report = estimateContextComposition({ systemPrompt: "", messages: [message] })

			expect(report.categories.environmentDetails.chars).toBe(envDetails.length)
			expect(report.categories.otherHistory.chars).toBe(userText.length + 2) // includes the "\n\n" remainder
			expect(report.totalChars).toBe(envDetails.length + userText.length + 2)
		})

		it("classifies environment_details blocks inside text content blocks", () => {
			const envDetails = "<environment_details>details</environment_details>"
			const message: ApiMessage = {
				role: "user",
				content: [{ type: "text", text: envDetails }],
			}

			const report = estimateContextComposition({ systemPrompt: "", messages: [message] })

			expect(report.categories.environmentDetails.chars).toBe(envDetails.length)
			expect(report.categories.otherHistory.chars).toBe(0)
		})

		it("classifies native tool_result blocks (string content) as tool results", () => {
			const resultText = "1: file content line one\n2: line two"
			const message: ApiMessage = {
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "toolu_1", content: resultText },
					{ type: "text", text: "observation follows" },
				],
			}

			const report = estimateContextComposition({ systemPrompt: "", messages: [message] })

			expect(report.categories.toolResults.chars).toBe(resultText.length)
			expect(report.categories.otherHistory.chars).toBe("observation follows".length)
		})

		it("classifies native tool_result blocks with text content arrays as tool results", () => {
			const partOne = "first part"
			const partTwo = "second part"
			const message: ApiMessage = {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_2",
						content: [
							{ type: "text", text: partOne },
							{ type: "text", text: partTwo },
						],
					},
				],
			}

			const report = estimateContextComposition({ systemPrompt: "", messages: [message] })

			expect(report.categories.toolResults.chars).toBe(partOne.length + partTwo.length)
		})

		it("does not double count tool_result text as other history", () => {
			const message: ApiMessage = {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "raw output" }],
			}

			const report = estimateContextComposition({ systemPrompt: "", messages: [message] })

			expect(report.categories.toolResults.chars).toBe("raw output".length)
			expect(report.categories.otherHistory.chars).toBe(0)
			expect(report.totalChars).toBe("raw output".length)
		})

		it("measures thinking and tool_use blocks as other history via serialized length", () => {
			const message: ApiMessage = {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm", signature: "sig" },
					{ type: "tool_use", id: "toolu_4", name: "read_file", input: { path: "a.ts" } },
				],
			}

			const report = estimateContextComposition({ systemPrompt: "", messages: [message] })

			const expected =
				JSON.stringify({ type: "thinking", thinking: "hmm", signature: "sig" }).length +
				JSON.stringify({ type: "tool_use", id: "toolu_4", name: "read_file", input: { path: "a.ts" } }).length
			expect(report.categories.otherHistory.chars).toBe(expected)
		})

		it("excludes image blocks from char accounting", () => {
			const message: ApiMessage = {
				role: "user",
				content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }],
			}

			const report = estimateContextComposition({ systemPrompt: "", messages: [message] })

			expect(report.totalChars).toBe(0)
			expect(report.messageCount).toBe(1)
		})

		it("reserves taskState at zero in Phase 0 even when other categories are populated", () => {
			const message: ApiMessage = {
				role: "user",
				content: [{ type: "text", text: "<environment_details>x</environment_details>some text" }],
			}

			const report = estimateContextComposition({ systemPrompt: "sys", messages: [message] })

			expect(report.categories.taskState).toEqual({ chars: 0, estTokens: 0 })
			expect(report.categories.systemPrompt.chars).toBe(3)
			expect(report.categories.environmentDetails.chars).toBe(
				"<environment_details>x</environment_details>".length,
			)
		})

		it("never mutates the input messages", () => {
			const message: ApiMessage = {
				role: "user",
				content: [{ type: "text", text: "<environment_details>x</environment_details>some text" }],
			}
			const original = JSON.parse(JSON.stringify(message))

			estimateContextComposition({ systemPrompt: "sys", messages: [message] })

			expect(message).toEqual(original)
		})

		it("totals equal the sum of all category chars", () => {
			const message: ApiMessage = {
				role: "user",
				content: [
					{ type: "text", text: "<environment_details>env</environment_details>chat" },
					{ type: "tool_result", tool_use_id: "t", content: "out" },
				],
			}

			const report = estimateContextComposition({ systemPrompt: "prompt", messages: [message] })

			const sum = Object.values(report.categories).reduce((acc, size) => acc + size.chars, 0)
			expect(report.totalChars).toBe(sum)
			expect(report.messageCount).toBe(1)
		})
	})

	describe("estimateTokensFromChars", () => {
		it("uses the documented chars-per-token ratio", () => {
			expect(CHARS_PER_TOKEN_ESTIMATE).toBe(4)
			expect(estimateTokensFromChars(0)).toBe(0)
			expect(estimateTokensFromChars(8)).toBe(2)
		})

		it("rounds partial tokens up", () => {
			expect(estimateTokensFromChars(1)).toBe(1)
			expect(estimateTokensFromChars(9)).toBe(3)
		})
	})
})
