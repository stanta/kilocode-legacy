// kilocode_change - new file
import type { Anthropic } from "@anthropic-ai/sdk"

import { OpenAiCodexHandler } from "../openai-codex"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"

describe("OpenAiCodexHandler tool history", () => {
	let handler: OpenAiCodexHandler
	let warn: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		handler = new OpenAiCodexHandler({ apiModelId: "gpt-6.1-sol" })
		vi.spyOn(openAiCodexOAuthManager, "getTokenSnapshot").mockResolvedValue({ accessToken: "test-token" })
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue(null)
		warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	// Exercise the actual outgoing request, without contacting the Codex backend.
	async function requestInput(messages: Anthropic.Messages.MessageParam[]) {
		const create = vi.fn().mockResolvedValue({
			async *[Symbol.asyncIterator]() {
				yield { type: "response.completed", response: { id: "resp_test", output: [] } }
			},
		})
		;(handler as any).client = { responses: { create } }
		for await (const _chunk of handler.createMessage("system", messages, {
			taskId: "task-history-test",
			toolProtocol: "native",
		})) {
			// Consume the stream so request preparation and execution run.
		}
		expect(create).toHaveBeenCalledTimes(1)
		return create.mock.calls[0][0].input as Array<Record<string, unknown>>
	}

	const completion: Anthropic.Messages.MessageParam = {
		role: "assistant",
		content: [{ type: "tool_use", id: "call_completion", name: "attempt_completion", input: { result: "Done" } }],
	}

	it("closes a historical completion before a subsequent assistant tool call", async () => {
		// Regression: two assistant turns followed by only the second turn's result.
		const input = await requestInput([
			completion,
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_search", name: "codebase_search", input: { query: "check" } }],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_search", content: "Search results" }] },
		])

		expect(input).toEqual([
			{
				type: "function_call",
				call_id: "call_completion",
				name: "attempt_completion",
				arguments: '{"result":"Done"}',
			},
			{
				type: "function_call_output",
				call_id: "call_completion",
				output: expect.stringMatching(/not recorded/i),
			},
			{
				type: "function_call",
				call_id: "call_search",
				name: "codebase_search",
				arguments: '{"query":"check"}',
			},
			{ type: "function_call_output", call_id: "call_search", output: "Search results" },
		])
		// Missing feedback must not be represented as user acceptance.
		expect(input[1].output).toMatch(/acceptance.*unknown/i)
	})

	it("closes a completion before a new user message without a tool result", async () => {
		const input = await requestInput([completion, { role: "user", content: "Continue with a review" }])

		expect(input.map((item) => item.type ?? item.role)).toEqual(["function_call", "function_call_output", "user"])
		expect(input[1].call_id).toBe("call_completion")
		expect(input[2].content).toEqual([{ type: "input_text", text: "Continue with a review" }])
	})

	it("closes a trailing completion when the history is reused for another request", async () => {
		const input = await requestInput([completion])

		expect(input).toHaveLength(2)
		expect(input[1]).toMatchObject({ type: "function_call_output", call_id: "call_completion" })
	})

	it("preserves recorded completion feedback without synthesizing a second result", async () => {
		const input = await requestInput([
			completion,
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "call_completion", content: "Please fix the tests first" },
				],
			},
		])

		expect(input).toHaveLength(2)
		expect(input[1]).toEqual({
			type: "function_call_output",
			call_id: "call_completion",
			output: "Please fix the tests first",
		})
		expect(warn).not.toHaveBeenCalled()
	})

	it("does not change saved messages or accumulate results across repeated requests", async () => {
		const messages = [completion, { role: "user" as const, content: "Continue" }]
		const before = JSON.stringify(messages)

		const first = await requestInput(messages)
		const second = await requestInput(messages)

		expect(JSON.stringify(messages)).toBe(before)
		expect(second).toEqual(first)
		expect(second.filter((item) => item.type === "function_call_output")).toHaveLength(1)
	})

	it("recognizes an existing result after call ID normalization", async () => {
		const input = await requestInput([
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "call.complete", name: "attempt_completion", input: { result: "Done" } },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call.complete", content: "Recorded" }] },
		])

		expect(input).toHaveLength(2)
		expect(input[0].call_id).toBe("call_complete")
		expect(input[1]).toEqual({ type: "function_call_output", call_id: "call_complete", output: "Recorded" })
		expect(warn).not.toHaveBeenCalled()
	})

	it("reports missing results without fabricating execution results for ordinary tools", async () => {
		const input = await requestInput([
			completion,
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "call_command", name: "execute_command", input: { command: "PRIVATE" } },
				],
			},
		])

		expect(input.filter((item) => item.type === "function_call_output").map((item) => item.call_id)).toEqual([
			"call_completion",
		])
		expect(warn).toHaveBeenCalledWith("[OpenAI Codex] Incomplete tool history", {
			taskId: "task-history-test",
			repairedCompletionCallIds: ["call_completion"],
			unresolvedCallIds: ["call_command"],
		})
		expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE")
		expect(JSON.stringify(warn.mock.calls)).not.toContain("test-token")
	})

	it("preserves valid ordinary tool results and encrypted reasoning around a repaired completion", async () => {
		const reasoning = { type: "reasoning", id: "rs_test", encrypted_content: "encrypted", summary: [] }
		const input = await requestInput([
			reasoning as unknown as Anthropic.Messages.MessageParam,
			completion,
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_read", name: "read_file", input: { path: "test.txt" } }],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_read", content: "File contents" }] },
		])

		expect(input[0]).toEqual(reasoning)
		expect(input.filter((item) => item.type === "function_call_output")).toEqual([
			{ type: "function_call_output", call_id: "call_completion", output: expect.any(String) },
			{ type: "function_call_output", call_id: "call_read", output: "File contents" },
		])
	})

	it("reports an ordinary missing result even when there is no completion to repair", async () => {
		const input = await requestInput([
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_read", name: "read_file", input: { path: "test.txt" } }],
			},
		])

		expect(input).toHaveLength(1)
		expect(input[0]).toMatchObject({ type: "function_call", call_id: "call_read" })
		expect(warn).toHaveBeenCalledWith("[OpenAI Codex] Incomplete tool history", {
			taskId: "task-history-test",
			repairedCompletionCallIds: [],
			unresolvedCallIds: ["call_read"],
		})
	})

	it("leaves conversations without tool calls unchanged", async () => {
		const input = await requestInput([{ role: "user", content: "Hello" }])

		expect(input).toEqual([{ role: "user", content: [{ type: "input_text", text: "Hello" }] }])
		expect(warn).not.toHaveBeenCalled()
	})
})
