// kilocode_change - new file
import fs from "fs/promises"
import path from "path"

import type { HistoryItem } from "@roo-code/types"

export interface DialogHistoryProvider {
	cwd: string
	getTaskHistory(): HistoryItem[]
	getTaskWithId(
		id: string,
		withMessage?: boolean,
	): Promise<{
		historyItem: HistoryItem
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		apiConversationHistory: unknown[]
	}>
}

export interface ExportDialogHistoryResult {
	outputDir: string
	total: number
	exported: number
	skipped: number
	failed: Array<{ taskId: string; error: string }>
}

interface FileSystemAdapter {
	mkdir(path: string, options: { recursive: boolean }): Promise<void>
	readFile(path: string, encoding: "utf8"): Promise<string>
	writeFile(path: string, data: string, encoding: "utf8"): Promise<void>
	access(path: string): Promise<void>
}

interface ExportDialogHistoryOptions {
	fs?: FileSystemAdapter
	outputDir?: string
}

interface RenderDialogMarkdownInput {
	historyItem: HistoryItem
	uiMessages: unknown[]
	apiConversationHistory: unknown[]
}

const defaultFs: FileSystemAdapter = {
	mkdir: (dirPath, options) => fs.mkdir(dirPath, options).then(() => undefined),
	readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
	writeFile: (filePath, data, encoding) => fs.writeFile(filePath, data, encoding),
	access: (filePath) => fs.access(filePath),
}

export async function exportDialogHistory(
	provider: DialogHistoryProvider,
	options: ExportDialogHistoryOptions = {},
): Promise<ExportDialogHistoryResult> {
	const fileSystem = options.fs ?? defaultFs
	const outputDir = options.outputDir ?? path.join(provider.cwd, ".kilo", "history", "dialogs")

	await fileSystem.mkdir(outputDir, { recursive: true })

	const tasks = provider
		.getTaskHistory()
		.filter((item): item is HistoryItem & { id: string; task: string; ts: number } => {
			return Boolean(item.id && item.task && item.ts && typeof item.workspace === "string" && item.workspace === provider.cwd)
		})
		.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))

	const result: ExportDialogHistoryResult = {
		outputDir,
		total: tasks.length,
		exported: 0,
		skipped: 0,
		failed: [],
	}

	for (const task of tasks) {
		const outputPath = path.join(outputDir, `${safeTaskId(task.id)}.md`)

		if (await fileExists(fileSystem, outputPath)) {
			result.skipped++
			continue
		}

		try {
			const taskData = await provider.getTaskWithId(task.id, false)
			const uiMessages = await readJsonArrayIfExists(fileSystem, taskData.uiMessagesFilePath)
			const apiConversationHistory = Array.isArray(taskData.apiConversationHistory)
				? taskData.apiConversationHistory
				: await readJsonArrayIfExists(fileSystem, taskData.apiConversationHistoryFilePath)

			const markdown = renderDialogMarkdown({
				historyItem: taskData.historyItem,
				uiMessages,
				apiConversationHistory,
			})

			await fileSystem.writeFile(outputPath, markdown, "utf8")
			result.exported++
		} catch (error) {
			result.failed.push({ taskId: task.id, error: error instanceof Error ? error.message : String(error) })
		}
	}

	return result
}

export function renderDialogMarkdown({
	historyItem,
	uiMessages,
	apiConversationHistory,
}: RenderDialogMarkdownInput): string {
	const title = historyItem.task || "Untitled dialog"
	const messages = collectRenderableMessages(uiMessages.length > 0 ? uiMessages : apiConversationHistory)
	const lines = [
		"---",
		`id: ${JSON.stringify(historyItem.id ?? "")}`,
		`title: ${JSON.stringify(title)}`,
		`workspace: ${JSON.stringify(historyItem.workspace ?? "")}`,
		`createdAt: ${JSON.stringify(historyItem.ts ? new Date(historyItem.ts).toISOString() : "")}`,
		`mode: ${JSON.stringify(historyItem.mode ?? "")}`,
		`apiConfigName: ${JSON.stringify(historyItem.apiConfigName ?? "")}`,
		`tokensIn: ${JSON.stringify(historyItem.tokensIn ?? 0)}`,
		`tokensOut: ${JSON.stringify(historyItem.tokensOut ?? 0)}`,
		`totalCost: ${JSON.stringify(historyItem.totalCost ?? 0)}`,
		`source: ${JSON.stringify("kilo-code-v5")}`,
		"---",
		"",
		`# ${title}`,
		"",
		`Task ID: \`${historyItem.id ?? ""}\``,
		"",
		"## Messages",
		"",
	]

	if (messages.length === 0) {
		lines.push("No text messages were found in the stored dialog files.", "")
	} else {
		for (const message of messages) {
			lines.push(`### ${message.role}`, "", message.text, "")
		}
	}

	return `${lines.join("\n").trim()}\n`
}

export function safeTaskId(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9._-]/g, "_")
}

async function fileExists(fileSystem: FileSystemAdapter, filePath: string): Promise<boolean> {
	try {
		await fileSystem.access(filePath)
		return true
	} catch {
		return false
	}
}

async function readJsonArrayIfExists(fileSystem: FileSystemAdapter, filePath: string): Promise<unknown[]> {
	try {
		const content = await fileSystem.readFile(filePath, "utf8")
		const parsed = JSON.parse(content)

		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

function collectRenderableMessages(messages: unknown[]): Array<{ role: string; text: string }> {
	return messages
		.map((message) => {
			const role = getMessageRole(message)
			const text = extractMessageText(message).trim()

			return text ? { role, text } : undefined
		})
		.filter((message): message is { role: string; text: string } => Boolean(message))
}

function getMessageRole(message: unknown): string {
	if (!message || typeof message !== "object") {
		return "message"
	}

	const record = message as Record<string, unknown>
	const role = record.role ?? record.type

	return typeof role === "string" && role.trim() ? role.trim() : "message"
}

function extractMessageText(message: unknown): string {
	if (typeof message === "string") {
		return message
	}

	if (!message || typeof message !== "object") {
		return ""
	}

	const record = message as Record<string, unknown>

	for (const key of ["text", "content", "message"] as const) {
		const value = record[key]

		if (typeof value === "string") {
			return value
		}

		if (Array.isArray(value)) {
			return value.map(extractContentPartText).filter(Boolean).join("\n\n")
		}
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

	if (record.type === "image" || record.type === "image_url") {
		return "[image omitted]"
	}

	return ""
}
