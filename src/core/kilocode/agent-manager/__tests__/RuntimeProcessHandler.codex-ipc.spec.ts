import { openAiCodexOAuthManager } from "../../../../integrations/openai-codex/oauth"
import { RuntimeProcessHandler } from "../RuntimeProcessHandler"

describe("Agent Manager Codex token IPC", () => {
	afterEach(() => vi.restoreAllMocks())

	function setup() {
		// The IPC handler is exercised directly; no extension or real credentials.
		const handler = Object.create(RuntimeProcessHandler.prototype) as any
		handler.codexChildren = new WeakSet<object>()
		const createChild = () => ({
			connected: true,
			send: vi.fn((_message: unknown, callback?: (error?: Error) => void) => callback?.()),
		})
		return { handler, createChild }
	}

	it("provides two child processes with one parent-owned snapshot, never a refresh token", async () => {
		const { handler, createChild } = setup()
		const a = createChild(), b = createChild()
		handler.codexChildren.add(a)
		handler.codexChildren.add(b)
		vi.spyOn(openAiCodexOAuthManager, "getTokenSnapshot").mockResolvedValue({
			accessToken: "synthetic_access", accountId: "synthetic_account",
		})
		await Promise.all([
			handler.replyToCodexTokenRequest(a, { type: "codexTokenRequest", requestId: "a" }),
			handler.replyToCodexTokenRequest(b, { type: "codexTokenRequest", requestId: "b" }),
		])
		for (const child of [a, b]) {
			const response = child.send.mock.calls[0][0] as any
			expect(response.type).toBe("codexTokenResponse")
			expect(response.snapshot).toEqual({ accessToken: "synthetic_access", accountId: "synthetic_account" })
			expect(JSON.stringify(response)).not.toContain("refresh_token")
		}
	})

	it("does not serve an unregistered child or emit a credential-bearing event", async () => {
		const { handler, createChild } = setup()
		const rogue = createChild()
		const token = vi.spyOn(openAiCodexOAuthManager, "getTokenSnapshot")
		await handler.replyToCodexTokenRequest(rogue, { type: "codexTokenRequest", requestId: "rogue" })
		expect(rogue.send.mock.calls[0][0]).toMatchObject({ error: { code: "not_authorized" } })
		expect(token).not.toHaveBeenCalled()
	})

	it("uses the rejected token version to coordinate exactly one forced refresh", async () => {
		const { handler, createChild } = setup()
		const child = createChild()
		handler.codexChildren.add(child)
		const refresh = vi.spyOn(openAiCodexOAuthManager, "forceRefreshTokenSnapshot")
			.mockResolvedValue({ accessToken: "rotated_access" })
		await handler.replyToCodexTokenRequest(child, {
			type: "codexTokenRequest", requestId: "401", rejectedAccessToken: "rejected_access",
		})
		expect(refresh).toHaveBeenCalledWith("rejected_access")
		expect(child.send.mock.calls[0][0]).toMatchObject({
			snapshot: { accessToken: "rotated_access" },
		})
	})

	it("sends a bounded category and status, never a raw OAuth failure body", async () => {
		const { handler, createChild } = setup()
		const child = createChild()
		handler.codexChildren.add(child)
		const error = Object.assign(new Error("PRIVATE TOKEN ENDPOINT BODY"), { status: 403 })
		vi.spyOn(openAiCodexOAuthManager, "getTokenSnapshot").mockRejectedValue(error)
		await handler.replyToCodexTokenRequest(child, { type: "codexTokenRequest", requestId: "denied" })
		const message = child.send.mock.calls[0][0]
		expect(message).toMatchObject({ error: { code: "oauth_unavailable", status: 403 } })
		expect(JSON.stringify(message)).not.toContain("PRIVATE")
	})
})
