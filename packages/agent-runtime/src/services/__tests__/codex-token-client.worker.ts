import { createCodexTokenClient } from "../codex-token-client.js"
import { writeFile } from "node:fs/promises"

const client = createCodexTokenClient((message) => process.send?.(message), 10_000)
let controller: AbortController | undefined

process.on("message", (message: any) => {
	if (client.receive(message)) return
	if (message?.type === "start") {
		controller = new AbortController()
		void client.request(message.rejectedAccessToken, controller.signal).then(
			(snapshot) => {
				if (process.connected) process.send?.({
					type: "result", ok: snapshot?.accessToken?.startsWith("synthetic-access-") ?? false,
					accountId: snapshot?.accountId,
				})
			},
			async (error) => {
				if (process.connected) process.send?.({ type: "result", error: error.message })
				else if (process.env.CODEX_WORKER_DISCONNECT_FILE) {
					await writeFile(process.env.CODEX_WORKER_DISCONNECT_FILE, error.message)
				}
			},
		)
	} else if (message?.type === "cancel") {
		controller?.abort()
	}
})
process.on("disconnect", client.disconnect)
process.send?.({ type: "ready" })
