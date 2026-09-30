import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const hoisted = vi.hoisted(() => ({
	safeWriteJsonMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: hoisted.safeWriteJsonMock,
}))

import { TaskStateManager } from "../../task-state/TaskStateManager"
import { readTaskExecutionState, saveTaskExecutionState } from "../taskExecutionState"

let tmpBaseDir: string

beforeEach(async () => {
	hoisted.safeWriteJsonMock.mockClear()
	tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "kilo-task-state-test-"))
})

describe("taskExecutionState persistence", () => {
	it("returns undefined when state is missing", async () => {
		await expect(
			readTaskExecutionState({ taskId: "missing", globalStoragePath: tmpBaseDir }),
		).resolves.toBeUndefined()
	})

	it("returns undefined rather than throwing for corrupt state", async () => {
		const taskDir = path.join(tmpBaseDir, "tasks", "corrupt")
		await fs.mkdir(taskDir, { recursive: true })
		await fs.writeFile(path.join(taskDir, "task_execution_state.json"), "{bad json", "utf8")

		await expect(
			readTaskExecutionState({ taskId: "corrupt", globalStoragePath: tmpBaseDir }),
		).resolves.toBeUndefined()
	})

	it("persists validated state through safeWriteJson", async () => {
		const state = TaskStateManager.create("Goal", []).getSnapshot()
		await saveTaskExecutionState({ state, taskId: "task-1", globalStoragePath: tmpBaseDir })

		expect(hoisted.safeWriteJsonMock).toHaveBeenCalledWith(
			path.join(tmpBaseDir, "tasks", "task-1", "task_execution_state.json"),
			state,
		)
	})
})
