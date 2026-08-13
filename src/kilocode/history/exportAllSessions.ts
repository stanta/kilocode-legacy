// kilocode_change - new file
import fs from "fs/promises"
import path from "path"

import type { HistoryItem } from "@roo-code/types"

import { getStorageBasePath } from "../../utils/storage"

/**
 * The subset of {@link ClineProvider} needed to export every stored session.
 * `ClineProvider` satisfies this interface structurally, so the provider can be
 * passed directly.
 */
export interface AllSessionsExportProvider {
	contextProxy: {
		globalStorageUri: {
			fsPath: string
		}
	}
	getTaskHistory(): HistoryItem[]
}

export interface ExportAllSessionsResult {
	outputDir: string
	taskHistoryPath: string
	manifestPath: string
	storageBasePath: string
	total: number
	exported: number
	failed: Array<{ taskId: string; error: string }>
}

interface DirectoryEntry {
	name: string
	isDirectory(): boolean
	isFile(): boolean
}

export interface FileSystemAdapter {
	mkdir(path: string, options: { recursive: boolean }): Promise<void>
	copyFile(src: string, dest: string): Promise<void>
	writeFile(path: string, data: string, encoding: "utf8"): Promise<void>
	readdir(path: string, options: { withFileTypes: true }): Promise<DirectoryEntry[]>
}

export interface ExportAllSessionsOptions {
	fs?: FileSystemAdapter
	outputDir?: string
	getStorageBasePath?: (defaultPath: string) => Promise<string>
}

const defaultFs: FileSystemAdapter = {
	mkdir: (dirPath, options) => fs.mkdir(dirPath, options).then(() => undefined),
	copyFile: (src, dest) => fs.copyFile(src, dest),
	writeFile: (filePath, data, encoding) => fs.writeFile(filePath, data, encoding),
	readdir: (dirPath, options) => fs.readdir(dirPath, options),
}

/**
 * Exports all Kilo Code sessions.
 *
 * The full task history index is written to `task_history.json` from global
 * state, and every directory under the real storage `tasks/` directory is
 * recursively copied into `tasks/<taskDirName>/` in the caller-selected export
 * destination. Existing files at the destination are overwritten by the
 * recursive copy so rerunning the export refreshes the selected folder.
 */
export async function exportAllSessions(
	provider: AllSessionsExportProvider,
	options: ExportAllSessionsOptions = {},
): Promise<ExportAllSessionsResult> {
	const fileSystem = options.fs ?? defaultFs
	const resolveStorageBasePath = options.getStorageBasePath ?? getStorageBasePath

	if (!options.outputDir) {
		throw new Error("An output directory is required to export all Kilo Code sessions")
	}

	const outputDir = options.outputDir
	const taskHistoryPath = path.join(outputDir, "task_history.json")
	const manifestPath = path.join(outputDir, "export_manifest.json")
	const storageBasePath = await resolveStorageBasePath(provider.contextProxy.globalStorageUri.fsPath)
	const sourceTasksDir = path.join(storageBasePath, "tasks")
	const destinationTasksDir = path.join(outputDir, "tasks")

	assertExportDestinationIsSafe(sourceTasksDir, destinationTasksDir)

	await fileSystem.mkdir(destinationTasksDir, { recursive: true })

	// Export the complete task history index from global state. This includes
	// every session across all workspaces, matching what the extension stores.
	const history = provider.getTaskHistory()
	await fileSystem.writeFile(taskHistoryPath, JSON.stringify(history, null, 2), "utf8")

	const taskDirectories = await readTaskDirectories(fileSystem, sourceTasksDir)

	const result: ExportAllSessionsResult = {
		outputDir,
		taskHistoryPath,
		manifestPath,
		storageBasePath,
		total: taskDirectories.length,
		exported: 0,
		failed: [],
	}

	for (const taskDirName of taskDirectories) {
		try {
			await copyDirectoryRecursive(
				fileSystem,
				path.join(sourceTasksDir, taskDirName),
				path.join(destinationTasksDir, taskDirName),
			)
			result.exported++
		} catch (error) {
			result.failed.push({ taskId: taskDirName, error: error instanceof Error ? error.message : String(error) })
		}
	}

	await fileSystem.writeFile(
		manifestPath,
		JSON.stringify(
			{
				exportedAt: new Date().toISOString(),
				storageBasePath,
				sourceTasksDir,
				outputDir,
				total: result.total,
				exported: result.exported,
				failed: result.failed,
			},
			null,
			2,
		),
		"utf8",
	)

	return result
}

async function readTaskDirectories(fileSystem: FileSystemAdapter, sourceTasksDir: string): Promise<string[]> {
	try {
		const entries = await fileSystem.readdir(sourceTasksDir, { withFileTypes: true })
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b))
	} catch (error) {
		if (isMissingPathError(error)) {
			return []
		}

		throw error
	}
}

async function copyDirectoryRecursive(
	fileSystem: FileSystemAdapter,
	sourceDir: string,
	destinationDir: string,
): Promise<void> {
	await fileSystem.mkdir(destinationDir, { recursive: true })

	const entries = await fileSystem.readdir(sourceDir, { withFileTypes: true })

	for (const entry of entries) {
		const sourcePath = path.join(sourceDir, entry.name)
		const destinationPath = path.join(destinationDir, entry.name)

		if (entry.isDirectory()) {
			await copyDirectoryRecursive(fileSystem, sourcePath, destinationPath)
		} else if (entry.isFile()) {
			await fileSystem.copyFile(sourcePath, destinationPath)
		}
	}
}

function isMissingPathError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false
	}

	return "code" in error && error.code === "ENOENT"
}

function assertExportDestinationIsSafe(sourceTasksDir: string, destinationTasksDir: string): void {
	const normalizedSourceTasksDir = path.resolve(sourceTasksDir)
	const normalizedDestinationTasksDir = path.resolve(destinationTasksDir)

	if (
		normalizedDestinationTasksDir === normalizedSourceTasksDir ||
		normalizedDestinationTasksDir.startsWith(`${normalizedSourceTasksDir}${path.sep}`)
	) {
		throw new Error("Export destination cannot be inside the Kilo Code tasks storage directory")
	}
}
