// kilocode_change - new file
import path from "path"

import type { HistoryItem } from "@roo-code/types"

import { exportAllSessions, type AllSessionsExportProvider } from "../exportAllSessions"

class MemoryFs {
	public files = new Map<string, string>()
	public directories = new Set<string>()

	async mkdir(dirPath: string, _options: { recursive: boolean }): Promise<void> {
		this.directories.add(dirPath)
	}

	async copyFile(src: string, dest: string): Promise<void> {
		const value = this.files.get(src)

		if (value === undefined) {
			throw new Error(`Missing file: ${src}`)
		}

		this.files.set(dest, value)
	}

	async writeFile(filePath: string, data: string, _encoding: "utf8"): Promise<void> {
		this.files.set(filePath, data)
	}

	async access(targetPath: string): Promise<void> {
		if (!this.files.has(targetPath) && !this.directories.has(targetPath)) {
			throw new Error(`Missing path: ${targetPath}`)
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

const createProvider = (
	history: HistoryItem[],
	tasks: Record<string, { taskDirPath?: string } | null>,
): AllSessionsExportProvider => ({
	cwd: "/workspace",
	getTaskHistory: () => history,
	getTaskWithId: vi.fn(async (id: string) => {
		const task = tasks[id]

		if (task === null) {
			throw new Error(`Task ${id} failed`)
		}

		return {
			historyItem: history.find((item) => item.id === id)!,
			taskDirPath: task?.taskDirPath ?? `/storage/tasks/${id}`,
		}
	}),
})

describe("exportAllSessions", () => {
	it("writes task_history.json from global state and copies raw session files", async () => {
		const fileSystem = new MemoryFs()
		const firstTask = createHistoryItem({ id: "task-1", task: "First", ts: 2 })
		const secondTask = createHistoryItem({ id: "task-2", task: "Second", ts: 3, workspace: "/other" })
		const provider = createProvider([secondTask, firstTask], {})

		fileSystem.files.set("/storage/tasks/task-1/api_conversation_history.json", '[{"role":"user"}]')
		fileSystem.files.set("/storage/tasks/task-1/ui_messages.json", '[{"type":"say"}]')
		fileSystem.files.set("/storage/tasks/task-2/api_conversation_history.json", '[{"role":"assistant"}]')

		const result = await exportAllSessions(provider, { fs: fileSystem })

		const outputDir = path.join("/workspace", ".kilo", "history", "sessions")

		expect(result).toMatchObject({ total: 2, exported: 2, skipped: 0, failed: [] })
		expect(result.outputDir).toBe(outputDir)
		expect(result.taskHistoryPath).toBe(path.join(outputDir, "task_history.json"))

		// The history index includes every session from global state, verbatim.
		const historyJson = JSON.parse(fileSystem.files.get(result.taskHistoryPath)!)
		expect(historyJson).toHaveLength(2)
		expect(historyJson.map((item: HistoryItem) => item.id).sort()).toEqual(["task-1", "task-2"])

		// Raw files are copied byte-for-byte into a per-task directory.
		expect(
			fileSystem.files.get(
				path.join(outputDir, "tasks", outputTaskDirName("task-1"), "api_conversation_history.json"),
			),
		).toBe('[{"role":"user"}]')
		expect(
			fileSystem.files.get(path.join(outputDir, "tasks", outputTaskDirName("task-1"), "ui_messages.json")),
		).toBe('[{"type":"say"}]')
		expect(
			fileSystem.files.get(
				path.join(outputDir, "tasks", outputTaskDirName("task-2"), "api_conversation_history.json"),
			),
		).toBe('[{"role":"assistant"}]')
		expect(
			fileSystem.files.has(path.join(outputDir, "tasks", outputTaskDirName("task-1"), "export_complete.json")),
		).toBe(true)

		// getTaskWithId is called without triggering user-facing error messages.
		expect(provider.getTaskWithId).toHaveBeenCalledWith("task-1", false)
		expect(provider.getTaskWithId).toHaveBeenCalledWith("task-2", false)
	})

	it("skips sessions with a completion marker without overwriting", async () => {
		const fileSystem = new MemoryFs()
		const outputDir = path.join("/workspace", ".kilo", "history", "sessions")
		const taskOutputDir = path.join(outputDir, "tasks", outputTaskDirName("task-1"))
		const existingFile = path.join(taskOutputDir, "api_conversation_history.json")
		fileSystem.directories.add(taskOutputDir)
		fileSystem.files.set(existingFile, "existing")
		fileSystem.files.set(path.join(taskOutputDir, "export_complete.json"), "{}")

		const provider = createProvider([createHistoryItem({ id: "task-1" })], {})

		const result = await exportAllSessions(provider, { fs: fileSystem })

		expect(result).toMatchObject({ total: 1, exported: 0, skipped: 1, failed: [] })
		expect(fileSystem.files.get(existingFile)).toBe("existing")
		expect(provider.getTaskWithId).not.toHaveBeenCalled()
	})

	it("resumes incomplete existing export directories by copying missing files", async () => {
		const fileSystem = new MemoryFs()
		const outputDir = path.join("/workspace", ".kilo", "history", "sessions")
		const taskOutputDir = path.join(outputDir, "tasks", outputTaskDirName("task-1"))
		const existingFile = path.join(taskOutputDir, "api_conversation_history.json")
		fileSystem.directories.add(taskOutputDir)
		fileSystem.files.set(existingFile, "existing")
		fileSystem.files.set("/storage/tasks/task-1/api_conversation_history.json", "new-api")
		fileSystem.files.set("/storage/tasks/task-1/ui_messages.json", "new-ui")

		const provider = createProvider([createHistoryItem({ id: "task-1" })], {})

		const result = await exportAllSessions(provider, { fs: fileSystem })

		expect(result).toMatchObject({ total: 1, exported: 1, skipped: 0, failed: [] })
		expect(fileSystem.files.get(existingFile)).toBe("new-api")
		expect(fileSystem.files.get(path.join(taskOutputDir, "ui_messages.json"))).toBe("new-ui")
		expect(fileSystem.files.has(path.join(taskOutputDir, "export_complete.json"))).toBe(true)
	})

	it("continues after task export failures and records errors", async () => {
		const fileSystem = new MemoryFs()
		const provider = createProvider(
			[createHistoryItem({ id: "task-1", ts: 2 }), createHistoryItem({ id: "task-2", ts: 1 })],
			{ "task-1": null, "task-2": {} },
		)
		fileSystem.files.set("/storage/tasks/task-2/api_conversation_history.json", '[{"role":"user"}]')

		const result = await exportAllSessions(provider, { fs: fileSystem })

		expect(result.exported).toBe(1)
		expect(result.failed).toEqual([{ taskId: "task-1", error: "Task task-1 failed" }])
		expect(
			fileSystem.files.get(
				path.join(
					"/workspace",
					".kilo",
					"history",
					"sessions",
					"tasks",
					outputTaskDirName("task-2"),
					"api_conversation_history.json",
				),
			),
		).toBe('[{"role":"user"}]')
	})

	it("records a failure when a session has no raw files on disk", async () => {
		const fileSystem = new MemoryFs()
		const provider = createProvider([createHistoryItem({ id: "task-1" })], {})

		const result = await exportAllSessions(provider, { fs: fileSystem })

		expect(result).toMatchObject({
			total: 1,
			exported: 0,
			skipped: 0,
			failed: [{ taskId: "task-1", error: "No raw session files found" }],
		})
	})

	it("exports an empty history index when there are no sessions", async () => {
		const fileSystem = new MemoryFs()
		const provider = createProvider([], {})

		const result = await exportAllSessions(provider, { fs: fileSystem })

		expect(result).toMatchObject({ total: 0, exported: 0, skipped: 0, failed: [] })
		expect(JSON.parse(fileSystem.files.get(result.taskHistoryPath)!)).toEqual([])
	})

	it("sanitizes unsafe task ids for output directories", async () => {
		const fileSystem = new MemoryFs()
		const provider = createProvider([createHistoryItem({ id: "task/one:two" })], {})
		fileSystem.files.set("/storage/tasks/task/one:two/api_conversation_history.json", "[]")

		const result = await exportAllSessions(provider, { fs: fileSystem })

		expect(result.exported).toBe(1)
		expect(
			fileSystem.files.get(
				path.join(
					"/workspace",
					".kilo",
					"history",
					"sessions",
					"tasks",
					outputTaskDirName("task/one:two"),
					"api_conversation_history.json",
				),
			),
		).toBe("[]")
	})

	it("keeps sanitized task id collisions in separate directories", async () => {
		const fileSystem = new MemoryFs()
		const provider = createProvider(
			[createHistoryItem({ id: "task/one" }), createHistoryItem({ id: "task:one" })],
			{},
		)
		fileSystem.files.set("/storage/tasks/task/one/api_conversation_history.json", "slash")
		fileSystem.files.set("/storage/tasks/task:one/api_conversation_history.json", "colon")

		const result = await exportAllSessions(provider, { fs: fileSystem })
		const outputDir = path.join("/workspace", ".kilo", "history", "sessions")

		expect(result.exported).toBe(2)
		expect(
			fileSystem.files.get(
				path.join(outputDir, "tasks", outputTaskDirName("task/one"), "api_conversation_history.json"),
			),
		).toBe("slash")
		expect(
			fileSystem.files.get(
				path.join(outputDir, "tasks", outputTaskDirName("task:one"), "api_conversation_history.json"),
			),
		).toBe("colon")
	})
})

function outputTaskDirName(taskId: string): string {
	return `${taskId.replace(/[^a-zA-Z0-9._-]/g, "_")}-${Buffer.from(taskId).toString("base64url")}`
}
