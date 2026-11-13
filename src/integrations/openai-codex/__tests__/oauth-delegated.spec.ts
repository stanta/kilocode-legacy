import type { ExtensionContext } from "vscode"
import { OpenAiCodexOAuthManager } from "../oauth"

describe("delegated child OAuth snapshots", () => {
	it("never copies or refreshes a token locally when parent delegation is available", async () => {
		const calls: Array<string | undefined> = []
		const secrets = {
			get: vi.fn(async () => { throw new Error("Child must not load refresh credentials") }),
			store: vi.fn(async () => { throw new Error("Child must not save refresh credentials") }),
			delete: vi.fn(async () => {}),
			getCodexTokenSnapshot: vi.fn(async (rejected?: string) => {
				calls.push(rejected)
				return { accessToken: rejected ? "synthetic_new" : "synthetic_access", accountId: "synthetic_account" }
			}),
		}
		const manager = new OpenAiCodexOAuthManager()
		manager.initialize({ secrets } as unknown as ExtensionContext)
		expect(await manager.getTokenSnapshot()).toEqual({
			accessToken: "synthetic_access", accountId: "synthetic_account",
		})
		expect(await manager.forceRefreshTokenSnapshot("synthetic_access")).toEqual({
			accessToken: "synthetic_new", accountId: "synthetic_account",
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
})
