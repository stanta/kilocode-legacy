import { describe, it, expect } from "vitest"
import { fork, type ChildProcess } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import * as path from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const worker = fileURLToPath(new URL("./codex-token-client.worker.ts", import.meta.url))

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout>
	return Promise.race([
		promise, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("IPC test timed out")), ms)
		}),
	]).finally(() => clearTimeout(timer))
}

describe("Codex token IPC with real child processes", () => {
	it("isolates two children, cancellation, rejected-token refresh and IPC logs", async () => {
		const children: ChildProcess[] = []
		const output: string[] = []
		const spawn = () => new Promise<{
			process: ChildProcess
			request: Promise<{ requestId: string; rejectedAccessToken?: string }>
			result: Promise<any>
		}>((resolve, reject) => {
			const child = fork(worker, [], {
				execArgv: ["--import", "tsx"],
				stdio: ["ignore", "pipe", "pipe", "ipc"],
			})
			children.push(child)
			child.stdout?.on("data", (chunk) => output.push(String(chunk)))
			child.stderr?.on("data", (chunk) => output.push(String(chunk)))
			let requestResolve!: (request: { requestId: string; rejectedAccessToken?: string }) => void
			let resultResolve!: (result: any) => void
			const request = new Promise<{ requestId: string; rejectedAccessToken?: string }>((done) => {
				requestResolve = done
			})
			const result = new Promise<any>((done) => { resultResolve = done })
			child.on("message", (message: any) => {
				if (message?.type === "ready") resolve({ process: child, request, result })
				else if (message?.type === "codexTokenRequest") requestResolve(message)
				else if (message?.type === "result") resultResolve(message)
			})
			child.on("error", reject)
			child.on("exit", (code) => {
				if (code && code !== 0) reject(new Error("Worker exited " + code))
			})
		})
		try {
			const [a, b] = await withTimeout(Promise.all([spawn(), spawn()]), 12_000)
			a.process.send({ type: "start" })
			b.process.send({ type: "start", rejectedAccessToken: "synthetic-access-old" })
			const [requestA, requestB] = await withTimeout(Promise.all([a.request, b.request]), 8_000)
			expect(requestB.rejectedAccessToken).toBe("synthetic-access-old")
			a.process.send({ type: "cancel" })
			expect((await withTimeout(a.result, 8_000)).error).toMatch(/cancelled/)
			b.process.send({
				type: "codexTokenResponse", requestId: requestB.requestId,
				snapshot: { accessToken: "synthetic-access-new", accountId: "synthetic-account" },
			})
			expect(await withTimeout(b.result, 8_000)).toEqual({
				type: "result", ok: true, accountId: "synthetic-account",
			})
			// A late reply must not reach the cancelled task.
			a.process.send({
				type: "codexTokenResponse", requestId: requestA.requestId,
				snapshot: { accessToken: "synthetic-access-stale" },
			})
			expect(output.join("")).not.toMatch(/synthetic-access-|synthetic-account|refresh_token/)
		} finally {
			for (const child of children) {
				child.kill()
			}
		}
	}, 20_000)

	it("detects an actual parent IPC disconnect while waiting for a token", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "codex-child-disconnect-"))
		const filename = path.join(directory, "disconnect-result")
		const child = fork(worker, [], {
			execArgv: ["--import", "tsx"],
			env: { ...process.env, CODEX_WORKER_DISCONNECT_FILE: filename },
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		})
		try {
			await withTimeout(new Promise<void>((resolve) => child.on("message", (message: any) => {
				if (message?.type === "ready") resolve()
			})), 8_000)
			const started = withTimeout(new Promise<void>((resolve) => child.on("message", (message: any) => {
				if (message?.type === "codexTokenRequest") resolve()
			})), 8_000)
			child.send({ type: "start" })
			await started
			child.disconnect()
			let reason = ""
			for (let i = 0; i < 60; i++) {
				try {
					reason = await readFile(filename, "utf8")
					break
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 50))
				}
			}
			expect(reason).toMatch(/disconnected/)
		} finally {
			if (child.exitCode === null) child.kill()
			await rm(directory, { recursive: true, force: true })
		}
	}, 15_000)
})
