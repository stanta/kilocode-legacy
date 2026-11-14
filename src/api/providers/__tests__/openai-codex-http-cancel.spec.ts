import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { OpenAiCodexHandler } from "../openai-codex"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"

function bounded<T>(task: Promise<T>, timeoutMs = 8_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout>
	return Promise.race([
		task,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("Local HTTP fixture timed out")), timeoutMs)
		}),
	]).finally(() => clearTimeout(timer))
}

describe("Codex real HTTP cancellation and SSE lifecycle", () => {
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
	})

	it("abort of task A closes its socket while task B completes without replay", async () => {
		const responses = new Map<string, ServerResponse>()
		const disconnected = new Map<string, () => void>()
		let requests = 0
		const server = createServer((request, response) => {
			requests++
			const id = String(request.headers.session_id || "")
			responses.set(id, response)
			response.writeHead(200, { "Content-Type": "text/event-stream" })
			response.write("data: " + JSON.stringify({ type: "response.reasoning.delta", delta: id }) + "\n\n")
			response.on("close", () => disconnected.get(id)?.())
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const port = (server.address() as AddressInfo).port
		const rawFetch = globalThis.fetch.bind(globalThis)
		vi.stubGlobal("fetch", vi.fn((_url: unknown, options?: RequestInit) => 
			rawFetch("http://127.0.0.1:" + port + "/responses", options)))
		vi.spyOn(openAiCodexOAuthManager, "getTokenSnapshot")
			.mockResolvedValue({ accessToken: "synthetic", accountId: "synthetic_account" })
		const make = () => {
			const handler = new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol" })
			;(handler as any).useManualSse = true
			return handler
		}
		const handlerA = make(), handlerB = make()
		const stopA = new AbortController(), stopB = new AbortController()
		try {
			const iteratorA = handlerA.createMessage("system", [], { taskId: "A" }, {
				signal: stopA.signal,
			})[Symbol.asyncIterator]()
			const iteratorB = handlerB.createMessage("system", [], { taskId: "B" }, {
				signal: stopB.signal,
			})[Symbol.asyncIterator]()
			const first = await bounded(Promise.all([iteratorA.next(), iteratorB.next()]))
			expect(first.map((chunk) => chunk.value)).toEqual([
				{ type: "reasoning", text: "A" }, { type: "reasoning", text: "B" },
			])
			const closedA = new Promise<void>((resolve) => disconnected.set("A", resolve))
			const pendingA = iteratorA.next()
			stopA.abort()
			await expect(bounded(pendingA)).rejects.toThrow(/cancelled/)
			await bounded(closedA)
			expect(responses.get("B")?.destroyed).toBe(false)
			responses.get("B")?.end("data: " + JSON.stringify({
				type: "response.completed", response: { id: "B_done", output: [], status: "completed" },
			}) + "\n\n")
			expect(await bounded(iteratorB.next())).toMatchObject({ done: true })
			expect(handlerA.getResponseId()).toBeUndefined()
			expect(handlerB.getResponseId()).toBe("B_done")
			expect(requests).toBe(2)
		} finally {
			stopA.abort()
			stopB.abort()
			for (const response of responses.values()) response.destroy()
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	}, 15_000)

	it("deadline terminates a stalled body after HTTP 200 and closes the socket", async () => {
		let finished!: () => void
		const closed = new Promise<void>((resolve) => { finished = resolve })
		const server = createServer((_req, response) => {
			response.writeHead(200, { "Content-Type": "text/event-stream" })
			response.write("data: " + JSON.stringify({ type: "response.reasoning.delta", delta: "partial" }) + "\n\n")
			response.on("close", finished)
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const port = (server.address() as AddressInfo).port
		const rawFetch = globalThis.fetch.bind(globalThis)
		vi.stubGlobal("fetch", vi.fn((_url: unknown, options?: RequestInit) =>
			rawFetch("http://127.0.0.1:" + port + "/responses", options)))
		vi.spyOn(openAiCodexOAuthManager, "getTokenSnapshot")
			.mockResolvedValue({ accessToken: "synthetic" })
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol" })
		;(handler as any).useManualSse = true
		try {
			const iterator = handler.createMessage("system", [], { taskId: "timeout" }, {
				deadlineAt: Date.now() + 1_000,
			})[Symbol.asyncIterator]()
			expect((await bounded(iterator.next())).value).toEqual({ type: "reasoning", text: "partial" })
			await expect(bounded(iterator.next())).rejects.toThrow(/deadline exceeded/)
			await bounded(closed)
		} finally {
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	}, 15_000)

	it("terminal SSE frame without trailing newline finishes instead of waiting for EOF", async () => {
		const server = createServer((_req, response) => {
			response.writeHead(200, { "Content-Type": "text/event-stream" })
			response.end("data: " + JSON.stringify({
				type: "response.completed", response: { id: "final", output: [], status: "completed" },
			}))
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const port = (server.address() as AddressInfo).port
		const rawFetch = globalThis.fetch.bind(globalThis)
		vi.stubGlobal("fetch", vi.fn((_url: unknown, options?: RequestInit) =>
			rawFetch("http://127.0.0.1:" + port + "/responses", options)))
		vi.spyOn(openAiCodexOAuthManager, "getTokenSnapshot")
			.mockResolvedValue({ accessToken: "synthetic" })
		const handler = new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol" })
		;(handler as any).useManualSse = true
		try {
			for await (const _chunk of handler.createMessage("system", [], { taskId: "tail" })) {}
			expect(handler.getResponseId()).toBe("final")
		} finally {
			server.closeAllConnections()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	}, 15_000)
})
