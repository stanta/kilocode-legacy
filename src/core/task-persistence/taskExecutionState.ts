// kilocode_change - new file
import * as fs from "fs/promises"
import * as path from "path"

import type { TaskExecutionStateV1 } from "@roo-code/types"
import { taskExecutionStateV1Schema } from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { fileExistsAtPath } from "../../utils/fs"
import { safeWriteJson } from "../../utils/safeWriteJson"
import { getTaskDirectoryPath } from "../../utils/storage"

export async function readTaskExecutionState({
	taskId,
	globalStoragePath,
	workspaceRoot,
}: {
	taskId: string
	globalStoragePath: string
	workspaceRoot?: string
}): Promise<TaskExecutionStateV1 | undefined> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId, { workspaceRoot })
	const filePath = path.join(taskDir, GlobalFileNames.taskExecutionState)
	if (!(await fileExistsAtPath(filePath))) return undefined

	try {
		const parsed = JSON.parse(await fs.readFile(filePath, "utf8"))
		const result = taskExecutionStateV1Schema.safeParse(parsed)
		if (!result.success) {
			console.warn(`[TaskState] Ignoring invalid state for task ${taskId}: ${result.error.message}`)
			return undefined
		}
		return result.data
	} catch (error) {
		console.warn(`[TaskState] Ignoring unreadable state for task ${taskId}:`, error)
		return undefined
	}
}

export async function saveTaskExecutionState({
	state,
	taskId,
	globalStoragePath,
	workspaceRoot,
}: {
	state: TaskExecutionStateV1
	taskId: string
	globalStoragePath: string
	workspaceRoot?: string
}): Promise<void> {
	const validated = taskExecutionStateV1Schema.parse(state)
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId, { workspaceRoot })
	await safeWriteJson(path.join(taskDir, GlobalFileNames.taskExecutionState), validated)
}
