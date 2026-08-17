// kilocode_change - new file
import fs from "fs/promises"
import path from "path"

import type { HistoryItem } from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getStorageBasePath } from "../../utils/storage"

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
}

export interface ExportAllDialogsOptions {
	fs?: FileSystemAdapter
	outputDir?: string
	getStorageBasePath?: (defaultPath: string) => Promise<string>
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
}

const includedSayKinds = new Set(["text", "completion_result", "subtask_result", "user_feedback"])
const includedAskKinds = new Set(["followup", "completion_result", "tool"])

/**
 * Exports text-only dialogs for current-project Kilo Code tasks.
 *
 * Unlike raw session export, this writes one Markdown dialog per task from
 * `ui_messages.json`, excluding internal API/checkpoint/reasoning noise and
 * skipping unchanged files by comparing extracted text message counts.
 */
export async function exportAllDialogs(
	provider: AllDialogsExportProvider,
	options: ExportAllDialogsOptions = {},
): Promise<ExportAllDialogsResult> {
	const fileSystem = options.fs ?? defaultFs
	const resolveStorageBasePath = options.getStorageBasePath ?? getStorageBasePath

	if (!options.outputDir) {
		throw new Error("An output directory is required to export current project Kilo Code text dialogs")
	}

	const outputDir = options.outputDir
	const dialogsDir = path.join(outputDir, "dialogs")
	const manifestPath = path.join(outputDir, "dialogs_manifest.json")
	const taskHistoryPath = path.join(outputDir, "dialogs_task_history.json")
	const storageBasePath = await resolveStorageBasePath(provider.contextProxy.globalStorageUri.fsPath)
	const sourceTasksDir = path.join(storageBasePath, "tasks")

	assertExportDestinationIsSafe(sourceTasksDir, dialogsDir)

	await fileSystem.mkdir(dialogsDir, { recursive: true })

	const history = provider.getTaskHistory()
	const currentProjectHistory = history.filter((item): item is HistoryItem & { id: string } => {
		return Boolean(item.id && typeof item.workspace === "string" && item.workspace === provider.cwd)
	})
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
		const outputPath = path.join(dialogsDir, `${safeTaskId(taskId)}.md`)

		if (!historyItem) {
			result.failed.push({ taskId, error: "Task history item not found" })
			continue
		}

		if (!taskDirectories.has(taskId)) {
			result.failed.push({ taskId, error: `Task directory not found: ${sourceTaskDir}` })
			continue
		}

		try {
			const uiMessages = await readJsonArray(fileSystem, uiMessagesPath)
			const messages = extractTextDialogMessages(uiMessages)
			const markdown = renderTextDialogMarkdown({ historyItem, messages })
			const existingCount = await readExistingMessageCount(fileSystem, outputPath)

			if (existingCount === undefined) {
				await fileSystem.writeFile(outputPath, markdown, "utf8")
				result.exported++
				continue
			}

			if (existingCount.warning) {
				result.warnings.push({ taskId, warning: existingCount.warning })
			}

			if (existingCount.messageCount !== messages.length) {
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

function renderTextDialogMarkdown({
	historyItem,
	messages,
}: {
	historyItem: HistoryItem
	messages: TextDialogMessage[]
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

function safeTaskId(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9._-]/g, "_")
}

async function readJsonArray(fileSystem: FileSystemAdapter, filePath: string): Promise<unknown[]> {
	const content = await fileSystem.readFile(filePath, "utf8")
	const parsed = JSON.parse(content) as unknown

	if (!Array.isArray(parsed)) {
		throw new Error(`${GlobalFileNames.uiMessages} is not a JSON array`)
	}

	return parsed
}

async function readExistingMessageCount(
	fileSystem: FileSystemAdapter,
	filePath: string,
): Promise<{ messageCount: number; warning?: string } | undefined> {
	try {
		const content = await fileSystem.readFile(filePath, "utf8")
		const match = /^messageCount:\s*(\d+)\s*$/m.exec(content)

		if (!match) {
			return {
				messageCount: -1,
				warning: `Cannot parse existing messageCount in ${filePath}; refreshed dialog markdown`,
			}
		}

		return { messageCount: Number(match[1]) }
	} catch (error) {
		if (isMissingPathError(error)) {
			return undefined
		}

		throw error
	}
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
