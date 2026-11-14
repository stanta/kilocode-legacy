import { createCodexTokenClient } from "../codex-token-client.js"

describe("Codex child token IPC client", () => {
	it("rejects only the cancelled waiter and keeps another pending request alive", async () => {
		const sent: Array<{ type: string; requestId: string }> = []
		const client = createCodexTokenClient((message) => sent.push(message), 1000)
		const controller = new AbortController()
		const a = client.request(undefined, controller.signal)
		const b = client.request()
		controller.abort()
		await expect(a).rejects.toThrow(/cancelled/)
		expect(client.receive({
			type: "codexTokenResponse", requestId: sent[1].requestId,
			snapshot: { accessToken: "synthetic_access", accountId: "synthetic_account" },
		})).toBe(true)
		await expect(b).resolves.toEqual({ accessToken: "synthetic_access", accountId: "synthetic_account" })
		// A's late response is ignored, not delivered to B.
		expect(client.receive({
			type: "codexTokenResponse", requestId: sent[0].requestId,
			snapshot: { accessToken: "stale" },
		})).toBe(true)
	})

	it("rejects pending requests on parent disconnect without hanging", async () => {
		const client = createCodexTokenClient(() => {}, 1000)
		const promise = client.request()
		client.disconnect()
		await expect(promise).rejects.toThrow(/disconnected/)
	})

	it("propagates safe error categories/status and never the token endpoint body", async () => {
		let requestId = ""
		const client = createCodexTokenClient((message) => { requestId = message.requestId })
		const pending = client.request()
		client.receive({
			type: "codexTokenResponse", requestId, error: { code: "oauth_unavailable", status: 403 },
		})
		await expect(pending).rejects.toMatchObject({ code: "oauth_unavailable", status: 403 })
	})
})
