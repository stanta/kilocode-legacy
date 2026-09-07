// kilocode_change - new file
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"

import type { HistoryItem } from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getDialogSessionStoragePaths } from "../../utils/storage"
import { getExportDatePrefix, getSafeTaskId } from "./exportNames"

export interface AllDialogsExportProvider {
	cwd: string
	contextProxy: {
		globalStorageUri: {
			fsPath: string
		}
	}
	getTaskHistory(): HistoryItem[]
}

export interface ExportAllDialogsResult {
	outputDir: string
	dialogsDir: string
	manifestPath: string
	taskHistoryPath: string
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
	readFile(path: string, encoding: "utf8"): Promise<string>
	writeFile(path: string, data: string, encoding: "utf8"): Promise<void>
	readdir(path: string, options: { withFileTypes: true }): Promise<DirectoryEntry[]>
	realpath?(path: string): Promise<string>
}

export interface ExportAllDialogsOptions {
	fs?: FileSystemAdapter
	outputDir?: string
	getDialogSessionStoragePaths?: typeof getDialogSessionStoragePaths
}

export interface TextDialogMessage {
	role: "agent" | "agent_request" | "user"
	type: "say" | "ask"
	kind: string
	text: string
	ts?: number
}

type SanitizedTaskHistoryItem = Pick<
	HistoryItem,
	| "id"
	| "number"
	| "ts"
	| "task"
	| "tokensIn"
	| "tokensOut"
	| "totalCost"
	| "workspace"
	| "mode"
	| "toolProtocol"
	| "apiConfigName"
	| "status"
>

const defaultFs: FileSystemAdapter = {
	mkdir: (dirPath, options) => fs.mkdir(dirPath, options).then(() => undefined),
	readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
	writeFile: (filePath, data, encoding) => fs.writeFile(filePath, data, encoding),
	readdir: (dirPath, options) => fs.readdir(dirPath, options),
	realpath: (filePath) => fs.realpath(filePath),
}

const includedSayKinds = new Set(["text", "completion_result", "subtask_result", "user_feedback"])
const includedAskKinds = new Set(["followup", "completion_result", "tool", "command", "command_output"])

/**
 * Exports text-only dialogs for current-project Kilo Code tasks.
 *
 * Unlike raw session export, this writes one Markdown dialog per task from
 * `ui_messages.json`, excluding internal API/checkpoint/reasoning noise and
 * skipping unchanged files by comparing extracted text message counts and a content hash.
 */
