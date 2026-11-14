import type { ExtensionContext } from "vscode"

import { codexStorageProbe } from "../storage-probe"

describe("Codex real SecretStorage probe contract (synthetic marker only)", () => {
	it("matches marker and local domain across two windows sharing a SecretStorage domain", async () => {
		const shared = new Map<string, string>()
		const secrets = {
			store: vi.fn(async (key: string, value: string) => {
				shared.set(key, value)
			}),
			get: vi.fn(async (key: string) => shared.get(key)),
			delete: vi.fn(async (key: string) => {
				shared.delete(key)
			}),
		}
		const context = {
			globalStorageUri: { scheme: "file", fsPath: "/synthetic/profile/extensions/kilocode" },
			secrets,
		} as unknown as ExtensionContext
		const windowA = await codexStorageProbe(context, "write")
		const windowB = await codexStorageProbe(context, "read")
		expect(windowA.marker).toBeTruthy()
		expect(windowA).toEqual(windowB)
		expect(secrets.store).toHaveBeenCalledTimes(1)
		expect(secrets.store.mock.calls[0][0]).toContain("probe-synthetic")
		expect(JSON.stringify([...shared.entries()])).not.toMatch(/refresh_token|access_token|accountId/)
		await codexStorageProbe(context, "clear")
		expect((await codexStorageProbe(context, "read")).marker).toBeUndefined()
	})

	it("flags different lock domains even if the SecretStorage service is shared", async () => {
		const values = new Map<string, string>()
		const secrets = {
			store: async (key: string, value: string) => {
				values.set(key, value)
			},
			get: async (key: string) => values.get(key),
			delete: async (key: string) => {
				values.delete(key)
			},
		}
		const a = {
			globalStorageUri: { scheme: "file", fsPath: "/synthetic/profile-A/kilocode" },
			secrets,
		} as unknown as ExtensionContext
		const b = {
			globalStorageUri: { scheme: "file", fsPath: "/synthetic/profile-B/kilocode" },
			secrets,
		} as unknown as ExtensionContext
		const first = await codexStorageProbe(a, "write")
		const second = await codexStorageProbe(b, "read")
		expect(first.marker).toBe(second.marker)
		expect(first.domain).not.toBe(second.domain)
	})
})
