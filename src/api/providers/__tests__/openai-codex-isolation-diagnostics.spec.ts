// kilocode_change - new file
import type { ExtensionContext } from "vscode"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { OpenAiCodexHandler } from "../openai-codex"
import {
	OpenAiCodexOAuthManager,
	OPENAI_CODEX_CREDENTIALS_KEY,
	openAiCodexOAuthManager,
	type OpenAiCodexCredentials,
} from "../../../integrations/openai-codex/oauth"
import { NativeToolCallParser } from "../../../core/assistant-message/NativeToolCallParser"

// Diagnostic characterizations, not assertions that the observed failure modes are desirable.
// All network and secret-storage operations use synthetic data.
describe("Codex isolation diagnostics", () => {
	const lockDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lock-tests-"))
	afterAll(() => fs.rmSync(lockDirectory, { recursive: true, force: true }))
	beforeEach(() => {
		vi.spyOn(console, "info").mockImplementation(() => {})
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
		vi.spyOn(console, "debug").mockImplementation(() => {})
		NativeToolCallParser.clearRawChunkState()
		NativeToolCallParser.clearAllStreamingToolCalls()
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
		NativeToolCallParser.clearRawChunkState()
		NativeToolCallParser.clearAllStreamingToolCalls()
	})

	function credentials(generation: string, expires = Date.now() - 1): OpenAiCodexCredentials {
		return {
			type: "openai-codex",
			access_token: `synthetic-access-${generation}`,
			refresh_token: `synthetic-refresh-${generation}`,
			expires,
		}
	}

	function sharedStorage(initial: OpenAiCodexCredentials) {
		let stored: string | undefined = JSON.stringify(initial)
		return {
			get: async (_key: string) => stored,
			store: async (_key: string, value: string) => {
				stored = value
			},
			delete: async (_key: string) => {
				stored = undefined
			},
		}
	}

	function manager(secrets: ReturnType<typeof sharedStorage>) {
		const instance = new OpenAiCodexOAuthManager()
		instance.initialize({ secrets, globalStorageUri: { fsPath: lockDirectory, scheme: "file" } } as unknown as ExtensionContext, () => {})
		return instance
	}

	it("observes changes to shared credentials despite a stale local cache", async () => {
		const secrets = sharedStorage(credentials("old", Date.now() + 3_600_000))
		const a = manager(secrets)
		const b = manager(secrets)
		await a.loadCredentials()
		await b.loadCredentials()

		await a.saveCredentials(credentials("new", Date.now() + 3_600_000))

		expect(await b.getAccessToken()).toBe("synthetic-access-new")
		expect(JSON.parse((await secrets.get(OPENAI_CODEX_CREDENTIALS_KEY))!).access_token).toBe("synthetic-access-new")
	})

	it("serializes concurrent refreshes by independent managers", async () => {
		const secrets = sharedStorage(credentials("old"))
		const a = manager(secrets)
		const b = manager(secrets)
		await a.loadCredentials()
		await b.loadCredentials()
		const submitted: string[] = []
		const fetchMock = vi.fn(async (_url: unknown, options: RequestInit) => {
			submitted.push(new URLSearchParams(String(options.body)).get("refresh_token")!)
			return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
		})
		vi.stubGlobal("fetch", fetchMock)

		await Promise.all([a.getAccessToken(), b.getAccessToken()])

		expect(submitted).toEqual(["synthetic-refresh-old"])
		expect(await a.getAccessToken()).toBe("new-access")
		expect(await b.getAccessToken()).toBe("new-access")
	})

	it("does not delete credentials refreshed by another window after invalid_grant", async () => {
		const secrets = sharedStorage(credentials("old"))
		const a = manager(secrets)
		const b = manager(secrets)
		await a.loadCredentials()
		await b.loadCredentials()
		await a.saveCredentials(credentials("new", Date.now() + 3_600_000))
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })),
		)

		expect(await b.getAccessToken()).toBe("synthetic-access-new")
		expect(JSON.parse((await secrets.get(OPENAI_CODEX_CREDENTIALS_KEY))!).access_token).toBe("synthetic-access-new")
		// A failed refresh must never delete another window's credentials.
		expect(await a.getAccessToken()).toBe("synthetic-access-new")
	})

	it("reproduces one task's parser state being consumed by another task at index zero", () => {
		const a = NativeToolCallParser.processRawChunk({
			index: 0,
			id: "call_A",
			name: "read_file",
			arguments: '{"files":',
		})
		const b = NativeToolCallParser.processRawChunk({
			index: 0,
			id: "call_B",
			name: "execute_command",
			arguments: '{"command":"test"}',
		})

		expect(a[0]).toMatchObject({ type: "tool_call_start", id: "call_A" })
		expect(b).toEqual([{ type: "tool_call_delta", id: "call_A", delta: '{"command":"test"}' }])
		NativeToolCallParser.clearRawChunkState() // A new task resets the shared parser.
		expect(NativeToolCallParser.finalizeRawChunks()).toEqual([])
	})

	function provider() {
		vi.spyOn(openAiCodexOAuthManager, "getTokenSnapshot").mockResolvedValue({ accessToken: "synthetic-private-token" })
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue(null)
		return new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol" })
	}

	async function consume(handler: OpenAiCodexHandler, taskId: string) {
		const chunks = []
		for await (const chunk of handler.createMessage("PRIVATE PROMPT", [{ role: "user", content: "PRIVATE TEXT" }], {
			taskId,
		})) {
			chunks.push(chunk)
		}
		return chunks
	}

	it("does not replay a partial SDK response or log payloads", async () => {
		const handler = provider()
		;(handler as any).client = {
			responses: {
				create: vi.fn(async () => ({
					async *[Symbol.asyncIterator]() {
						yield { type: "response.reasoning.delta", delta: "First attempt" }
						throw new Error("simulated disconnection PRIVATE ERROR BODY")
					},
				})),
			},
		}
		const events = [
			{ type: "response.reasoning.delta", delta: "Replayed attempt" },
			{ type: "response.completed", response: { id: "resp_replay", output: [] } },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join("")
		const fetchMock = vi.fn(async () => new Response(events))
		vi.stubGlobal("fetch", fetchMock)

		const chunks = []
		await expect(async () => {
			for await (const chunk of handler.createMessage("PRIVATE PROMPT", [{ role: "user", content: "PRIVATE TEXT" }], {
				taskId: "task-replay",
			})) {
				chunks.push(chunk)
			}
		}).rejects.toMatchObject({
			codexRequest: true, code: "interrupted", safeToRetry: false,
		})
		expect(chunks).toEqual([{ type: "reasoning", text: "First attempt" }])
		expect(fetchMock).not.toHaveBeenCalled()
		const infoCalls = vi.mocked(console.info).mock.calls
		expect(infoCalls.some((call) => (call[1] as any)?.phase === "fallback.start")).toBe(false)
		expect(JSON.stringify(infoCalls)).not.toMatch(/PRIVATE|synthetic-private-token/)
	})

	it("reports a stalled SDK open and clears its heartbeat after the request closes", async () => {
		vi.useFakeTimers()
		const handler = provider()
		let release!: (stream: AsyncIterable<unknown>) => void
		let markOpened!: () => void
		const opened = new Promise<void>((resolve) => {
			markOpened = resolve
		})
		;(handler as any).client = {
			responses: {
				create: vi.fn(() => {
					markOpened()
					return new Promise<AsyncIterable<unknown>>((resolve) => {
						release = resolve
					})
				}),
			},
		}
		const running = consume(handler, "task-stalled")
		await opened
		await vi.advanceTimersByTimeAsync(30_000)

		expect(
			vi
				.mocked(console.debug)
				.mock.calls.some(
					(call) => (call[1] as any)?.phase === "sdk.open.start" && (call[1] as any)?.waiting === true,
				),
		).toBe(true)
		release({
			async *[Symbol.asyncIterator]() {
				yield { type: "response.completed", response: { id: "resp_stalled", output: [] } }
			},
		})
		await running
		const callsAtClose = vi.mocked(console.info).mock.calls.length
		await vi.advanceTimersByTimeAsync(60_000)
		expect(vi.mocked(console.info).mock.calls).toHaveLength(callsAtClose)
	})

	it("closes the diagnostic lifecycle after an authentication failure without leaking error content", async () => {
		vi.useFakeTimers()
		const handler = provider()
		vi.mocked(openAiCodexOAuthManager.getTokenSnapshot).mockRejectedValue(new Error("PRIVATE AUTH ERROR"))

		await expect(consume(handler, "task-auth-failed")).rejects.toMatchObject({
			codexRequest: true, code: "auth", safeToRetry: false,
		})

		const records = vi.mocked(console.info).mock.calls.map((call) => call[1] as Record<string, unknown>)
		expect(records.map((record) => record.phase)).toEqual([
			"request.start",
			"auth.start",
			"request.error",
			"request.closed",
		])
		expect(records.at(-1)?.activeHandlerRequests).toBe(0)
		expect(JSON.stringify(records)).not.toContain("PRIVATE")
		await vi.advanceTimersByTimeAsync(60_000)
		expect(vi.mocked(console.info).mock.calls).toHaveLength(4)
	})

	it("keeps separate handlers' sessions and response metadata isolated during interleaved requests", async () => {
		const a = provider()
		const b = new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol" })
		const sdk = (id: string) =>
			vi.fn(async () => ({
				async *[Symbol.asyncIterator]() {
					await Promise.resolve()
					yield { type: "response.completed", response: { id, output: [] } }
				},
			}))
		const createA = sdk("resp_A")
		const createB = sdk("resp_B")
		;(a as any).client = { responses: { create: createA } }
		;(b as any).client = { responses: { create: createB } }

		await Promise.all([consume(a, "task_A"), consume(b, "task_B")])

		expect(a.getResponseId()).toBe("resp_A")
		expect(b.getResponseId()).toBe("resp_B")
		expect((createA.mock.calls as any)[0][1].headers.session_id).toBe("task_A")
		expect((createB.mock.calls as any)[0][1].headers.session_id).toBe("task_B")
		const starts = vi.mocked(console.info).mock.calls.filter((call) => (call[1] as any)?.phase === "request.start")
		expect(starts).toHaveLength(2)
		expect((starts[0][1] as any).requestId).not.toBe((starts[1][1] as any).requestId)
		expect((starts[0][1] as any).handlerId).not.toBe((starts[1][1] as any).handlerId)
	})

	it("rejects a second concurrent request on the same handler without corrupting the first", async () => {
		const handler = provider()
		let release!: () => void
		const gate = new Promise<void>((resolve) => { release = resolve })
		;(handler as any).client = { responses: { create: vi.fn(async () => ({
			async *[Symbol.asyncIterator]() {
				await gate
				yield { type: "response.completed", response: { id: "response_first", output: [] } }
			},
		})) } }
		const first = consume(handler, "first")
		await Promise.resolve()
		await Promise.resolve()
		await expect(consume(handler, "second")).rejects.toThrow(/already processing/)
		release()
		await first
		expect(handler.getResponseId()).toBe("response_first")
	})

	it("does not accept EOF or incomplete terminal state as a successful response", async () => {
		const handler = provider()
		const create = vi.fn()
			.mockResolvedValueOnce({ async *[Symbol.asyncIterator]() {
				yield { type: "response.reasoning.delta", delta: "partial" }
			} })
			.mockResolvedValueOnce({ async *[Symbol.asyncIterator]() {
				yield { type: "response.completed", response: { status: "incomplete" } }
			} })
		;(handler as any).client = { responses: { create } }
		await expect(consume(handler, "eof")).rejects.toThrow(/closed without a completed response/)
		await expect(consume(handler, "incomplete")).rejects.toThrow(/failed or incomplete/)
		expect(handler.getResponseId()).toBeUndefined()
	})

	it("aborts a pending SDK request at the shared deadline, without retry", async () => {
		const handler = provider()
		vi.useFakeTimers()
		const controller = new AbortController()
		const create = vi.fn((_body: unknown, options: { signal: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
			}))
		;(handler as any).client = { responses: { create } }
		const running = (async () => {
			for await (const _chunk of handler.createMessage("system", [], undefined, {
				signal: controller.signal, deadlineAt: Date.now() + 250,
			})) { /* no content expected */ }
		})()
		await vi.advanceTimersByTimeAsync(300)
		await expect(running).rejects.toThrow(/deadline exceeded/)
		expect(create).toHaveBeenCalledTimes(1)
	})

	it("refuses to dispatch when the task was already cancelled", async () => {
		const handler = provider()
		const controller = new AbortController()
		controller.abort()
		const create = vi.fn()
		;(handler as any).client = { responses: { create } }
		await expect(async () => {
			for await (const _chunk of handler.createMessage("system", [], undefined, { signal: controller.signal })) {}
		}).rejects.toThrow(/cancelled/)
		expect(create).not.toHaveBeenCalled()
	})

	it("recognizes a complete SSE terminal event without trailing newline", async () => {
		const handler = provider()
		;(handler as any).useManualSse = true
		const payload = 'data: ' + JSON.stringify({
			type: "response.completed", response: { id: "sse_final", output: [], status: "completed" },
		})
		vi.stubGlobal("fetch", vi.fn(async () => new Response(payload, {
			headers: { "Content-Type": "text/event-stream" },
		})))
		await consume(handler, "sse")
		expect(handler.getResponseId()).toBe("sse_final")
	})

	it("does not convert a structured 403 response into an OAuth refresh", async () => {
		const handler = provider()
		const refresh = vi.spyOn(openAiCodexOAuthManager, "forceRefreshTokenSnapshot")
		const create = vi.fn().mockRejectedValue({ status: 403 })
		;(handler as any).client = { responses: { create } }
		await expect(consume(handler, "forbidden")).rejects.toMatchObject({
			codexRequest: true, status: 403, safeToRetry: false,
		})
		expect(create).toHaveBeenCalledTimes(1)
		expect(refresh).not.toHaveBeenCalled()
	})


	it("rejects a completed event containing a nested server error", async () => {
		const handler = provider()
		;(handler as any).client = { responses: { create: vi.fn(async () => ({
			async *[Symbol.asyncIterator]() {
				yield { type: "response.completed", response: {
					status: "completed", error: { code: "internal" }, output: [],
				} }
			},
		})) } }
		await expect(consume(handler, "nested-error")).rejects.toMatchObject({
			codexRequest: true, code: "interrupted",
		})
		expect(handler.getResponseId()).toBeUndefined()
	})

	it("prevents a 401 retry from silently changing the authenticated account", async () => {
		const handler = provider()
		vi.mocked(openAiCodexOAuthManager.getTokenSnapshot).mockResolvedValue({
			accessToken: "old", accountId: "account-A",
		})
		vi.spyOn(openAiCodexOAuthManager, "forceRefreshTokenSnapshot").mockResolvedValue({
			accessToken: "new", accountId: "account-B",
		})
		const create = vi.fn().mockRejectedValue({ status: 401 })
		;(handler as any).client = { responses: { create } }
		await expect(consume(handler, "account-changed")).rejects.toThrow(/account changed/)
		expect(create).toHaveBeenCalledTimes(1)
	})

	it("stops processing events after terminal success", async () => {
		const handler = provider()
		let finallyCalled = false
		;(handler as any).client = { responses: { create: vi.fn(async () => ({
			async *[Symbol.asyncIterator]() {
				try {
					yield { type: "response.completed", response: { id: "final", status: "completed", output: [] } }
					yield { type: "response.reasoning.delta", delta: "LATE" }
				} finally { finallyCalled = true }
			},
		})) } }
		expect(await consume(handler, "after-terminal")).toEqual([])
		expect(finallyCalled).toBe(true)
		expect(handler.getResponseId()).toBe("final")
	})

})
