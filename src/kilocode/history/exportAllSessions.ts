// kilocode_change - new file
import fs from "fs/promises"
import path from "path"

import type { HistoryItem, SessionRuntimeConfig, SessionRuntimeModeBinding } from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getDialogSessionStoragePaths } from "../../utils/storage"
import { getExportDatePrefix, getSafeTaskId } from "./exportNames"

/**
 * The subset of {@link ClineProvider} needed to export every stored session.
 * `ClineProvider` satisfies this interface structurally, so the provider can be
 * passed directly.
 */
export interface AllSessionsExportProvider {
	cwd: string
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
	refreshed: number
	skipped: number
	failed: Array<{ taskId: string; error: string }>
	warnings: Array<{ taskId: string; warning: string }>
}

interface DirectoryEntry {
	name: string
	isDirectory(): boolean
	isFile(): boolean
}

export interface FileSystemAdapter {
	mkdir(path: string, options: { recursive: boolean }): Promise<void>
	copyFile(src: string, dest: string): Promise<void>
	readFile(path: string, encoding: "utf8"): Promise<string>
	writeFile(path: string, data: string, encoding: "utf8"): Promise<void>
	readdir(path: string, options: { withFileTypes: true }): Promise<DirectoryEntry[]>
}

export interface ExportAllSessionsOptions {
	fs?: FileSystemAdapter
	outputDir?: string
	getDialogSessionStoragePaths?: typeof getDialogSessionStoragePaths
}

const defaultFs: FileSystemAdapter = {
	mkdir: (dirPath, options) => fs.mkdir(dirPath, options).then(() => undefined),
	copyFile: (src, dest) => fs.copyFile(src, dest),
	readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
	writeFile: (filePath, data, encoding) => fs.writeFile(filePath, data, encoding),
	readdir: (dirPath, options) => fs.readdir(dirPath, options),
}

type MessageHistoryFile = "uiMessages" | "apiConversationHistory"

type MessageCountResult = Partial<Record<MessageHistoryFile, number>>

type SanitizedSessionRuntimeModeBinding = Omit<SessionRuntimeModeBinding, "apiConfiguration">

type SanitizedSessionRuntimeConfig = Omit<SessionRuntimeConfig, "modeBindings"> & {
	modeBindings?: Record<string, SanitizedSessionRuntimeModeBinding>
}

type SanitizedHistoryItem = Omit<HistoryItem, "sessionRuntimeConfig"> & {
	sessionRuntimeConfig?: SanitizedSessionRuntimeConfig
}

interface MessageCountComparison {
	shouldRefresh: boolean
	warnings: string[]
}

/**
 * Exports all Kilo Code sessions for the current project.
 *
 * The current project's task history index is written to `task_history.json`
 * from global state, and every matching directory under the real storage
 * `tasks/` directory is recursively copied into `tasks/<taskDirName>/` in the
 * caller-selected export destination. Existing task directories are only
 * refreshed when parseable source and destination message counts differ, so
 * rerunning the export skips unchanged dialogs instead of overwriting them.
 */
export async function exportAllSessions(
	provider: AllSessionsExportProvider,
	options: ExportAllSessionsOptions = {},
): Promise<ExportAllSessionsResult> {
	const fileSystem = options.fs ?? defaultFs
	const resolveStoragePaths = options.getDialogSessionStoragePaths ?? getDialogSessionStoragePaths

	if (!options.outputDir) {
		throw new Error("An output directory is required to export current project Kilo Code sessions")
	}

	const outputDir = options.outputDir
	const taskHistoryPath = path.join(outputDir, "task_history.json")
	const manifestPath = path.join(outputDir, "export_manifest.json")
	const storagePaths = await resolveStoragePaths(provider.contextProxy.globalStorageUri.fsPath, {
		workspaceRoot: provider.cwd,
	})
	const storageBasePath = storagePaths.basePath
	const sourceTasksDir = storagePaths.tasksDir
	const destinationTasksDir = path.join(outputDir, "tasks")

	assertExportDestinationIsSafe(sourceTasksDir, destinationTasksDir)

	await fileSystem.mkdir(destinationTasksDir, { recursive: true })

	const history = provider.getTaskHistory()
	const currentProjectHistory = history.filter((item): item is HistoryItem & { id: string } => {
		return Boolean(item.id && typeof item.workspace === "string" && item.workspace === provider.cwd)
	})
	const currentProjectTaskIds = [...new Set(currentProjectHistory.map((item) => item.id))].sort((a, b) =>
		a.localeCompare(b),
	)
	const historyByTaskId = new Map(currentProjectHistory.map((item) => [item.id, item]))
	const sanitizedHistory = currentProjectHistory.map(sanitizeHistoryItem)

	await fileSystem.writeFile(taskHistoryPath, JSON.stringify(sanitizedHistory, null, 2), "utf8")

	const taskDirectories = new Set(await readTaskDirectories(fileSystem, sourceTasksDir))

	const result: ExportAllSessionsResult = {
		outputDir,
		taskHistoryPath,
		manifestPath,
		storageBasePath,
		total: currentProjectTaskIds.length,
		exported: 0,
		refreshed: 0,
		skipped: 0,
		failed: [],
		warnings: [],
	}

	for (const taskDirName of currentProjectTaskIds) {
		const historyItem = historyByTaskId.get(taskDirName)
		const sourceTaskDir = path.join(sourceTasksDir, taskDirName)
		const uiMessagesPath = path.join(sourceTaskDir, GlobalFileNames.uiMessages)

		if (!historyItem) {
			result.failed.push({ taskId: taskDirName, error: "Task history item not found" })
			continue
		}

		const exportDatePrefix = await getExportDatePrefix({
			fileSystem,
			uiMessagesPath,
			historyTimestamp: historyItem.ts,
		})
		const destinationTaskDir = path.join(destinationTasksDir, `${exportDatePrefix}_${getSafeTaskId(taskDirName)}`)

		if (!taskDirectories.has(taskDirName)) {
			result.failed.push({
				taskId: taskDirName,
				error: `Task directory not found: ${sourceTaskDir}`,
			})
			continue
		}

		try {
			const existingDestinationTaskDir = await findExistingDestinationTaskDir({
				fileSystem,
				destinationTasksDir,
				destinationTaskDir,
				taskDirName,
			})

			if (existingDestinationTaskDir === undefined) {
				await copyDirectoryRecursive(fileSystem, sourceTaskDir, destinationTaskDir)
				result.exported++
				continue
			}

			const comparison = await compareTaskMessageCounts(fileSystem, sourceTaskDir, existingDestinationTaskDir)

			for (const warning of comparison.warnings) {
				result.warnings.push({ taskId: taskDirName, warning })
			}

			if (comparison.shouldRefresh || existingDestinationTaskDir !== destinationTaskDir) {
				await copyDirectoryRecursive(fileSystem, sourceTaskDir, destinationTaskDir)
				result.refreshed++
			} else {
				result.skipped++
			}
		} catch (error) {
			result.failed.push({ taskId: taskDirName, error: error instanceof Error ? error.message : String(error) })
		}
	}

	await fileSystem.writeFile(
		manifestPath,
		JSON.stringify(
			{
				exportedAt: new Date().toISOString(),
				scope: "currentProject",
				workspace: provider.cwd,
				storageBasePath,
				sourceTasksDir,
				outputDir,
				total: result.total,
				exported: result.exported,
				refreshed: result.refreshed,
				skipped: result.skipped,
				failed: result.failed,
				warnings: result.warnings,
			},
			null,
			2,
		),
		"utf8",
	)

	return result
}

