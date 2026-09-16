// cd src && pnpm test core/context/context-management/__tests__/context-window-recovery.spec.ts

import { MAX_CONTEXT_WINDOW_RETRIES, shouldAttemptContextWindowRecovery } from "../context-window-recovery"

describe("Context window overflow recovery (Phase 0)", () => {
	describe("MAX_CONTEXT_WINDOW_RETRIES", () => {
		it("bounds the automatic recovery attempts to a small positive number", () => {
			expect(MAX_CONTEXT_WINDOW_RETRIES).toBeGreaterThan(0)
			expect(MAX_CONTEXT_WINDOW_RETRIES).toBeLessThanOrEqual(5)
		})
	})

	describe("shouldAttemptContextWindowRecovery", () => {
		const contextError = {
			status: 400,
			message: "This model's maximum context length is 4096 tokens",
		}

		it("returns true for a recognized context-window error within the retry budget", () => {
			expect(shouldAttemptContextWindowRecovery(contextError, 0)).toBe(true)
			expect(shouldAttemptContextWindowRecovery(contextError, MAX_CONTEXT_WINDOW_RETRIES - 1)).toBe(true)
		})

		it("returns false once the retry budget is exhausted, preventing infinite retries", () => {
			expect(shouldAttemptContextWindowRecovery(contextError, MAX_CONTEXT_WINDOW_RETRIES)).toBe(false)
			expect(shouldAttemptContextWindowRecovery(contextError, MAX_CONTEXT_WINDOW_RETRIES + 5)).toBe(false)
		})

		it("returns false for non-context errors at any attempt count (generic retry semantics preserved)", () => {
			const genericError = new Error("Internal server error")
			expect(shouldAttemptContextWindowRecovery(genericError, 0)).toBe(false)
			expect(shouldAttemptContextWindowRecovery(genericError, MAX_CONTEXT_WINDOW_RETRIES)).toBe(false)

			const authError = { status: 401, message: "Unauthorized" }
			expect(shouldAttemptContextWindowRecovery(authError, 0)).toBe(false)
		})

		it("returns false for Anthropic-style prompt-too-long errors once budget is exhausted", () => {
			const anthropicError = {
				error: {
					error: {
						type: "invalid_request_error",
						message: "prompt is too long: 150000 tokens > 100000 maximum",
					},
				},
			}
			expect(shouldAttemptContextWindowRecovery(anthropicError, 0)).toBe(true)
			expect(shouldAttemptContextWindowRecovery(anthropicError, MAX_CONTEXT_WINDOW_RETRIES)).toBe(false)
		})

		it("handles falsy error inputs safely", () => {
			expect(shouldAttemptContextWindowRecovery(null, 0)).toBe(false)
			expect(shouldAttemptContextWindowRecovery(undefined, 0)).toBe(false)
		})
	})
})
