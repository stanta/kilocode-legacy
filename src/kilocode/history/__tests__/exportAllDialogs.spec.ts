// kilocode_change - new file
import path from "path"

import type { HistoryItem } from "@roo-code/types"

import { exportAllDialogs, type AllDialogsExportProvider, type FileSystemAdapter } from "../exportAllDialogs"

class MemoryDirent {
	public constructor(
		public readonly name: string,
		private readonly type: "file" | "directory",
	) {}

	isDirectory(): boolean {
		return this.type === "directory"
	}

	isFile(): boolean {
		return this.type === "file"
	}
}

class MemoryFs implements FileSystemAdapter {
	public files = new Map<string, string>()
	public directories = new Set<string>()

	async mkdir(dirPath: string, _options: { recursive: boolean }): Promise<void> {
		this.addDirectory(dirPath)
	}

	async readFile(filePath: string, _encoding: "utf8"): Promise<string> {
		const value = this.files.get(filePath)

		if (value === undefined) {
			const error = new Error(`Missing file: ${filePath}`) as NodeJS.ErrnoException
			error.code = "ENOENT"
			throw error
		}

		return value
	}

	async writeFile(filePath: string, data: string, _encoding: "utf8"): Promise<void> {
		this.addDirectory(path.dirname(filePath))
		this.files.set(filePath, data)
	}

	async readdir(dirPath: string, _options: { withFileTypes: true }): Promise<MemoryDirent[]> {
		if (!this.directories.has(dirPath)) {
			const error = new Error(`Missing path: ${dirPath}`) as NodeJS.ErrnoException
			error.code = "ENOENT"
			throw error
		}

		const entries = new Map<string, "file" | "directory">()
		const prefix = `${dirPath}${path.sep}`

		for (const directoryPath of this.directories) {
			if (!directoryPath.startsWith(prefix)) {
				continue
			}

			const relativePath = directoryPath.slice(prefix.length)
			const [name] = relativePath.split(path.sep)

			if (name) {
				entries.set(name, "directory")
			}
		}

		for (const filePath of this.files.keys()) {
			if (!filePath.startsWith(prefix)) {
				continue
			}

			const relativePath = filePath.slice(prefix.length)
			const [name] = relativePath.split(path.sep)

			if (name && !entries.has(name)) {
				entries.set(name, "file")
			}
		}

		return [...entries.entries()].map(([name, type]) => new MemoryDirent(name, type))
	}

	addDirectory(dirPath: string): void {
		let current = path.isAbsolute(dirPath) ? path.sep : ""

		for (const segment of dirPath.split(path.sep).filter(Boolean)) {
			current = current === path.sep ? path.join(current, segment) : path.join(current, segment)
			this.directories.add(current)
		}

		this.directories.add(dirPath)
	}

	addFile(filePath: string, content: string): void {
		this.addDirectory(path.dirname(filePath))
		this.files.set(filePath, content)
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
		mode: "code",
		...overrides,
	}) as HistoryItem

const createProvider = (history: HistoryItem[], cwd = "/workspace"): AllDialogsExportProvider => ({
	cwd,
	contextProxy: {
		globalStorageUri: {
			fsPath: "/global-storage",
		},
	},
	getTaskHistory: () => history,
})