function sanitizeHistoryItem(item: HistoryItem): SanitizedHistoryItem {
	const { sessionRuntimeConfig, ...historyItem } = item

	if (!sessionRuntimeConfig) {
		return historyItem
	}

	const modeBindings = sessionRuntimeConfig.modeBindings
		? Object.fromEntries(
				Object.entries(sessionRuntimeConfig.modeBindings).map(([mode, binding]) => {
					const { apiConfiguration: _apiConfiguration, ...safeBinding } = binding
					return [mode, safeBinding]
				}),
			)
		: undefined

	return {
		...historyItem,
		sessionRuntimeConfig: {
			...sessionRuntimeConfig,
			modeBindings,
		},
	}
}

async function directoryExists(fileSystem: FileSystemAdapter, dirPath: string): Promise<boolean> {
	try {
		await fileSystem.readdir(dirPath, { withFileTypes: true })
		return true
	} catch (error) {
		if (isMissingPathError(error)) {
			return false
		}

		throw error
	}
}

async function findExistingDestinationTaskDir({
	fileSystem,
	destinationTasksDir,
	destinationTaskDir,
	taskDirName,
}: {
	fileSystem: FileSystemAdapter
	destinationTasksDir: string
	destinationTaskDir: string
	taskDirName: string
}): Promise<string | undefined> {
	if (await directoryExists(fileSystem, destinationTaskDir)) {
		return destinationTaskDir
	}

	const legacyDestinationTaskDir = path.join(destinationTasksDir, taskDirName)

	if (await directoryExists(fileSystem, legacyDestinationTaskDir)) {
		return legacyDestinationTaskDir
	}

	return undefined
}

async function compareTaskMessageCounts(
	fileSystem: FileSystemAdapter,
	sourceTaskDir: string,
	destinationTaskDir: string,
): Promise<MessageCountComparison> {
	const source = await readTaskMessageCounts(fileSystem, sourceTaskDir, "source")
	const destination = await readTaskMessageCounts(fileSystem, destinationTaskDir, "destination")
	const comparableFiles = messageHistoryFiles.filter(
		(file) => source.counts[file.key] !== undefined && destination.counts[file.key] !== undefined,
	)
	const shouldRefresh = comparableFiles.some((file) => source.counts[file.key] !== destination.counts[file.key])
	const warnings = [...source.warnings, ...destination.warnings]

	if (comparableFiles.length === 0) {
		warnings.push(
			`No parseable message arrays found in ${GlobalFileNames.uiMessages} or ${GlobalFileNames.apiConversationHistory}; skipped existing destination task directory`,
		)
	}

	return { shouldRefresh, warnings }
}

const messageHistoryFiles: Array<{ key: MessageHistoryFile; fileName: string }> = [
	{ key: "uiMessages", fileName: GlobalFileNames.uiMessages },
	{ key: "apiConversationHistory", fileName: GlobalFileNames.apiConversationHistory },
]

async function readTaskMessageCounts(
	fileSystem: FileSystemAdapter,
	taskDir: string,
	label: "source" | "destination",
): Promise<{ counts: MessageCountResult; warnings: string[] }> {
	const counts: MessageCountResult = {}
	const warnings: string[] = []

	for (const file of messageHistoryFiles) {
		const filePath = path.join(taskDir, file.fileName)

		try {
			const rawMessages = await fileSystem.readFile(filePath, "utf8")
			const parsedMessages = JSON.parse(rawMessages) as unknown

			if (Array.isArray(parsedMessages)) {
				counts[file.key] = parsedMessages.length
			} else {
				warnings.push(`${label} ${file.fileName} is not a JSON array`)
			}
		} catch (error) {
			if (!isMissingPathError(error)) {
				warnings.push(
					`Cannot parse ${label} ${file.fileName}: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}

	return { counts, warnings }
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
