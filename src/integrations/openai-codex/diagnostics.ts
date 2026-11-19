import { Package } from "../../shared/package"

// All fields are whitelisted: never log credentials, prompts, tool arguments or error bodies.
export interface CodexLifecycleEvent {
	phase: string
	operationId?: string
	requestId?: string
	taskId?: string
	instanceId?: string
	attempt?: number
	httpStatus?: number
	code?: string
	elapsedMs?: number
	waiting?: boolean
	authenticated?: boolean
}

let appendLine: ((line: string) => void) | undefined

/** Send lifecycle events to the existing persistent Kilo-Code Output channel. */
export function setCodexDiagnosticOutput(writer: ((line: string) => void) | undefined): () => void {
	appendLine = writer
	return () => {
		if (appendLine === writer) appendLine = undefined
	}
}

export function logCodexLifecycle(event: CodexLifecycleEvent): void {
	if (!appendLine) return
	const safeId = (value?: string) => (value && /^[\w-]{1,128}$/.test(value) ? value : undefined)
	const safePhase = /^[a-z_.-]{1,64}$/.test(event.phase) ? event.phase : "unknown"
	try {
		appendLine(
			"[Codex lifecycle] " +
				JSON.stringify({
					version: Package.version,
					pid: process.pid,
					phase: safePhase,
					operationId: safeId(event.operationId),
					requestId: safeId(event.requestId),
					taskId: safeId(event.taskId),
					instanceId: safeId(event.instanceId),
					attempt: typeof event.attempt === "number" && Number.isSafeInteger(event.attempt) && event.attempt >= 0
						? event.attempt
						: undefined,
					httpStatus: event.httpStatus && event.httpStatus >= 100 && event.httpStatus <= 599 ? event.httpStatus : undefined,
					code: event.code && /^[a-z_]{1,40}$/.test(event.code) ? event.code : undefined,
					elapsedMs: typeof event.elapsedMs === "number" && Number.isFinite(event.elapsedMs) ? Math.round(event.elapsedMs) : undefined,
					waiting: event.waiting,
					authenticated: event.authenticated,
				}),
		)
	} catch {
		// Logging must never change the outcome of a request.
	}
}
