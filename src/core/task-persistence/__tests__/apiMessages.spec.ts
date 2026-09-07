import { describe, it, expect, vi, beforeEach } from "vitest"
import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

const hoisted = vi.hoisted(() => ({
	safeWriteJsonMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: hoisted.safeWriteJsonMock,
}))

import { readApiMessages, saveApiMessages } from "../apiMessages"

let tmpBaseDir: string

beforeEach(async () => {
	hoisted.safeWriteJsonMock.mockClear()
	tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-api-test-"))
})

describe("apiMessages", () => {
	it("persists API messages to project-local dialog_sessions_path", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "roo-workspace-"))
		const configDir = path.join(workspaceRoot, ".kilo")
		await fs.mkdir(configDir, { recursive: true })
		await fs.writeFile(
			path.join(configDir, "config.json"),
			JSON.stringify({ project: { dialog_sessions_path: ".kilo/dialogs" } }),
		)

		try {
			const messages: any[] = [{ role: "assistant", content: [{ type: "text", text: "Stored locally" }] }]

			await saveApiMessages({
				messages,
				taskId: "task-local",
				globalStoragePath: tmpBaseDir,
				workspaceRoot,
			})

			expect(hoisted.safeWriteJsonMock).toHaveBeenCalledWith(
				path.join(workspaceRoot, ".kilo", "dialogs", "task-local", "api_conversation_history.json"),
				messages,
			)
		} finally {
			await fs.rm(workspaceRoot, { recursive: true, force: true })
		}
	})

	it("reads API messages from project-local dialog_sessions_path", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "roo-workspace-"))
		const localTaskDir = path.join(workspaceRoot, ".kilo", "dialogs", "task-local")
		const messages: any[] = [{ role: "assistant", content: [{ type: "text", text: "Read locally" }] }]

		await fs.mkdir(path.join(workspaceRoot, ".kilo"), { recursive: true })
		await fs.writeFile(
			path.join(workspaceRoot, ".kilo", "config.json"),
			JSON.stringify({ project: { dialog_sessions_path: ".kilo/dialogs" } }),
		)
		await fs.mkdir(localTaskDir, { recursive: true })
		await fs.writeFile(path.join(localTaskDir, "api_conversation_history.json"), JSON.stringify(messages), "utf8")

		try {
			await expect(
				readApiMessages({
					taskId: "task-local",
					globalStoragePath: tmpBaseDir,
					workspaceRoot,
				}),
			).resolves.toEqual(messages)
		} finally {
			await fs.rm(workspaceRoot, { recursive: true, force: true })
		}
	})
})
