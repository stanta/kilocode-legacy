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

	it("quarantines a delayed SecretStorage write when its lock is lost", async () => {
		const { existsSync } = await import("node:fs")
		const { mkdtemp, rm } = await import("node:fs/promises")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const { withCodexOAuthLock } = await import("../oauth-refresh-lock")
		const directory = await mkdtemp(path.join(tmpdir(), "codex-oauth-fence-"))
		let stored: string | undefined
		let releaseWrite!: () => void
		let enteredWrite!: () => void
		const entered = new Promise<void>((resolve) => {
			enteredWrite = resolve
		})
		const blocked = new Promise<void>((resolve) => {
			releaseWrite = resolve
		})
		const context = {
			globalStorageUri: { fsPath: directory, scheme: "file" },
			secrets: {
				get: async () => stored,
				store: async (_key: string, value: string) => {
					enteredWrite()
					await blocked
					stored = value
				},
				delete: async () => {
					stored = undefined
				},
			},
		} as unknown as ExtensionContext
		const writer = new OpenAiCodexOAuthManager()
		writer.initialize(context)
		let first: Promise<void> | undefined
		try {
			first = writer.saveCredentials({
				type: "openai-codex",
				access_token: "synthetic-old",
				refresh_token: "synthetic-old-refresh",
				expires: Date.now() + 3600_000,
			})
			await entered
			// The marker is non-secret and exists *before* the unabortable async storage write.
			const pendingPath = path.join(directory, ".openai-codex-secret-write-pending")
			expect(existsSync(pendingPath)).toBe(true)

			// Simulate a stale lock being removed by another process while the write is blocked.
			await rm(path.join(directory, ".openai-codex-oauth.lock"), { recursive: true, force: true })
			const competing = withCodexOAuthLock(context, async () => {
				throw new Error("A competing writer must never enter while the first write is pending")
			})
			await expect(competing).rejects.toThrow(/pending|uncertain|recovery/i)
		} finally {
			releaseWrite?.()
			await first?.catch(() => {})
			writer.dispose()
			await rm(directory, { recursive: true, force: true })
		}
	})

	it("keeps the non-secret quarantine marker when lock ownership is lost mid-write", async () => {
		const { existsSync } = await import("node:fs")
		const { mkdtemp, rm } = await import("node:fs/promises")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const { writeCodexSecretUnderLock, withCodexOAuthLock } = await import("../oauth-refresh-lock")
		const directory = await mkdtemp(path.join(tmpdir(), "codex-lock-compromised-"))
		const context = { globalStorageUri: { fsPath: directory, scheme: "file" } } as unknown as ExtensionContext
		const owner = new AbortController()
		let entered!: () => void
		let complete!: () => void
		const started = new Promise<void>((resolve) => {
			entered = resolve
		})
		const gate = new Promise<void>((resolve) => {
			complete = resolve
		})
		try {
			const commit = writeCodexSecretUnderLock(context, owner.signal, async () => {
				entered()
				await gate // Simulate an unabortable VS Code SecretStorage write.
			})
			await started
			owner.abort(new Error("lock was stolen"))
			complete()
			await expect(commit).rejects.toThrow(/lock lost/)
			expect(existsSync(path.join(directory, ".openai-codex-secret-write-pending"))).toBe(true)
			await expect(withCodexOAuthLock(context, async () => {})).rejects.toThrow(/pending|uncertain/i)
		} finally {
			complete?.()
			await rm(directory, { recursive: true, force: true })
		}
	})

	it("blocks a subsequent credential read after an interrupted storage commit", async () => {
		const { existsSync } = await import("node:fs")
		const { mkdtemp, rm } = await import("node:fs/promises")
		const { tmpdir } = await import("node:os")
		const path = await import("node:path")
		const directory = await mkdtemp(path.join(tmpdir(), "codex-oauth-uncertain-"))
		let stored: string | undefined
		const context = {
			globalStorageUri: { fsPath: directory, scheme: "file" },
			secrets: {
				get: async () => stored,
				store: async (_key: string, value: string) => {
					stored = value
					throw new Error("Commit acknowledgement lost")
				},
				delete: async () => {
					stored = undefined
				},
			},
		} as unknown as ExtensionContext
		const writer = new OpenAiCodexOAuthManager()
		writer.initialize(context)
		try {
			await expect(
				writer.saveCredentials({
					type: "openai-codex",
					access_token: "synthetic-uncertain",
					refresh_token: "synthetic-uncertain-refresh",
					expires: Date.now() + 3600_000,
				}),
			).rejects.toThrow(/acknowledgement lost/)
			expect(existsSync(path.join(directory, ".openai-codex-secret-write-pending"))).toBe(true)
			await expect(writer.getTokenSnapshot()).rejects.toThrow(/uncertain|recovery|pending/i)
		} finally {
			writer.dispose()
			await rm(directory, { recursive: true, force: true })
		}
	})
})
