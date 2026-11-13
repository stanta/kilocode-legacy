// kilocode_change - new file
import type { ExtensionContext } from "vscode"

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
	beforeEach(() => {
		vi.spyOn(console, "info").mockImplementation(() => {})
		vi.spyOn(console, "log").mockImplementation(() => {})
		vi.spyOn(console, "error").mockImplementation(() => {})
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
		instance.initialize({ secrets } as unknown as ExtensionContext, () => {})
		return instance
	}

	it("reproduces a stale credential cache after another window updates shared storage", async () => {
		const secrets = sharedStorage(credentials("old", Date.now() + 3_600_000))
		const a = manager(secrets)
		const b = manager(secrets)
		await a.loadCredentials()
		await b.loadCredentials()

		await a.saveCredentials(credentials("new", Date.now() + 3_600_000))

		expect(await b.getAccessToken()).toBe("synthetic-access-old")
		expect(JSON.parse((await secrets.get(OPENAI_CODEX_CREDENTIALS_KEY))!).access_token).toBe("synthetic-access-new")
	})

	it("reproduces two independent windows refreshing the same expired token concurrently", async () => {
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

		expect(submitted).toEqual(["synthetic-refresh-old", "synthetic-refresh-old"])
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

		expect(await b.getAccessToken()).toBeNull()
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
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("synthetic-private-token")
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
		}).rejects.toThrow("simulated disconnection")
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
				.mocked(console.info)
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
		vi.mocked(openAiCodexOAuthManager.getAccessToken).mockRejectedValue(new Error("PRIVATE AUTH ERROR"))

		await expect(consume(handler, "task-auth-failed")).rejects.toThrow("PRIVATE AUTH ERROR")

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
})
