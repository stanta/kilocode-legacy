import { promises as fs } from "node:fs"
import * as path from "node:path"
import { withCodexOAuthLock } from "../oauth-refresh-lock"

// Synthetic cross-process SecretStorage stand-in. No production credentials.
const directory = process.env.CODEX_LOCK_TEST_DIR!
const file = path.join(directory, "synthetic-state.json")
const context = { globalStorageUri: { fsPath: directory, scheme: "file" } } as any

process.on("message", async (message) => {
	if (message !== "start") return
	try {
		const current = await withCodexOAuthLock(context, async (signal) => {
			const state: { version: number; refreshes: number } = JSON.parse(await fs.readFile(file, "utf8"))
			if (state.version === 0) {
				// Force the other process to contend for the lock.
				await new Promise((resolve) => setTimeout(resolve, 150))
				if (signal.aborted) throw new Error("lock lost")
				state.version = 1
				state.refreshes++
				await fs.writeFile(file, JSON.stringify(state))
			}
			return state
		})
		process.send?.({ type: "done", state: current })
	} catch (error) {
		process.send?.({ type: "failed", code: (error as any)?.code || "lock_error" })
	} finally {
		process.exit(0)
	}
})
process.send?.({ type: "ready" })