export async function exportAllDialogs(
	provider: AllDialogsExportProvider,
	options: ExportAllDialogsOptions = {},
): Promise<ExportAllDialogsResult> {
	const fileSystem = options.fs ?? defaultFs
	const resolveStoragePaths = options.getDialogSessionStoragePaths ?? getDialogSessionStoragePaths

	if (!options.outputDir) {
		throw new Error("An output directory is required to export current project Kilo Code text dialogs")
	}

	const outputDir = options.outputDir
	const dialogsDir = path.join(outputDir, "dialogs")
	const manifestPath = path.join(outputDir, "dialogs_manifest.json")
	const taskHistoryPath = path.join(outputDir, "dialogs_task_history.json")
	const storagePaths = await resolveStoragePaths(provider.contextProxy.globalStorageUri.fsPath, {
		workspaceRoot: provider.cwd,
	})
	const storageBasePath = storagePaths.basePath
	const sourceTasksDir = storagePaths.tasksDir

	assertExportDestinationIsSafe(sourceTasksDir, dialogsDir)

	await fileSystem.mkdir(dialogsDir, { recursive: true })

	const history = provider.getTaskHistory()
	const currentProjectHistory: Array<HistoryItem & { id: string }> = []

	for (const item of history) {
		if (
			item.id &&
			typeof item.workspace === "string" &&
			(await isSameWorkspace(fileSystem, item.workspace, provider.cwd))
		) {
			currentProjectHistory.push(item as HistoryItem & { id: string })
		}
	}
	const currentProjectTaskIds = [...new Set(currentProjectHistory.map((item) => item.id))].sort((a, b) =>
		a.localeCompare(b),
	)
	const historyByTaskId = new Map(currentProjectHistory.map((item) => [item.id, item]))
	const sanitizedHistory = currentProjectHistory.map(sanitizeTaskHistoryItem)

	await fileSystem.writeFile(taskHistoryPath, JSON.stringify(sanitizedHistory, null, 2), "utf8")

	const result: ExportAllDialogsResult = {
		outputDir,
		dialogsDir,
		manifestPath,
		taskHistoryPath,
		storageBasePath,
		total: currentProjectTaskIds.length,
		exported: 0,
		refreshed: 0,
		skipped: 0,
		failed: [],
		warnings: [],
	}

	const taskDirectories = new Set(await readTaskDirectories(fileSystem, sourceTasksDir))

	for (const taskId of currentProjectTaskIds) {
		const historyItem = historyByTaskId.get(taskId)
		const sourceTaskDir = path.join(sourceTasksDir, taskId)
		const uiMessagesPath = path.join(sourceTaskDir, GlobalFileNames.uiMessages)

		if (!historyItem) {
			result.failed.push({ taskId, error: "Task history item not found" })
			continue
		}

		const exportDatePrefix = await getExportDatePrefix({
			fileSystem,
			uiMessagesPath,
			historyTimestamp: historyItem.ts,
		})
		const outputPath = path.join(dialogsDir, `${exportDatePrefix}_${getSafeTaskId(taskId)}.md`)

		if (!taskDirectories.has(taskId)) {
			result.failed.push({ taskId, error: `Task directory not found: ${sourceTaskDir}` })
			continue
		}

		try {
			const uiMessages = await readJsonArray(fileSystem, uiMessagesPath)
			const messages = extractTextDialogMessages(uiMessages)
			const contentHash = getTextDialogContentHash(messages)
			const markdown = renderTextDialogMarkdown({ historyItem, messages, contentHash })
			const existingOutputPath = await findExistingDialogOutputPath({
				fileSystem,
				dialogsDir,
				outputPath,
				taskId,
			})
			const existingMetadata =
				existingOutputPath === undefined
					? undefined
					: await readExistingExportMetadata(fileSystem, existingOutputPath)

			if (existingMetadata === undefined) {
				await fileSystem.writeFile(outputPath, markdown, "utf8")
				result.exported++
				continue
			}

			for (const warning of existingMetadata.warnings) {
				result.warnings.push({ taskId, warning })
			}

			if (
				existingMetadata.messageCount !== messages.length ||
				existingMetadata.contentHash !== contentHash ||
				existingOutputPath !== outputPath
			) {
				await fileSystem.writeFile(outputPath, markdown, "utf8")
				result.refreshed++
			} else {
				result.skipped++
			}
		} catch (error) {
			result.failed.push({ taskId, error: error instanceof Error ? error.message : String(error) })
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
				dialogsDir,
				taskHistoryPath,
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

export function extractTextDialogMessages(uiMessages: unknown[]): TextDialogMessage[] {
	return uiMessages
		.map((message) => extractTextDialogMessage(message))
		.filter((message): message is TextDialogMessage => Boolean(message))
}

function sanitizeTaskHistoryItem(item: HistoryItem & { id: string }): SanitizedTaskHistoryItem {
	return {
		id: item.id,
		number: item.number,
		ts: item.ts,
		task: item.task,
		tokensIn: item.tokensIn,
		tokensOut: item.tokensOut,
		totalCost: item.totalCost,
		workspace: item.workspace,
		mode: item.mode,
		toolProtocol: item.toolProtocol,
		apiConfigName: item.apiConfigName,
		status: item.status,
	}
}

function extractTextDialogMessage(message: unknown): TextDialogMessage | undefined {
	if (!message || typeof message !== "object") {
		return undefined
	}

	const record = message as Record<string, unknown>
	const type = record.type

	if (type !== "say" && type !== "ask") {
		return undefined
	}

	const kindValue = type === "say" ? record.say : record.ask
	const kind = typeof kindValue === "string" ? kindValue : ""

	if (type === "say" && !includedSayKinds.has(kind)) {
		return undefined
	}

	if (type === "ask" && !includedAskKinds.has(kind)) {
		return undefined
	}

	const text = extractMessageText(record.text).trim()

	if (!text) {
		return undefined
	}

	return {
		role: getDialogRole(type, kind),
		type,
		kind,
		text,
		ts: typeof record.ts === "number" ? record.ts : undefined,
	}
}

function getDialogRole(type: "say" | "ask", kind: string): TextDialogMessage["role"] {
	if (type === "say" && kind === "user_feedback") {
		return "user"
	}

	if (type === "ask") {
		return "agent_request"
	}

	return "agent"
}

function extractMessageText(value: unknown): string {
	if (typeof value === "string") {
		return value
	}

	if (Array.isArray(value)) {
		return value.map(extractContentPartText).filter(Boolean).join("\n\n")
	}

	return ""
}

function extractContentPartText(part: unknown): string {
	if (typeof part === "string") {
		return part
	}

	if (!part || typeof part !== "object") {
		return ""
	}

	const record = part as Record<string, unknown>

	if (typeof record.text === "string") {
		return record.text
	}

	return ""
}

function getTextDialogContentHash(messages: TextDialogMessage[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				messages.map((message) => ({
					role: message.role,
					type: message.type,
					kind: message.kind,
					text: message.text,
					ts: message.ts ?? null,
				})),
			),
		)
		.digest("hex")
}

function renderTextDialogMarkdown({
	historyItem,
	messages,
	contentHash,
}: {
	historyItem: HistoryItem
	messages: TextDialogMessage[]
	contentHash: string
}): string {
	const title = historyItem.task || "Untitled dialog"
	const lines = [
		"---",
		`id: ${JSON.stringify(historyItem.id ?? "")}`,
		`title: ${JSON.stringify(title)}`,
		`workspace: ${JSON.stringify(historyItem.workspace ?? "")}`,
		`createdAt: ${JSON.stringify(historyItem.ts ? new Date(historyItem.ts).toISOString() : "")}`,
		`mode: ${JSON.stringify(historyItem.mode ?? "")}`,
		`source: ${JSON.stringify("ui_messages.json")}`,
		`messageCount: ${messages.length}`,
		`contentHash: ${JSON.stringify(contentHash)}`,
		"---",
		"",
		`# ${title}`,
		"",
	]

	if (messages.length === 0) {
		lines.push("No text dialog messages were found in the stored UI messages.", "")
	} else {
		for (const message of messages) {
			const timestamp = message.ts ? ` — ${new Date(message.ts).toISOString()}` : ""
			lines.push(`## ${message.role} (${message.type}:${message.kind})${timestamp}`, "", message.text, "")
		}
	}

	return `${lines.join("\n").trim()}\n`
}

async function findExistingDialogOutputPath({
	fileSystem,
	dialogsDir,
	outputPath,
	taskId,
}: {
	fileSystem: FileSystemAdapter
	dialogsDir: string
	outputPath: string
	taskId: string
}): Promise<string | undefined> {
	if (await fileExists(fileSystem, outputPath)) {
		return outputPath
	}

	const legacyOutputPath = path.join(dialogsDir, `${getSafeTaskId(taskId)}.md`)

	if (await fileExists(fileSystem, legacyOutputPath)) {
		return legacyOutputPath
	}

	return undefined
}

async function fileExists(fileSystem: FileSystemAdapter, filePath: string): Promise<boolean> {
	try {
		await fileSystem.readFile(filePath, "utf8")
		return true
	} catch (error) {
		if (isMissingPathError(error)) {
			return false
		}

		throw error
	}
}

async function readJsonArray(fileSystem: FileSystemAdapter, filePath: string): Promise<unknown[]> {
	const content = await fileSystem.readFile(filePath, "utf8")
	const parsed = JSON.parse(content) as unknown

	if (!Array.isArray(parsed)) {
		throw new Error(`${GlobalFileNames.uiMessages} is not a JSON array`)
	}

	return parsed
}

async function readExistingExportMetadata(
	fileSystem: FileSystemAdapter,
	filePath: string,
): Promise<{ messageCount: number; contentHash?: string; warnings: string[] } | undefined> {
	try {
		const content = await fileSystem.readFile(filePath, "utf8")
		const messageCountMatch = /^messageCount:\s*(\d+)\s*$/m.exec(content)
		const contentHashMatch = /^contentHash:\s*(?:"([a-f0-9]{64})"|([a-f0-9]{64}))\s*$/m.exec(content)
		const warnings: string[] = []

		if (!messageCountMatch) {
			warnings.push(`Cannot parse existing messageCount in ${filePath}; refreshed dialog markdown`)
		}

		if (!contentHashMatch) {
			warnings.push(`Cannot parse existing contentHash in ${filePath}; refreshed dialog markdown`)
		}

		return {
			messageCount: messageCountMatch ? Number(messageCountMatch[1]) : -1,
			contentHash: contentHashMatch?.[1] ?? contentHashMatch?.[2],
			warnings,
		}
	} catch (error) {
		if (isMissingPathError(error)) {
			return undefined
		}

		throw error
	}
}

async function isSameWorkspace(fileSystem: FileSystemAdapter, left: string, right: string): Promise<boolean> {
	return (await normalizeWorkspacePath(fileSystem, left)) === (await normalizeWorkspacePath(fileSystem, right))
}

async function normalizeWorkspacePath(fileSystem: FileSystemAdapter, workspacePath: string): Promise<string> {
	const resolvedPath = path.resolve(workspacePath)
	let normalizedPath = path.normalize(resolvedPath)

	try {
		normalizedPath = path.normalize(await (fileSystem.realpath?.(resolvedPath) ?? fs.realpath(resolvedPath)))
	} catch {
		normalizedPath = path.normalize(resolvedPath)
	}

	return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath
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

function isMissingPathError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false
	}

	return "code" in error && error.code === "ENOENT"
}

function assertExportDestinationIsSafe(sourceTasksDir: string, dialogsDir: string): void {
	const normalizedSourceTasksDir = path.resolve(sourceTasksDir)
	const normalizedDialogsDir = path.resolve(dialogsDir)

	if (
		normalizedDialogsDir === normalizedSourceTasksDir ||
		normalizedDialogsDir.startsWith(`${normalizedSourceTasksDir}${path.sep}`)
	) {
		throw new Error("Export destination cannot be inside the Kilo Code tasks storage directory")
	}
}
