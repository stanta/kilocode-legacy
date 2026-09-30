// kilocode_change - new file
import { checkContextWindowExceededError } from "./context-error-handling"

/**
 * Maximum number of automatic recovery attempts (forced context reduction +
 * retry) when the provider rejects a request because it exceeds the model's
 * context window. Bounds the recovery loop so a persistently-overflowing
 * conversation degrades to the generic error flow instead of retrying forever.
 */
export const MAX_CONTEXT_WINDOW_RETRIES = 3

/**
 * Decides whether an API error should trigger another automatic
 * context-window-overflow recovery attempt.
 *
 * @param error - The error thrown by the provider (typically on first chunk).
 * @param contextWindowRetryAttempt - How many recovery attempts have already
 * been made for this request chain (0-based).
 * @returns True when the error is a recognized context-window overflow AND
 * the recovery budget has not been exhausted.
 */
export function shouldAttemptContextWindowRecovery(error: unknown, contextWindowRetryAttempt: number): boolean {
	return checkContextWindowExceededError(error) && contextWindowRetryAttempt < MAX_CONTEXT_WINDOW_RETRIES
}
