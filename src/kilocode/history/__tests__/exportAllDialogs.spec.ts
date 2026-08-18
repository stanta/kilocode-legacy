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
	public realpaths = new Map<string, string>()

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

	async realpath(filePath: string): Promise<string> {
		const value = this.realpaths.get(filePath)

		if (value === undefined) {
			const error = new Error(`Missing path: ${filePath}`) as NodeJS.ErrnoException
			error.code = "ENOENT"
			throw error
		}

		return value
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

	addRealpath(filePath: string, realPath: string): void {
		this.realpaths.set(path.resolve(filePath), path.resolve(realPath))
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

const outputDir = "/selected/export"
const exportedDialogPath = (taskId: string, prefix = "01-01-1970_00-00"): string =>
	path.join(outputDir, "dialogs", `${prefix}_${taskId}.md`)

describe("exportAllDialogs", () => {
	it("requires an explicit output directory", async () => {
		await expect(exportAllDialogs(createProvider([]), { fs: new MemoryFs() })).rejects.toThrow(
			"An output directory is required",
		)
	})

	it("exports only current-project history items and ignores other workspaces and orphan task dirs", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ ts: Date.UTC(2026, 7, 17, 14, 54), type: "say", say: "text", text: "Current" }]),
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
		expect(fileSystem.files.get(exportedDialogPath("task-1", "17-08-2026_14-54"))).toContain("Current")
		expect(fileSystem.files.has(path.join(outputDir, "dialogs", "task-2.md"))).toBe(false)
		expect(fileSystem.files.has(path.join(outputDir, "dialogs", "orphan.md"))).toBe(false)
		expect(JSON.parse(fileSystem.files.get(result.taskHistoryPath)!)).toHaveLength(1)
	})

	it("normalizes workspace paths before filtering current-project history", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ type: "say", say: "text", text: "Trailing slash" }]),
		)

		const result = await exportAllDialogs(
			createProvider([createHistoryItem({ id: "task-1", workspace: "/workspace/" })], "/workspace"),
			{ fs: fileSystem, outputDir, getStorageBasePath: async (defaultPath) => defaultPath },
		)

		expect(result).toMatchObject({ total: 1, exported: 1, refreshed: 0, skipped: 0, failed: [], warnings: [] })
		expect(fileSystem.files.get(exportedDialogPath("task-1"))).toContain("Trailing slash")
	})

	it("uses history timestamp fallback in Markdown filenames", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ type: "say", say: "text", text: "Fallback", ts: "not numeric" }]),
		)

		const result = await exportAllDialogs(
			createProvider([createHistoryItem({ id: "task-1", ts: Date.UTC(2026, 0, 2, 3, 4) })]),
			{ fs: fileSystem, outputDir, getStorageBasePath: async (defaultPath) => defaultPath },
		)

		expect(result).toMatchObject({ total: 1, exported: 1, refreshed: 0, skipped: 0, failed: [], warnings: [] })
		expect(fileSystem.files.get(exportedDialogPath("task-1", "02-01-2026_03-04"))).toContain("Fallback")
	})

	it("uses adapter realpath values for workspace canonicalization when available", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addRealpath("/linked-workspace", "/canonical/workspace")
		fileSystem.addRealpath("/workspace", "/canonical/workspace")
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ type: "say", say: "text", text: "Canonical" }]),
		)

		const result = await exportAllDialogs(
			createProvider([createHistoryItem({ id: "task-1", workspace: "/linked-workspace" })], "/workspace"),
			{ fs: fileSystem, outputDir, getStorageBasePath: async (defaultPath) => defaultPath },
		)

		expect(result).toMatchObject({ total: 1, exported: 1, refreshed: 0, skipped: 0, failed: [], warnings: [] })
		expect(fileSystem.files.get(exportedDialogPath("task-1"))).toContain("Canonical")
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
				{ ts: 11, type: "ask", ask: "command", text: "npm test" },
				{ ts: 12, type: "ask", ask: "command_output", text: "Command output" },
			]),
		)

		const result = await exportAllDialogs(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})

		const markdown = fileSystem.files.get(exportedDialogPath("task-1"))!
		expect(markdown).toContain("messageCount: 9")
		expect(markdown).toMatch(/^contentHash: "[a-f0-9]{64}"$/m)
		expect(markdown).toContain("Visible user task")
		expect(markdown).toContain("Completion")
		expect(markdown).toContain("Subtask")
		expect(markdown).toContain("## user (say:user_feedback)")
		expect(markdown).toContain("Feedback")
		expect(markdown).toContain("Follow-up?")
		expect(markdown).toContain("Completion ask")
		expect(markdown).toContain('{"tool":"readFile","path":"a.ts"}')
		expect(markdown).toContain("## agent_request (ask:command)")
		expect(markdown).toContain("npm test")
		expect(markdown).toContain("## agent_request (ask:command_output)")
		expect(markdown).toContain("Command output")
		expect(markdown).not.toContain("api_req_started")
		expect(markdown).not.toContain("checkpoint_saved")
		expect(markdown).not.toContain("hidden reasoning")
		expect(result).toMatchObject({ total: 1, exported: 1, failed: [] })
	})

	it("skips unchanged existing markdown when message count and content hash match", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([
				{ type: "say", say: "text", text: "Source text" },
				{ type: "say", say: "completion_result", text: "Completion" },
			]),
		)

		const firstResult = await exportAllDialogs(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})
		const firstMarkdown = fileSystem.files.get(exportedDialogPath("task-1"))!

		const result = await exportAllDialogs(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})

		expect(firstResult).toMatchObject({ total: 1, exported: 1, refreshed: 0, skipped: 0, failed: [], warnings: [] })
		expect(result).toMatchObject({ total: 1, exported: 0, refreshed: 0, skipped: 1, failed: [], warnings: [] })
		expect(fileSystem.files.get(exportedDialogPath("task-1"))).toBe(firstMarkdown)
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
		fileSystem.addFile(exportedDialogPath("task-1"), "---\nmessageCount: 1\n---\n\nOld")

		const result = await exportAllDialogs(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})

		expect(result).toMatchObject({ total: 1, exported: 0, refreshed: 1, skipped: 0, failed: [] })
		expect(result.warnings).toEqual([
			{
				taskId: "task-1",
				warning: expect.stringContaining("Cannot parse existing contentHash"),
			},
		])
		expect(fileSystem.files.get(exportedDialogPath("task-1"))).toContain("New text")
		expect(fileSystem.files.get(exportedDialogPath("task-1"))).toContain("messageCount: 2")
		expect(fileSystem.files.get(exportedDialogPath("task-1"))).toMatch(/^contentHash: "[a-f0-9]{64}"$/m)
	})

	it("refreshes existing markdown when message count matches but content hash differs", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ type: "say", say: "text", text: "Changed text" }]),
		)
		fileSystem.addFile(
			exportedDialogPath("task-1"),
			`---\nmessageCount: 1\ncontentHash: "${"0".repeat(64)}"\n---\n\nOld`,
		)

		const result = await exportAllDialogs(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})

		expect(result).toMatchObject({ total: 1, exported: 0, refreshed: 1, skipped: 0, failed: [], warnings: [] })
		expect(fileSystem.files.get(exportedDialogPath("task-1"))).toContain("Changed text")
		expect(fileSystem.files.get(exportedDialogPath("task-1"))).toMatch(/^contentHash: "[a-f0-9]{64}"$/m)
	})

	it("refreshes older existing markdown that has message count but no content hash", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ type: "say", say: "text", text: "Same count" }]),
		)
		fileSystem.addFile(exportedDialogPath("task-1"), "---\nmessageCount: 1\n---\n\nOld")

		const result = await exportAllDialogs(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})

		expect(result.refreshed).toBe(1)
		expect(result.warnings).toEqual([
			{
				taskId: "task-1",
				warning: expect.stringContaining("Cannot parse existing contentHash"),
			},
		])
		expect(fileSystem.files.get(exportedDialogPath("task-1"))).toContain("Same count")
		expect(fileSystem.files.get(exportedDialogPath("task-1"))).toMatch(/^contentHash: "[a-f0-9]{64}"$/m)
	})

	it("refreshes existing markdown with a warning when existing message count is not parseable", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ type: "say", say: "text", text: "New" }]),
		)
		fileSystem.addFile(exportedDialogPath("task-1"), "No frontmatter")

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
			{
				taskId: "task-1",
				warning: expect.stringContaining("Cannot parse existing contentHash"),
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
