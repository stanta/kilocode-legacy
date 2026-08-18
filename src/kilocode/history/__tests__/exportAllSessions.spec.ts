// kilocode_change - new file
import path from "path"

import type { HistoryItem } from "@roo-code/types"

import { exportAllSessions, type AllSessionsExportProvider, type FileSystemAdapter } from "../exportAllSessions"

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
	public copyFailures = new Set<string>()

	async mkdir(dirPath: string, _options: { recursive: boolean }): Promise<void> {
		this.addDirectory(dirPath)
	}

	async copyFile(src: string, dest: string): Promise<void> {
		if (this.copyFailures.has(src)) {
			throw new Error(`Cannot copy: ${src}`)
		}

		const value = this.files.get(src)

		if (value === undefined) {
			throw new Error(`Missing file: ${src}`)
		}

		this.addDirectory(path.dirname(dest))
		this.files.set(dest, value)
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
		...overrides,
	}) as HistoryItem

const createProvider = (history: HistoryItem[], cwd = "/workspace"): AllSessionsExportProvider => ({
	cwd,
	contextProxy: {
		globalStorageUri: {
			fsPath: "/global-storage",
		},
	},
	getTaskHistory: () => history,
})

const outputDir = "/selected/export"
const exportedTaskDir = (taskId: string, prefix = "01-01-1970_00-00"): string =>
	path.join(outputDir, "tasks", `${prefix}_${taskId}`)

