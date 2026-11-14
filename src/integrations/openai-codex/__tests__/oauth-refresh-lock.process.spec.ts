import { fork, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

// Two real OS processes, the real OAuth lock helper, one synthetic credential source.
// No production OAuth endpoint is contacted.
describe("Codex OAuth lock across independent processes", () => {
	it("allows at most one refresh and makes the second process observe the new credentials", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "codex-oauth-process-"))
		const worker = fileURLToPath(new URL("./oauth-refresh-lock.worker.ts", import.meta.url))
		const children: ChildProcess[] = []
		try {
			await writeFile(
				path.join(directory, "synthetic-state.json"),
				JSON.stringify({
					version: 0,
					refreshes: 0,
				}),
			)
			const start = () =>
				new Promise<{ version: number; refreshes: number }>((resolve, reject) => {
					const child = fork(worker, [], {
						execArgv: ["--import", "tsx"],
						env: { ...process.env, CODEX_LOCK_TEST_DIR: directory },
						stdio: ["ignore", "ignore", "ignore", "ipc"],
					})
					children.push(child)
					const timer = setTimeout(() => reject(new Error("child lock test timed out")), 15_000)
					child.on("message", (msg: any) => {
						if (msg?.type === "ready") child.send("start")
						if (msg?.type === "done") {
							clearTimeout(timer)
							resolve(msg.state)
						}
						if (msg?.type === "failed") {
							clearTimeout(timer)
							reject(new Error("child lock failed: " + msg.code))
						}
					})
					child.on("error", (error) => {
						clearTimeout(timer)
						reject(error)
					})
					child.on("exit", (code) => {
						if (code && code !== 0) {
							clearTimeout(timer)
							reject(new Error("worker exit " + code))
						}
					})
				})
			const [a, b] = await Promise.all([start(), start()])
			const finalState = JSON.parse(await readFile(path.join(directory, "synthetic-state.json"), "utf8"))
			expect(a.version).toBe(1)
			expect(b.version).toBe(1)
			expect(finalState).toEqual({ version: 1, refreshes: 1 })
			const names = await readdir(directory)
			// The lock directory is metadata only; it must not contain token JSON.
			expect(names.some((name) => name.endsWith(".lock") && name.includes("synthetic"))).toBe(false)
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill()
			await rm(directory, { recursive: true, force: true })
		}
	})
})
