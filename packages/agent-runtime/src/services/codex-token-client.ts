import { randomUUID } from "node:crypto"

export type CodexTokenSnapshot = { accessToken: string; accountId?: string } | null
export type CodexTokenRequest = {
	type: "codexTokenRequest"
	requestId: string
	rejectedAccessToken?: string
}
export type CodexTokenResponse = {
	type: "codexTokenResponse"
	requestId?: string
	snapshot?: CodexTokenSnapshot
	error?: { code: string; status?: number }
}

/** Only access-token snapshots are exchanged. The refresh token stays in parent SecretStorage. */
export function createCodexTokenClient(send: (message: CodexTokenRequest) => void, timeoutMs = 60_000) {
	const pending = new Map<
		string,
		{
			resolve: (snapshot: CodexTokenSnapshot) => void
			reject: (error: Error) => void
		}
	>()

	const request = (rejectedAccessToken?: string, signal?: AbortSignal): Promise<CodexTokenSnapshot> => {
		if (signal?.aborted) return Promise.reject(new Error("Codex token request cancelled"))
		return new Promise<CodexTokenSnapshot>((resolve, reject) => {
			const requestId = randomUUID()
			let timer: ReturnType<typeof setTimeout> | undefined
			const cleanup = () => {
				if (timer) clearTimeout(timer)
				signal?.removeEventListener("abort", onAbort)
				pending.delete(requestId)
			}
			const finish = {
				resolve: (snapshot: CodexTokenSnapshot) => {
					cleanup()
					resolve(snapshot)
				},
				reject: (error: Error) => {
					cleanup()
					reject(error)
				},
			}
			const onAbort = () => finish.reject(new Error("Codex token request cancelled"))
			timer = setTimeout(() => finish.reject(new Error("Codex token parent timed out")), timeoutMs)
			timer.unref?.()
			pending.set(requestId, finish)
			signal?.addEventListener("abort", onAbort, { once: true })
			try {
				send({ type: "codexTokenRequest", requestId, rejectedAccessToken })
			} catch {
				finish.reject(new Error("Codex token parent disconnected"))
			}
		})
	}

	const receive = (input: unknown): boolean => {
		if (!input || typeof input !== "object") return false
		const message = input as Partial<CodexTokenResponse>
		if (message.type !== "codexTokenResponse") return false
		const operation = typeof message.requestId === "string" && pending.get(message.requestId)
		if (operation) {
			if (message.error) {
				const error = Object.assign(new Error("Codex token parent unavailable"), {
					code: message.error.code,
					status: message.error.status,
				})
				operation.reject(error)
			} else if (
				message.snapshot === null ||
				(message.snapshot &&
					typeof message.snapshot.accessToken === "string" &&
					message.snapshot.accessToken.length > 0)
			) {
				operation.resolve(message.snapshot)
			} else {
				operation.reject(new Error("Codex token parent returned invalid credentials"))
			}
		}
		return true // Never pass credential-bearing replies to the general IPC logger.
	}

	const disconnect = (): void => {
		for (const operation of [...pending.values()]) {
			operation.reject(new Error("Codex token parent disconnected"))
		}
	}
	return { request, receive, disconnect }
}
