// kilocode_change - new file
import path from "path"

import type { HistoryItem } from "@roo-code/types"

import { exportDialogHistory, renderDialogMarkdown, safeTaskId, type DialogHistoryProvider } from "../exportDialogHistory"

class MemoryFs {
	public files = new Map<string, string>()
	public directories = new Set<string>()

	async mkdir(dirPath: string, _options: { recursive: boolean }): Promise<void> {
		this.directories.add(dirPath)
	}

	async readFile(filePath: string, _encoding: "utf8"): Promise<string> {
		const value = this.files.get(filePath)

		if (value === undefined) {
			throw new Error(`Missing file: ${filePath}`)
		}

		return value
	}

	async writeFile(filePath: string, data: string, _encoding: "utf8"): Promise<void> {
		this.files.set(filePath, data)
	}

	async access(filePath: string): Promise<void> {
		if (!this.files.has(filePath)) {
			throw new Error(`Missing file: ${filePath}`)
		}
	}
}

const createHistoryItem = (overrides: Partial<HistoryItem>): HistoryItem =>
	({
		id: "task-1",
		number: 1,
		task: "Test task",
		ts: 1,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		workspace: "/workspace",
		...overrides,
	}) as HistoryItem

const createProvider = (history: HistoryItem[], tasks: Record<string, { uiMessages?: unknown[]; apiHistory?: unknown[] }>) => {
	const provider: DialogHistoryProvider = {
		cwd: "/workspace",
		getTaskHistory: () => history,
		getTaskWithId: vi.fn(async (id: string) => {
			const task = tasks[id]

			if (!task) {
				throw new Error(`Task ${id} failed`)
			}

			return {
				historyItem: history.find((item) => item.id === id)!,
				apiConversationHistoryFilePath: `/storage/tasks/${id}/api_conversation_history.json`,
				uiMessagesFilePath: `/storage/tasks/${id}/ui_messages.json`,
				apiConversationHistory: task.apiHistory ?? [],
			}
		}),
	}

	return provider
}

describe("exportDialogHistory", () => {
	it("exports only current workspace tasks and creates dialog files", async () => {
		const fileSystem = new MemoryFs()
		const currentTask = createHistoryItem({ id: "task-1", task: "Current task", ts: 2 })
		const otherTask = createHistoryItem({ id: "task-2", task: "Other task", ts: 3, workspace: "/other" })
		const provider = createProvider([otherTask, currentTask], {
			"task-1": { uiMessages: [{ type: "say", text: "Visible message" }] },
		})

		fileSystem.files.set(
			"/storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ type: "say", text: "Visible message" }]),
		)

		const result = await exportDialogHistory(provider, { fs: fileSystem })

		expect(result).toMatchObject({ total: 1, exported: 1, skipped: 0, failed: [] })
		expect(fileSystem.directories.has(path.join("/workspace", ".kilo", "history", "dialogs"))).toBe(true)
		expect(fileSystem.files.get(path.join("/workspace", ".kilo", "history", "dialogs", "task-1.md"))).toContain(
			"Visible message",
		)
		expect(provider.getTaskWithId).toHaveBeenCalledTimes(1)
		expect(provider.getTaskWithId).toHaveBeenCalledWith("task-1", false)
	})

	it("skips existing dialog files without overwriting", async () => {
		const fileSystem = new MemoryFs()
		const outputPath = path.join("/workspace", ".kilo", "history", "dialogs", "task-1.md")
		fileSystem.files.set(outputPath, "existing")

		const provider = createProvider([createHistoryItem({ id: "task-1" })], {
			"task-1": { uiMessages: [{ type: "say", text: "New message" }] },
		})

		const result = await exportDialogHistory(provider, { fs: fileSystem })

		expect(result).toMatchObject({ total: 1, exported: 0, skipped: 1, failed: [] })
		expect(fileSystem.files.get(outputPath)).toBe("existing")
		expect(provider.getTaskWithId).not.toHaveBeenCalled()
	})

	it("continues after task export failures", async () => {
		const fileSystem = new MemoryFs()
		const provider = createProvider(
			[createHistoryItem({ id: "task-1", ts: 2 }), createHistoryItem({ id: "task-2", ts: 1 })],
			{
				"task-2": { uiMessages: [{ type: "say", text: "Exported" }] },
			},
		)
		fileSystem.files.set("/storage/tasks/task-2/ui_messages.json", JSON.stringify([{ type: "say", text: "Exported" }]))

		const result = await exportDialogHistory(provider, { fs: fileSystem })

		expect(result.exported).toBe(1)
		expect(result.failed).toEqual([{ taskId: "task-1", error: "Task task-1 failed" }])
		expect(fileSystem.files.get(path.join("/workspace", ".kilo", "history", "dialogs", "task-2.md"))).toContain(
			"Exported",
		)
	})

	it("falls back to API history when UI messages are empty", () => {
		const markdown = renderDialogMarkdown({
			historyItem: createHistoryItem({ id: "task-1", task: "Fallback" }),
			uiMessages: [],
			apiConversationHistory: [{ role: "user", content: [{ type: "text", text: "API message" }] }],
		})

		expect(markdown).toContain("# Fallback")
		expect(markdown).toContain("### user")
		expect(markdown).toContain("API message")
	})

	it("sanitizes unsafe task ids for filenames", () => {
		expect(safeTaskId("task/one:two three")).toBe("task_one_two_three")
	})
})
