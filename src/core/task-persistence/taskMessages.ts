import { safeWriteJson } from "../../utils/safeWriteJson"
import * as path from "path"
import * as fs from "fs/promises"

import type { ClineMessage } from "@roo-code/types"

import { fileExistsAtPath } from "../../utils/fs"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"

export type ReadTaskMessagesOptions = {
	taskId: string
	globalStoragePath: string
	workspaceRoot?: string
}

export async function readTaskMessages({
	taskId,
	globalStoragePath,
	workspaceRoot,
}: ReadTaskMessagesOptions): Promise<ClineMessage[]> {
	// kilocode_change start: project-local dialog session storage
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId, { workspaceRoot })
	// kilocode_change end
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	const fileExists = await fileExistsAtPath(filePath)

	if (fileExists) {
		return JSON.parse(await fs.readFile(filePath, "utf8"))
	}

	return []
}

export type SaveTaskMessagesOptions = {
	messages: ClineMessage[]
	taskId: string
	globalStoragePath: string
	workspaceRoot?: string
}

export async function saveTaskMessages({
	messages,
	taskId,
	globalStoragePath,
	workspaceRoot,
}: SaveTaskMessagesOptions) {
	// kilocode_change start: project-local dialog session storage
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId, { workspaceRoot })
	// kilocode_change end
	const filePath = path.join(taskDir, GlobalFileNames.uiMessages)
	await safeWriteJson(filePath, messages)
}