describe("exportAllSessions", () => {
	it("requires an explicit output directory", async () => {
		await expect(exportAllSessions(createProvider([]), { fs: new MemoryFs() })).rejects.toThrow(
			"An output directory is required",
		)
	})

	it("rejects destinations inside the source tasks directory", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile("/global-storage/tasks/task-1/api_conversation_history.json", "[]")

		await expect(
			exportAllSessions(createProvider([]), {
				fs: fileSystem,
				outputDir: "/global-storage/tasks/task-1/export",
				getDialogSessionStoragePaths: async (defaultPath) => ({
					basePath: defaultPath,
					tasksDir: `${defaultPath}/tasks`,
					isProjectLocal: false,
				}),
			}),
		).rejects.toThrow("Export destination cannot be inside the Kilo Code tasks storage directory")
	})

	it("copies only current-project raw task directories and writes current-project task history", async () => {
		const fileSystem = new MemoryFs()
		const firstTask = createHistoryItem({ id: "task-1", task: "First", ts: 2 })
		const secondTask = createHistoryItem({ id: "task-2", task: "Second", ts: 3, workspace: "/other" })
		const provider = createProvider([secondTask, firstTask])

		fileSystem.addFile("/custom-storage/tasks/task-1/api_conversation_history.json", '[{"role":"user"}]')
		fileSystem.addFile("/custom-storage/tasks/task-1/nested/blob.bin", "raw nested content")
		fileSystem.addFile("/custom-storage/tasks/task-1/export_complete.json", "legacy marker in source")
		fileSystem.addFile(
			"/custom-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ type: "say", ts: Date.UTC(2026, 7, 17, 14, 54) }]),
		)
		fileSystem.addFile("/custom-storage/tasks/task-2/ui_messages.json", '[{"type":"say"}]')
		fileSystem.addFile("/custom-storage/tasks/orphan-task/ui_messages.json", '[{"type":"say"}]')
		fileSystem.addFile("/custom-storage/tasks/loose-file.txt", "not a directory")

		const result = await exportAllSessions(provider, {
			fs: fileSystem,
			outputDir,
			getDialogSessionStoragePaths: async () => ({
				basePath: "/custom-storage",
				tasksDir: "/custom-storage/tasks",
				isProjectLocal: false,
			}),
		})

		expect(result).toMatchObject({
			outputDir,
			taskHistoryPath: path.join(outputDir, "task_history.json"),
			manifestPath: path.join(outputDir, "export_manifest.json"),
			storageBasePath: "/custom-storage",
			total: 1,
			exported: 1,
			refreshed: 0,
			skipped: 0,
			failed: [],
			warnings: [],
		})

		const historyJson = JSON.parse(fileSystem.files.get(result.taskHistoryPath)!)
		expect(historyJson.map((item: HistoryItem) => item.id)).toEqual(["task-1"])
		const taskOutputDir = exportedTaskDir("task-1", "17-08-2026_14-54")
		expect(fileSystem.files.get(path.join(taskOutputDir, "api_conversation_history.json"))).toBe(
			'[{"role":"user"}]',
		)
		expect(fileSystem.files.get(path.join(taskOutputDir, "nested", "blob.bin"))).toBe("raw nested content")
		expect(fileSystem.files.get(path.join(taskOutputDir, "export_complete.json"))).toBe("legacy marker in source")
		expect(fileSystem.files.has(path.join(outputDir, "tasks", "task-2", "ui_messages.json"))).toBe(false)
		expect(fileSystem.files.has(path.join(outputDir, "tasks", "orphan-task", "ui_messages.json"))).toBe(false)

		const manifest = JSON.parse(fileSystem.files.get(result.manifestPath)!)
		expect(manifest).toMatchObject({
			scope: "currentProject",
			workspace: "/workspace",
			total: 1,
			exported: 1,
			refreshed: 0,
			skipped: 0,
			failed: [],
			warnings: [],
		})
	})

	it("exports raw task directories from project-local dialog session storage", async () => {
		const fileSystem = new MemoryFs()
		const provider = createProvider([createHistoryItem({ id: "task-1" })])
		fileSystem.addFile("/workspace/.kilo/dialogs/task-1/api_conversation_history.json", "[]")
		fileSystem.addFile("/workspace/.kilo/dialogs/task-1/ui_messages.json", "[]")

		const result = await exportAllSessions(provider, {
			fs: fileSystem,
			outputDir,
			getDialogSessionStoragePaths: async () => ({
				basePath: "/workspace/.kilo/dialogs",
				tasksDir: "/workspace/.kilo/dialogs",
				isProjectLocal: true,
			}),
		})

		expect(result).toMatchObject({
			storageBasePath: "/workspace/.kilo/dialogs",
			total: 1,
			exported: 1,
			failed: [],
		})
		expect(fileSystem.files.get(path.join(exportedTaskDir("task-1"), "api_conversation_history.json"))).toBe("[]")
	})

	it("skips orphan storage task directories not represented in current-project history", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile("/global-storage/tasks/orphan-task/api_conversation_history.json", "orphan")

		const result = await exportAllSessions(createProvider([]), {
			fs: fileSystem,
			outputDir,
			getDialogSessionStoragePaths: async (defaultPath) => ({
				basePath: defaultPath,
				tasksDir: `${defaultPath}/tasks`,
				isProjectLocal: false,
			}),
		})

		expect(result).toMatchObject({ total: 0, exported: 0, refreshed: 0, skipped: 0, failed: [], warnings: [] })
		expect(
			fileSystem.files.has(path.join(outputDir, "tasks", "orphan-task", "api_conversation_history.json")),
		).toBe(false)
		expect(JSON.parse(fileSystem.files.get(result.taskHistoryPath)!)).toEqual([])
	})

	it("does not write export_complete.json into copied raw task directories", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile("/global-storage/tasks/task-1/api_conversation_history.json", "[]")

		const result = await exportAllSessions(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getDialogSessionStoragePaths: async (defaultPath) => ({
				basePath: defaultPath,
				tasksDir: `${defaultPath}/tasks`,
				isProjectLocal: false,
			}),
		})

		expect(fileSystem.files.has(path.join(exportedTaskDir("task-1"), "export_complete.json"))).toBe(false)
		expect(fileSystem.files.has(result.manifestPath)).toBe(true)
		const manifest = JSON.parse(fileSystem.files.get(result.manifestPath)!)
		expect(manifest).toMatchObject({ total: 1, exported: 1, refreshed: 0, skipped: 0, failed: [], warnings: [] })
	})

	it("uses history timestamp fallback in raw exported task directory names", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/ui_messages.json",
			JSON.stringify([{ type: "say", ts: "not numeric" }]),
		)
		fileSystem.addFile("/global-storage/tasks/task-1/api_conversation_history.json", "[]")

		const result = await exportAllSessions(
			createProvider([createHistoryItem({ id: "task-1", ts: Date.UTC(2026, 0, 2, 3, 4) })]),
			{
				fs: fileSystem,
				outputDir,
				getDialogSessionStoragePaths: async (defaultPath) => ({
					basePath: defaultPath,
					tasksDir: `${defaultPath}/tasks`,
					isProjectLocal: false,
				}),
			},
		)

		expect(result).toMatchObject({ total: 1, exported: 1, refreshed: 0, skipped: 0, failed: [], warnings: [] })
		expect(fileSystem.files.has(path.join(exportedTaskDir("task-1", "02-01-2026_03-04"), "ui_messages.json"))).toBe(
			true,
		)
	})

	it("records missing raw task directories for current-project history items", async () => {
		const fileSystem = new MemoryFs()
		const provider = createProvider([createHistoryItem({ id: "task-1" }), createHistoryItem({ id: "task-2" })])
		fileSystem.addFile("/missing-storage/tasks/task-2/api_conversation_history.json", "task-2")

		const result = await exportAllSessions(provider, {
			fs: fileSystem,
			outputDir,
			getDialogSessionStoragePaths: async () => ({
				basePath: "/missing-storage",
				tasksDir: "/missing-storage/tasks",
				isProjectLocal: false,
			}),
		})

		expect(result).toMatchObject({
			total: 2,
			exported: 1,
			refreshed: 0,
			skipped: 0,
			failed: [{ taskId: "task-1", error: "Task directory not found: /missing-storage/tasks/task-1" }],
			warnings: [],
		})
		expect(fileSystem.files.get(path.join(exportedTaskDir("task-2"), "api_conversation_history.json"))).toBe(
			"task-2",
		)
		expect(JSON.parse(fileSystem.files.get(result.taskHistoryPath)!)).toHaveLength(2)
	})

	it("records all current-project history items as missing when the storage tasks directory does not exist", async () => {
		const fileSystem = new MemoryFs()
		const provider = createProvider([createHistoryItem({ id: "task-1" })])

		const result = await exportAllSessions(provider, {
			fs: fileSystem,
			outputDir,
			getDialogSessionStoragePaths: async () => ({
				basePath: "/missing-storage",
				tasksDir: "/missing-storage/tasks",
				isProjectLocal: false,
			}),
		})

		expect(result).toMatchObject({
			total: 1,
			exported: 0,
			refreshed: 0,
			skipped: 0,
			failed: [{ taskId: "task-1", error: "Task directory not found: /missing-storage/tasks/task-1" }],
			warnings: [],
		})
		expect(JSON.parse(fileSystem.files.get(result.taskHistoryPath)!)).toHaveLength(1)
	})

	it("continues after per-directory copy failures and records them", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile("/global-storage/tasks/task-1/api_conversation_history.json", "task-1")
		fileSystem.addFile("/global-storage/tasks/task-2/api_conversation_history.json", "task-2")
		fileSystem.copyFailures.add("/global-storage/tasks/task-1/api_conversation_history.json")

		const result = await exportAllSessions(
			createProvider([createHistoryItem({ id: "task-1" }), createHistoryItem({ id: "task-2" })]),
			{
				fs: fileSystem,
				outputDir,
				getDialogSessionStoragePaths: async (defaultPath) => ({
					basePath: defaultPath,
					tasksDir: `${defaultPath}/tasks`,
					isProjectLocal: false,
				}),
			},
		)

		expect(result.exported).toBe(1)
		expect(result.failed).toEqual([
			{ taskId: "task-1", error: "Cannot copy: /global-storage/tasks/task-1/api_conversation_history.json" },
		])
		expect(fileSystem.files.get(path.join(exportedTaskDir("task-2"), "api_conversation_history.json"))).toBe(
			"task-2",
		)
	})

	it("skips an existing destination task directory when ui message counts are unchanged", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile("/global-storage/tasks/task-1/ui_messages.json", '[{"type":"say"},{"type":"ask"}]')
		fileSystem.addFile("/global-storage/tasks/task-1/api_conversation_history.json", '[{"role":"user"}]')
		fileSystem.addFile(path.join(exportedTaskDir("task-1"), "ui_messages.json"), '[{"stale":true},{"stale":true}]')
		fileSystem.addFile(path.join(exportedTaskDir("task-1"), "api_conversation_history.json"), '[{"stale":true}]')
		fileSystem.addFile(path.join(exportedTaskDir("task-1"), "nested", "blob.bin"), "old nested content")

		const result = await exportAllSessions(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getDialogSessionStoragePaths: async (defaultPath) => ({
				basePath: defaultPath,
				tasksDir: `${defaultPath}/tasks`,
				isProjectLocal: false,
			}),
		})

		expect(result).toMatchObject({ total: 1, exported: 0, refreshed: 0, skipped: 1, failed: [], warnings: [] })
		expect(fileSystem.files.get(path.join(exportedTaskDir("task-1"), "ui_messages.json"))).toBe(
			'[{"stale":true},{"stale":true}]',
		)
		expect(fileSystem.files.get(path.join(exportedTaskDir("task-1"), "nested", "blob.bin"))).toBe(
			"old nested content",
		)
	})

	it("refreshes an existing destination task directory when source ui messages have a different length", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile("/global-storage/tasks/task-1/ui_messages.json", '[{"type":"say"},{"type":"ask"}]')
		fileSystem.addFile("/global-storage/tasks/task-1/nested/blob.bin", "new nested content")
		fileSystem.addFile(path.join(exportedTaskDir("task-1"), "ui_messages.json"), '[{"type":"say"}]')
		fileSystem.addFile(path.join(exportedTaskDir("task-1"), "nested", "blob.bin"), "old nested content")

		const result = await exportAllSessions(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getDialogSessionStoragePaths: async (defaultPath) => ({
				basePath: defaultPath,
				tasksDir: `${defaultPath}/tasks`,
				isProjectLocal: false,
			}),
		})

		expect(result).toMatchObject({ total: 1, exported: 0, refreshed: 1, skipped: 0, failed: [], warnings: [] })
		expect(fileSystem.files.get(path.join(exportedTaskDir("task-1"), "ui_messages.json"))).toBe(
			'[{"type":"say"},{"type":"ask"}]',
		)
		expect(fileSystem.files.get(path.join(exportedTaskDir("task-1"), "nested", "blob.bin"))).toBe(
			"new nested content",
		)
	})

	it("falls back to api conversation history counts when ui messages are missing", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile(
			"/global-storage/tasks/task-1/api_conversation_history.json",
			'[{"role":"user"},{"role":"assistant"}]',
		)
		fileSystem.addFile(path.join(exportedTaskDir("task-1"), "api_conversation_history.json"), '[{"role":"user"}]')

		const result = await exportAllSessions(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getDialogSessionStoragePaths: async (defaultPath) => ({
				basePath: defaultPath,
				tasksDir: `${defaultPath}/tasks`,
				isProjectLocal: false,
			}),
		})

		expect(result).toMatchObject({ total: 1, exported: 0, refreshed: 1, skipped: 0, failed: [], warnings: [] })
		expect(fileSystem.files.get(path.join(exportedTaskDir("task-1"), "api_conversation_history.json"))).toBe(
			'[{"role":"user"},{"role":"assistant"}]',
		)
	})

	it("does not touch existing destination dirs for tasks outside the current project", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile("/global-storage/tasks/task-1/ui_messages.json", '[{"type":"say"}]')
		fileSystem.addFile("/global-storage/tasks/task-2/ui_messages.json", '[{"type":"say"},{"type":"ask"}]')
		fileSystem.addFile(
			path.join(outputDir, "tasks", "task-2", "ui_messages.json"),
			"existing other workspace content",
		)
		fileSystem.addFile(path.join(outputDir, "tasks", "task-2", "nested", "blob.bin"), "existing nested content")

		const result = await exportAllSessions(
			createProvider([
				createHistoryItem({ id: "task-1", workspace: "/workspace" }),
				createHistoryItem({ id: "task-2", workspace: "/other" }),
			]),
			{
				fs: fileSystem,
				outputDir,
				getDialogSessionStoragePaths: async (defaultPath) => ({
					basePath: defaultPath,
					tasksDir: `${defaultPath}/tasks`,
					isProjectLocal: false,
				}),
			},
		)

		expect(result).toMatchObject({ total: 1, exported: 1, refreshed: 0, skipped: 0, failed: [], warnings: [] })
		expect(fileSystem.files.get(path.join(exportedTaskDir("task-1"), "ui_messages.json"))).toBe('[{"type":"say"}]')
		expect(fileSystem.files.get(path.join(outputDir, "tasks", "task-2", "ui_messages.json"))).toBe(
			"existing other workspace content",
		)
		expect(fileSystem.files.get(path.join(outputDir, "tasks", "task-2", "nested", "blob.bin"))).toBe(
			"existing nested content",
		)
	})

	it("skips existing destination task dirs with no parseable message arrays and records a warning", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile("/global-storage/tasks/task-1/ui_messages.json", '{"not":"array"}')
		fileSystem.addFile("/global-storage/tasks/task-1/api_conversation_history.json", "invalid json")
		fileSystem.addFile(path.join(exportedTaskDir("task-1"), "ui_messages.json"), '{"not":"array"}')
		fileSystem.addFile(path.join(exportedTaskDir("task-1"), "api_conversation_history.json"), "invalid json")

		const result = await exportAllSessions(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getDialogSessionStoragePaths: async (defaultPath) => ({
				basePath: defaultPath,
				tasksDir: `${defaultPath}/tasks`,
				isProjectLocal: false,
			}),
		})

		expect(result).toMatchObject({ total: 1, exported: 0, refreshed: 0, skipped: 1, failed: [] })
		expect(result.warnings).toEqual([
			{ taskId: "task-1", warning: "source ui_messages.json is not a JSON array" },
			{ taskId: "task-1", warning: expect.stringContaining("Cannot parse source api_conversation_history.json") },
			{ taskId: "task-1", warning: "destination ui_messages.json is not a JSON array" },
			{
				taskId: "task-1",
				warning: expect.stringContaining("Cannot parse destination api_conversation_history.json"),
			},
			{
				taskId: "task-1",
				warning:
					"No parseable message arrays found in ui_messages.json or api_conversation_history.json; skipped existing destination task directory",
			},
		])

		const manifest = JSON.parse(fileSystem.files.get(result.manifestPath)!)
		expect(manifest).toMatchObject({ total: 1, exported: 0, refreshed: 0, skipped: 1, failed: [] })
		expect(manifest.warnings).toEqual(result.warnings)
	})
})