describe("exportAllDialogs", () => {
	const outputDir = "/selected/export"

	it("requires an explicit output directory", async () => {
		await expect(exportAllDialogs(createProvider([]), { fs: new MemoryFs() })).rejects.toThrow(
			"An output directory is required",
		)
	})

	it("exports only current-project history items and ignores other workspaces and orphan task dirs", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ type: "say", say: "text", text: "Current" }]),
		)
		fileSystem.addFile(
			"/global-storage/tasks/task-2/ui_messages.json",
			JSON.stringify([{ type: "say", say: "text", text: "Other" }]),
		)
		fileSystem.addFile(
			"/global-storage/tasks/orphan/ui_messages.json",
			JSON.stringify([{ type: "say", say: "text", text: "Orphan" }]),
		)

		const result = await exportAllDialogs(
			createProvider([
				createHistoryItem({ id: "task-1", workspace: "/workspace" }),
				createHistoryItem({ id: "task-2", workspace: "/other" }),
			]),
			{ fs: fileSystem, outputDir, getStorageBasePath: async (defaultPath) => defaultPath },
		)

		expect(result).toMatchObject({ total: 1, exported: 1, refreshed: 0, skipped: 0, failed: [], warnings: [] })
		expect(fileSystem.files.get(path.join(outputDir, "dialogs", "task-1.md"))).toContain("Current")
		expect(fileSystem.files.has(path.join(outputDir, "dialogs", "task-2.md"))).toBe(false)
		expect(fileSystem.files.has(path.join(outputDir, "dialogs", "orphan.md"))).toBe(false)
		expect(JSON.parse(fileSystem.files.get(result.taskHistoryPath)!)).toHaveLength(1)
	})

	it("writes sanitized task history without credential-bearing runtime config", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ type: "say", say: "text", text: "Current" }]),
		)

		const result = await exportAllDialogs(
			createProvider([
				createHistoryItem({
					id: "task-1",
					task: "Sensitive history",
					apiConfigName: "default",
					sessionRuntimeConfig: {
						version: 1,
						modeBindings: {
							code: {
								apiConfiguration: {
									openRouterApiKey: "test-openrouter-value",
									kilocodeToken: "test-kilocode-token",
								},
							},
						},
					} as unknown as HistoryItem["sessionRuntimeConfig"],
				}),
			]),
			{ fs: fileSystem, outputDir, getStorageBasePath: async (defaultPath) => defaultPath },
		)

		const rawHistory = fileSystem.files.get(result.taskHistoryPath)!
		const exportedHistory = JSON.parse(rawHistory)

		expect(exportedHistory).toEqual([
			expect.objectContaining({
				id: "task-1",
				task: "Sensitive history",
				apiConfigName: "default",
			}),
		])
		expect(rawHistory).not.toContain("sessionRuntimeConfig")
		expect(rawHistory).not.toContain("apiConfiguration")
		expect(rawHistory).not.toContain("openRouterApiKey")
		expect(rawHistory).not.toContain("kilocodeToken")
		expect(rawHistory).not.toContain("test-openrouter-value")
		expect(rawHistory).not.toContain("test-kilocode-token")
	})

	it("writes text-only dialog markdown and excludes internal noise", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([
				{ ts: 1, type: "say", say: "text", text: "Visible user task" },
				{ ts: 2, type: "say", say: "api_req_started", text: "noise" },
				{ ts: 3, type: "say", say: "checkpoint_saved", text: "noise" },
				{ ts: 4, type: "say", say: "reasoning", text: "hidden reasoning" },
				{ ts: 5, type: "say", say: "completion_result", text: "Completion" },
				{ ts: 6, type: "say", say: "subtask_result", text: "Subtask" },
				{ ts: 7, type: "say", say: "user_feedback", text: "Feedback" },
				{ ts: 8, type: "ask", ask: "followup", text: "Follow-up?" },
				{ ts: 9, type: "ask", ask: "completion_result", text: "Completion ask" },
				{ ts: 10, type: "ask", ask: "tool", text: '{"tool":"readFile","path":"a.ts"}' },
			]),
		)

		const result = await exportAllDialogs(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})

		const markdown = fileSystem.files.get(path.join(outputDir, "dialogs", "task-1.md"))!
		expect(markdown).toContain("messageCount: 7")
		expect(markdown).toContain("Visible user task")
		expect(markdown).toContain("Completion")
		expect(markdown).toContain("Subtask")
		expect(markdown).toContain("## user (say:user_feedback)")
		expect(markdown).toContain("Feedback")
		expect(markdown).toContain("Follow-up?")
		expect(markdown).toContain("Completion ask")
		expect(markdown).toContain('{"tool":"readFile","path":"a.ts"}')
		expect(markdown).not.toContain("api_req_started")
		expect(markdown).not.toContain("checkpoint_saved")
		expect(markdown).not.toContain("hidden reasoning")
		expect(result).toMatchObject({ total: 1, exported: 1, failed: [] })
	})

	it("skips unchanged existing markdown when message count matches", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([
				{ type: "say", say: "text", text: "Source text" },
				{ type: "say", say: "completion_result", text: "Completion" },
			]),
		)
		fileSystem.addFile(path.join(outputDir, "dialogs", "task-1.md"), "---\nmessageCount: 2\n---\n\nOld")

		const result = await exportAllDialogs(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})

		expect(result).toMatchObject({ total: 1, exported: 0, refreshed: 0, skipped: 1, failed: [], warnings: [] })
		expect(fileSystem.files.get(path.join(outputDir, "dialogs", "task-1.md"))).toBe(
			"---\nmessageCount: 2\n---\n\nOld",
		)
	})

	it("refreshes existing markdown when extracted source message count differs", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([
				{ type: "say", say: "text", text: "New text" },
				{ type: "say", say: "completion_result", text: "Completion" },
			]),
		)
		fileSystem.addFile(path.join(outputDir, "dialogs", "task-1.md"), "---\nmessageCount: 1\n---\n\nOld")

		const result = await exportAllDialogs(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})

		expect(result).toMatchObject({ total: 1, exported: 0, refreshed: 1, skipped: 0, failed: [], warnings: [] })
		expect(fileSystem.files.get(path.join(outputDir, "dialogs", "task-1.md"))).toContain("New text")
		expect(fileSystem.files.get(path.join(outputDir, "dialogs", "task-1.md"))).toContain("messageCount: 2")
	})

	it("refreshes existing markdown with a warning when existing message count is not parseable", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ type: "say", say: "text", text: "New" }]),
		)
		fileSystem.addFile(path.join(outputDir, "dialogs", "task-1.md"), "No frontmatter")

		const result = await exportAllDialogs(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})

		expect(result.refreshed).toBe(1)
		expect(result.warnings).toEqual([
			{
				taskId: "task-1",
				warning: expect.stringContaining("Cannot parse existing messageCount"),
			},
		])
	})

	it("handles missing and unparseable ui_messages.json", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addDirectory("/global-storage/tasks/task-1")
		fileSystem.addFile("/global-storage/tasks/task-2/ui_messages.json", "not json")

		const result = await exportAllDialogs(
			createProvider([createHistoryItem({ id: "task-1" }), createHistoryItem({ id: "task-2" })]),
			{ fs: fileSystem, outputDir, getStorageBasePath: async (defaultPath) => defaultPath },
		)

		expect(result.exported).toBe(0)
		expect(result.failed).toEqual([
			{ taskId: "task-1", error: expect.stringContaining("Missing file") },
			{ taskId: "task-2", error: expect.stringContaining("Unexpected token") },
		])
	})

	it("writes a manifest with counts and scope", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ type: "say", say: "text", text: "Current" }]),
		)

		const result = await exportAllDialogs(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})

		const manifest = JSON.parse(fileSystem.files.get(result.manifestPath)!)
		expect(manifest).toMatchObject({
			scope: "currentProject",
			workspace: "/workspace",
			storageBasePath: "/global-storage",
			outputDir,
			dialogsDir: path.join(outputDir, "dialogs"),
			total: 1,
			exported: 1,
			refreshed: 0,
			skipped: 0,
			failed: [],
			warnings: [],
		})
	})
})
