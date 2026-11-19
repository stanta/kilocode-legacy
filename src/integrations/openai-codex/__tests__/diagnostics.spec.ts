import { logCodexLifecycle, setCodexDiagnosticOutput } from "../diagnostics"

describe("Codex persistent lifecycle diagnostics", () => {
	afterEach(() => setCodexDiagnosticOutput(undefined))

	it("correlates attempts without recording raw provider errors or secrets", () => {
		const lines: string[] = []
		const dispose = setCodexDiagnosticOutput((line) => lines.push(line))
		logCodexLifecycle({
			phase: "task.dispatch",
			operationId: "synthetic-op-1",
			requestId: "synthetic-request-2",
			taskId: "synthetic-task-3",
			attempt: 1,
			httpStatus: 429,
			code: "AUTH_TOKEN_PRIVATE",
		})
		expect(lines).toHaveLength(1)
		const record = JSON.parse(lines[0].replace("[Codex lifecycle] ", ""))
		expect(record).toMatchObject({
			phase: "task.dispatch",
			operationId: "synthetic-op-1",
			requestId: "synthetic-request-2",
			attempt: 1,
			httpStatus: 429,
		})
		expect(record.code).toBeUndefined()
		expect(lines[0]).not.toContain("AUTH_TOKEN_PRIVATE")
		dispose()
		logCodexLifecycle({ phase: "task.eof", operationId: "synthetic-op-1" })
		expect(lines).toHaveLength(1)
	})

	it("does not affect request execution when the output channel is unavailable", () => {
		setCodexDiagnosticOutput(() => { throw new Error("closed output") })
		expect(() => logCodexLifecycle({ phase: "task.stop", taskId: "test-task" })).not.toThrow()
	})
})
