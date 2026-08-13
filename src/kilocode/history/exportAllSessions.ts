// kilocode_change - new file
import fs from "fs/promises"
import path from "path"

import type { HistoryItem } from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { safeTaskId } from "./exportDialogHistory"

/**
 * The subset of {@link ClineProvider} needed to export every stored session.
 * `ClineProvider` satisfies this interface structurally, so the provider can be
 * passed directly.
 */
export interface AllSessionsExportProvider {
	cwd: string
	getTaskHistory(): HistoryItem[]
	getTaskWithId(
		id: string,
		withMessage?: boolean,
	): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
	}>
}

export interface ExportAllSessionsResult {
	outputDir: string
	taskHistoryPath: string
	total: number
	exported: number
	skipped: number
	failed: Array<{ taskId: string; error: string }>
}

interface FileSystemAdapter {
	mkdir(path: string, options: { recursive: boolean }): Promise<void>
	copyFile(src: string, dest: string): Promise<void>
	writeFile(path: string, data: string, encoding: "utf8"): Promise<void>
	access(path: string): Promise<void>
}

interface ExportAllSessionsOptions {
	fs?: FileSystemAdapter
	outputDir?: string
}

/**
 * The raw per-session files that are copied verbatim during export. These are
 * the exact on-disk files used by the extension to persist each task, so the
 * export preserves them byte-for-byte without any transformation.
 */
const RAW_TASK_FILES = [
	GlobalFileNames.apiConversationHistory,
	GlobalFileNames.uiMessages,
	GlobalFileNames.taskMetadata,
]

const EXPORT_COMPLETE_FILE = "export_complete.json"

const defaultFs: FileSystemAdapter = {
	mkdir: (dirPath, options) => fs.mkdir(dirPath, options).then(() => undefined),
	copyFile: (src, dest) => fs.copyFile(src, dest),
	writeFile: (filePath, data, encoding) => fs.writeFile(filePath, data, encoding),
	access: (filePath) => fs.access(filePath),
}

/**
 * Exports all Kilo Code sessions.
 *
 * The full task history index is written to `task_history.json` from global
 * state, and each session's raw on-disk files are copied verbatim into a
 * `tasks/<taskId>/` subdirectory. Existing exports are never overwritten.
 */
export async function exportAllSessions(
	provider: AllSessionsExportProvider,
	options: ExportAllSessionsOptions = {},
): Promise<ExportAllSessionsResult> {
	const fileSystem = options.fs ?? defaultFs
	const outputDir = options.outputDir ?? path.join(provider.cwd, ".kilo", "history", "sessions")
	const taskHistoryPath = path.join(outputDir, "task_history.json")

	await fileSystem.mkdir(outputDir, { recursive: true })

	// Export the complete task history index from global state. This includes
	// every session across all workspaces, matching what the extension stores.
	const history = provider.getTaskHistory()
	await fileSystem.writeFile(taskHistoryPath, JSON.stringify(history, null, 2), "utf8")

	const tasks = history
		.filter((item): item is HistoryItem & { id: string } => Boolean(item.id))
		.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))

	const result: ExportAllSessionsResult = {
		outputDir,
		taskHistoryPath,
		total: tasks.length,
		exported: 0,
		skipped: 0,
		failed: [],
	}

	for (const task of tasks) {
		const taskOutputDir = path.join(outputDir, "tasks", outputTaskDirName(task.id))
		const completionPath = path.join(taskOutputDir, EXPORT_COMPLETE_FILE)

		// Never overwrite a completed session export.
		if (await pathExists(fileSystem, completionPath)) {
			result.skipped++
			continue
		}

		try {
			const { taskDirPath } = await provider.getTaskWithId(task.id, false)
			let copied = false

			for (const fileName of RAW_TASK_FILES) {
				const srcPath = path.join(taskDirPath, fileName)

				if (!(await pathExists(fileSystem, srcPath))) {
					continue
				}

				if (!copied) {
					await fileSystem.mkdir(taskOutputDir, { recursive: true })
				}

				await fileSystem.copyFile(srcPath, path.join(taskOutputDir, fileName))
				copied = true
			}

			if (copied) {
				await fileSystem.writeFile(
					completionPath,
					JSON.stringify(
						{ taskId: task.id, exportedAt: new Date().toISOString(), files: RAW_TASK_FILES },
						null,
						2,
					),
					"utf8",
				)
				result.exported++
			} else {
				result.failed.push({ taskId: task.id, error: "No raw session files found" })
			}
		} catch (error) {
			result.failed.push({ taskId: task.id, error: error instanceof Error ? error.message : String(error) })
		}
	}

	return result
}

function outputTaskDirName(taskId: string): string {
	return `${safeTaskId(taskId)}-${Buffer.from(taskId).toString("base64url")}`
}

async function pathExists(fileSystem: FileSystemAdapter, targetPath: string): Promise<boolean> {
	try {
		await fileSystem.access(targetPath)
		return true
	} catch {
		return false
	}
}
