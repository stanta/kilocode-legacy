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

const createProvider = (history: HistoryItem[]): AllSessionsExportProvider => ({
	contextProxy: {
		globalStorageUri: {
			fsPath: "/global-storage",
		},
	},
	getTaskHistory: () => history,
})

describe("exportAllSessions", () => {
	const outputDir = "/selected/export"

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
				getStorageBasePath: async (defaultPath) => defaultPath,
			}),
		).rejects.toThrow("Export destination cannot be inside the Kilo Code tasks storage directory")
	})

	it("enumerates the real storage tasks directory and recursively copies raw task directories", async () => {
		const fileSystem = new MemoryFs()
		const firstTask = createHistoryItem({ id: "task-1", task: "First", ts: 2 })
		const secondTask = createHistoryItem({ id: "task-2", task: "Second", ts: 3, workspace: "/other" })
		const provider = createProvider([secondTask, firstTask])

		fileSystem.addFile("/custom-storage/tasks/task-1/api_conversation_history.json", '[{"role":"user"}]')
		fileSystem.addFile("/custom-storage/tasks/task-1/nested/blob.bin", "raw nested content")
		fileSystem.addFile("/custom-storage/tasks/task-2/ui_messages.json", '[{"type":"say"}]')
		fileSystem.addFile("/custom-storage/tasks/task-2/export_complete.json", "legacy marker in source")
		fileSystem.addFile("/custom-storage/tasks/loose-file.txt", "not a directory")

		const result = await exportAllSessions(provider, {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async () => "/custom-storage",
		})

		expect(result).toMatchObject({
			outputDir,
			taskHistoryPath: path.join(outputDir, "task_history.json"),
			manifestPath: path.join(outputDir, "export_manifest.json"),
			storageBasePath: "/custom-storage",
			total: 2,
			exported: 2,
			failed: [],
		})

		const historyJson = JSON.parse(fileSystem.files.get(result.taskHistoryPath)!)
		expect(historyJson.map((item: HistoryItem) => item.id).sort()).toEqual(["task-1", "task-2"])
		expect(fileSystem.files.get(path.join(outputDir, "tasks", "task-1", "api_conversation_history.json"))).toBe(
			'[{"role":"user"}]',
		)
		expect(fileSystem.files.get(path.join(outputDir, "tasks", "task-1", "nested", "blob.bin"))).toBe(
			"raw nested content",
		)
		expect(fileSystem.files.get(path.join(outputDir, "tasks", "task-2", "ui_messages.json"))).toBe(
			'[{"type":"say"}]',
		)
		expect(fileSystem.files.get(path.join(outputDir, "tasks", "task-2", "export_complete.json"))).toBe(
			"legacy marker in source",
		)
	})

	it("does not write export_complete.json into copied raw task directories", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile("/global-storage/tasks/task-1/api_conversation_history.json", "[]")

		const result = await exportAllSessions(createProvider([createHistoryItem({ id: "task-1" })]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})

		expect(fileSystem.files.has(path.join(outputDir, "tasks", "task-1", "export_complete.json"))).toBe(false)
		expect(fileSystem.files.has(result.manifestPath)).toBe(true)
		const manifest = JSON.parse(fileSystem.files.get(result.manifestPath)!)
		expect(manifest).toMatchObject({ total: 1, exported: 1, failed: [] })
	})

	it("handles a missing storage tasks directory as zero exported tasks", async () => {
		const fileSystem = new MemoryFs()
		const provider = createProvider([createHistoryItem({ id: "task-1" })])

		const result = await exportAllSessions(provider, {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async () => "/missing-storage",
		})

		expect(result).toMatchObject({ total: 0, exported: 0, failed: [] })
		expect(JSON.parse(fileSystem.files.get(result.taskHistoryPath)!)).toHaveLength(1)
	})

	it("continues after per-directory copy failures and records them", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile("/global-storage/tasks/task-1/api_conversation_history.json", "task-1")
		fileSystem.addFile("/global-storage/tasks/task-2/api_conversation_history.json", "task-2")
		fileSystem.copyFailures.add("/global-storage/tasks/task-1/api_conversation_history.json")

		const result = await exportAllSessions(createProvider([]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})

		expect(result.exported).toBe(1)
		expect(result.failed).toEqual([
			{ taskId: "task-1", error: "Cannot copy: /global-storage/tasks/task-1/api_conversation_history.json" },
		])
		expect(fileSystem.files.get(path.join(outputDir, "tasks", "task-2", "api_conversation_history.json"))).toBe(
			"task-2",
		)
	})

	it("overwrites existing destination files to refresh a selected export folder", async () => {
		const fileSystem = new MemoryFs()
		fileSystem.addFile("/global-storage/tasks/task-1/api_conversation_history.json", "new")
		fileSystem.addFile(path.join(outputDir, "tasks", "task-1", "api_conversation_history.json"), "old")

		const result = await exportAllSessions(createProvider([]), {
			fs: fileSystem,
			outputDir,
			getStorageBasePath: async (defaultPath) => defaultPath,
		})

		expect(result).toMatchObject({ total: 1, exported: 1, failed: [] })
		expect(fileSystem.files.get(path.join(outputDir, "tasks", "task-1", "api_conversation_history.json"))).toBe(
			"new",
		)
	})
})
