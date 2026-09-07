// kilocode_change - new file
import { EventEmitter } from "node:events"
import { fork } from "node:child_process"
import { buildApiHandler } from "../../../../api"
import { AgentRegistry } from "../AgentRegistry"
import { RuntimeProcessHandler } from "../RuntimeProcessHandler"

vi.mock("node:child_process", () => ({ fork: vi.fn() }))
vi.mock("../../../../api", () => ({ buildApiHandler: vi.fn() }))

class MockProcess extends EventEmitter {
	stdout = new EventEmitter()
	stderr = new EventEmitter()
	kill = vi.fn()
	pid = 1
	exitCode: number | null = null
}

const callbacks = {
	onLog: vi.fn(),
	onSessionLog: vi.fn(),
	onStateChanged: vi.fn(),
	onPendingSessionChanged: vi.fn(),
	onStartSessionFailed: vi.fn(),
	onChatMessages: vi.fn(),
	onSessionCreated: vi.fn(),
}

describe("RuntimeProcessHandler model isolation", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(fork).mockImplementation(() => new MockProcess() as any)
		vi.mocked(buildApiHandler).mockImplementation(
			(settings: any) =>
				({
					getModel: () => ({ id: settings.kilocodeModel ?? settings.openRouterModelId }),
				}) as any,
		)
	})

	it("serializes separate provider-aware snapshots for model A and model B", () => {
		const handler = new RuntimeProcessHandler(new AgentRegistry(), callbacks, "/extension")
		const baseline = { apiProvider: "kilocode" as const, kilocodeToken: "token", kilocodeModel: "baseline" }

		handler.spawnProcess("", "/workspace", "A", { apiConfiguration: baseline, model: "model-A" }, vi.fn())
		handler.spawnProcess("", "/workspace", "B", { apiConfiguration: baseline, model: "model-B" }, vi.fn())

		const first = JSON.parse((vi.mocked(fork).mock.calls[0][2] as any).env.AGENT_CONFIG)
		const second = JSON.parse((vi.mocked(fork).mock.calls[1][2] as any).env.AGENT_CONFIG)
		expect(first.providerSettings.kilocodeModel).toBe("model-A")
		expect(second.providerSettings.kilocodeModel).toBe("model-B")
		expect(baseline.kilocodeModel).toBe("baseline")
	})

	it("maps an OpenRouter override to its provider-specific field", () => {
		const handler = new RuntimeProcessHandler(new AgentRegistry(), callbacks, "/extension")
		handler.spawnProcess(
			"",
			"/workspace",
			"router",
			{ apiConfiguration: { apiProvider: "openrouter", openRouterModelId: "old" }, model: "new" },
			vi.fn(),
		)

		const config = JSON.parse((vi.mocked(fork).mock.calls[0][2] as any).env.AGENT_CONFIG)
		expect(config.providerSettings).toMatchObject({ apiProvider: "openrouter", openRouterModelId: "new" })
		expect(config.providerSettings.kilocodeModel).toBeUndefined()
	})

	it("rejects a resolved model mismatch before fork", () => {
		vi.mocked(buildApiHandler).mockReturnValue({ getModel: () => ({ id: "model-C" }) } as any)
		const handler = new RuntimeProcessHandler(new AgentRegistry(), callbacks, "/extension")

		handler.spawnProcess(
			"",
			"/workspace",
			"mismatch",
			{ apiConfiguration: { apiProvider: "kilocode" }, model: "model-A" },
			vi.fn(),
		)

		expect(fork).not.toHaveBeenCalled()
		expect(callbacks.onStartSessionFailed).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining("requested 'model-A', resolved 'model-C'") }),
		)
	})
})
