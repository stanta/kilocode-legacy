import type { ExtensionContext } from "vscode"
import { OpenAiCodexOAuthManager } from "../oauth"

describe("delegated child OAuth snapshots", () => {
	it("never copies or refreshes a token locally when parent delegation is available", async () => {
		const calls: Array<string | undefined> = []
		const secrets = {
			get: vi.fn(async () => {
				throw new Error("Child must not load refresh credentials")
			}),
			store: vi.fn(async () => {
				throw new Error("Child must not save refresh credentials")
			}),
			delete: vi.fn(async () => {}),
			getCodexTokenSnapshot: vi.fn(async (rejected?: string) => {
				calls.push(rejected)
				return { accessToken: rejected ? "synthetic_new" : "synthetic_access", accountId: "synthetic_account" }
			}),
		}
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize({ secrets } as unknown as ExtensionContext)
		expect(await manager.getTokenSnapshot()).toEqual({
			accessToken: "synthetic_access",
			accountId: "synthetic_account",
		})
		expect(await manager.forceRefreshTokenSnapshot("synthetic_access")).toEqual({
			accessToken: "synthetic_new",
			accountId: "synthetic_account",
		})
		expect(calls).toEqual([undefined, "synthetic_access"])
		expect(secrets.get).not.toHaveBeenCalled()
		expect(secrets.store).not.toHaveBeenCalled()
		manager.dispose()
	})

	it("honors cancellation of one child without sending a token request", async () => {
		const controller = new AbortController()
		controller.abort()
		const secrets = {
			getCodexTokenSnapshot: vi.fn(async (_rejected?: string, signal?: AbortSignal) => {
				if (signal?.aborted) throw new Error("cancelled")
				return { accessToken: "synthetic" }
			}),
		}
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize({ secrets } as unknown as ExtensionContext)
		await expect(manager.getTokenSnapshot(controller.signal)).rejects.toThrow(/cancelled/)
		manager.dispose()
	})

	it("rejects an earlier login commit after another window has logged out", async () => {
		const { OPENAI_CODEX_CREDENTIALS_KEY } = await import("../oauth")
		const { getCodexCredentialEpoch } = await import("../oauth-refresh-lock")
		const { mkdtemp, rm } = await import("node:fs/promises")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const directory = await mkdtemp(path.join(tmpdir(), "codex-oauth-epoch-"))
		let secret: string | undefined
		const context = {
			globalStorageUri: { fsPath: directory, scheme: "file" },
			secrets: {
				get: async () => secret,
				store: async (_key: string, value: string) => {
					secret = value
				},
				delete: async () => {
					secret = undefined
				},
			},
		} as unknown as ExtensionContext
		const a = new OpenAiCodexOAuthManager()
		const b = new OpenAiCodexOAuthManager()
		a.initialize(context)
		b.initialize(context)
		try {
			const beforeLogout = getCodexCredentialEpoch(context)
			await b.clearCredentials()
			await expect(
				a.saveCredentials(
					{
						type: "openai-codex",
						access_token: "synthetic-access-old",
						refresh_token: "synthetic-refresh-old",
						expires: Date.now() + 3600_000,
					},
					beforeLogout,
				),
			).rejects.toThrow(/superseded/)
			expect(await context.secrets.get(OPENAI_CODEX_CREDENTIALS_KEY)).toBeUndefined()
		} finally {
			a.dispose()
			b.dispose()
			await rm(directory, { recursive: true, force: true })
		}
	})

	it("redacts token endpoint error body and rejects malformed expiration", async () => {
		const { exchangeCodeForTokens } = await import("../oauth")
		const secret = "PRIVATE_SECRET_IN_TOKEN_ENDPOINT"
		const mock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				Response.json({ error: "invalid_grant", error_description: secret }, { status: 400 }),
			)
			.mockResolvedValueOnce(
				Response.json({
					access_token: "token",
					refresh_token: "refresh",
					expires_in: 0,
				}),
			)
		try {
			await expect(exchangeCodeForTokens("code", "verifier")).rejects.toMatchObject({
				name: "OpenAiCodexOAuthTokenError",
				status: 400,
			})
			await expect(exchangeCodeForTokens("code", "verifier")).rejects.toThrow()
			expect(mock).toHaveBeenCalledTimes(2)
		} finally {
			mock.mockRestore()
		}
	})

	it("forces a 401 refresh when an in-flight normal refresh left the rejected token unchanged", async () => {
		const { mkdtemp, rm } = await import("node:fs/promises")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const directory = await mkdtemp(path.join(tmpdir(), "codex-oauth-forced-"))
		let stored: string | undefined
		const context = {
			globalStorageUri: { fsPath: directory, scheme: "file" },
			secrets: {
				get: async () => stored,
				store: async (_key: string, value: string) => {
					stored = value
				},
				delete: async () => {
					stored = undefined
				},
			},
		} as unknown as ExtensionContext
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize(context)
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const submitted: string[] = []
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
			const token = new URLSearchParams(String(options?.body)).get("refresh_token")!
			submitted.push(token)
			if (submitted.length === 1) {
				await gate
				return Response.json({ access_token: "rejected", refresh_token: "rotated", expires_in: 3600 })
			}
			return Response.json({ access_token: "accepted", refresh_token: "newest", expires_in: 3600 })
		})
		try {
			await manager.saveCredentials({
				type: "openai-codex",
				access_token: "rejected",
				refresh_token: "initial",
				expires: Date.now() - 1000,
			})
			const ordinary = manager.getTokenSnapshot()
			// Wait until the normal refresh has reached the endpoint.
			for (let i = 0; i < 100 && submitted.length === 0; i++) {
				await new Promise((resolve) => setTimeout(resolve, 10))
			}
			expect(submitted).toEqual(["initial"])
			const forced = manager.forceRefreshTokenSnapshot("rejected")
			release()
			expect((await ordinary)?.accessToken).toBe("rejected")
			expect((await forced)?.accessToken).toBe("accepted")
			expect(submitted).toEqual(["initial", "rotated"])
		} finally {
			release?.()
			fetchMock.mockRestore()
			manager.dispose()
			await rm(directory, { recursive: true, force: true })
		}
	})
})
