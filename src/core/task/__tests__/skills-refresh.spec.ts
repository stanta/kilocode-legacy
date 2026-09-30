import { Task } from "../Task"

describe("Task skill refresh on user messages", () => {
	function createBareTask(discoverSkills = vi.fn().mockResolvedValue(undefined)) {
		const provider = {
			getSkillsManager: vi.fn(() => ({ discoverSkills })),
			log: vi.fn(),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		}

		const task = Object.create(Task.prototype) as Task
		Object.assign(task as any, {
			taskId: "task-id",
			instanceId: "instance-id",
			providerRef: { deref: () => provider },
			pendingSkillsRefresh: Promise.resolve(),
			clineMessages: [],
			apiConversationHistory: [],
			enableBridge: false,
			abortReason: undefined,
			abandoned: false,
		})

		;(task as any).cancelAutoApprovalTimeout = vi.fn()
		;(task as any).checkpointSave = vi.fn().mockResolvedValue(undefined)
		;(task as any).saveClineMessages = vi.fn().mockResolvedValue(undefined)

		return { task, provider, discoverSkills }
	}

	it("refreshes skills for a normal user message", async () => {
		const { task, discoverSkills } = createBareTask()

		task.handleWebviewAskResponse("messageResponse", "Use the latest skills")

		await (task as any).waitForPendingSkillsRefresh()

		expect(discoverSkills).toHaveBeenCalledTimes(1)
	})

	it("refreshes skills when queued user content is attached to an approval response", async () => {
		const { task, discoverSkills } = createBareTask()

		task.handleWebviewAskResponse("yesButtonClicked", "Also check the new skill", undefined)

		await (task as any).waitForPendingSkillsRefresh()

		expect(discoverSkills).toHaveBeenCalledTimes(1)
	})

	it("does not refresh skills for an approval click without user-authored content", async () => {
		const { task, discoverSkills } = createBareTask()

		task.handleWebviewAskResponse("yesButtonClicked")

		await (task as any).waitForPendingSkillsRefresh()

		expect(discoverSkills).not.toHaveBeenCalled()
	})

	it("waits for the initial user message skill refresh before starting the task loop", async () => {
		let finishRefresh: (() => void) | undefined
		const discoverSkills = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishRefresh = resolve
				}),
		)
		const { task } = createBareTask(discoverSkills)
		const initiateTaskLoop = vi.fn().mockResolvedValue(undefined)

		;(task as any).say = vi.fn().mockResolvedValue(undefined)
		;(task as any).saveApiConversationHistory = vi.fn().mockResolvedValue(undefined)
		;(task as any).initiateTaskLoop = initiateTaskLoop

		const startPromise = (task as any).startTask("Initial message", [])

		await Promise.resolve()
		expect(discoverSkills).toHaveBeenCalledTimes(1)
		expect(initiateTaskLoop).not.toHaveBeenCalled()

		finishRefresh?.()
		await startPromise

		expect(initiateTaskLoop).toHaveBeenCalledTimes(1)
	})
})
