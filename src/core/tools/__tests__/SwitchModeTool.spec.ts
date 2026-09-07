// npx vitest run core/tools/__tests__/SwitchModeTool.spec.ts

import { switchModeTool } from "../SwitchModeTool"

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../shared/modes", () => ({
	defaultModeSlug: "code",
	getModeBySlug: vi.fn((slug: string) => {
		const modes: Record<string, { slug: string; name: string }> = {
			code: { slug: "code", name: "Code" },
			architect: { slug: "architect", name: "Architect" },
		}
		return modes[slug]
	}),
}))

describe("SwitchModeTool", () => {
	it("uses task-local current mode before invoking the session-local mode switch", async () => {
		const provider = {
			getState: vi.fn().mockResolvedValue({ customModes: [] }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
		}
		const task = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			didToolFailInCurrentTurn: false,
			getTaskMode: vi.fn().mockResolvedValue("code"),
			providerRef: { deref: vi.fn(() => provider) },
		} as any
		const callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			removeClosingTag: vi.fn(),
			toolProtocol: "xml" as const,
		}

		await switchModeTool.execute({ mode_slug: "architect", reason: "needs planning" }, task, callbacks)

		expect(task.getTaskMode).toHaveBeenCalledOnce()
		expect(provider.handleModeSwitch).toHaveBeenCalledWith("architect")
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("Successfully switched from Code mode to Architect mode"),
		)
	})

	it("does not switch when the task-local mode already matches the target", async () => {
		const provider = {
			getState: vi.fn().mockResolvedValue({ customModes: [] }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
		}
		const task = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			didToolFailInCurrentTurn: false,
			getTaskMode: vi.fn().mockResolvedValue("architect"),
			providerRef: { deref: vi.fn(() => provider) },
		} as any
		const callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			removeClosingTag: vi.fn(),
			toolProtocol: "xml" as const,
		}

		await switchModeTool.execute({ mode_slug: "architect", reason: "already there" }, task, callbacks)

		expect(task.getTaskMode).toHaveBeenCalledOnce()
		expect(provider.handleModeSwitch).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Already in Architect mode.")
	})
})
