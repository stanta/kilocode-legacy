import { describe, it, expect, vi, beforeEach } from "vitest"
import * as os from "os"
import * as path from "path"
import * as fs from "fs/promises"

// Mocks (use hoisted to avoid initialization ordering issues)
const hoisted = vi.hoisted(() => ({
	safeWriteJsonMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: hoisted.safeWriteJsonMock,
}))

// Import after mocks
import { readTaskMessages, saveTaskMessages } from "../taskMessages"

let tmpBaseDir: string

beforeEach(async () => {
	hoisted.safeWriteJsonMock.mockClear()
	// Create a unique, writable temp directory to act as globalStoragePath
	tmpBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), "roo-test-"))
})

describe("taskMessages.saveTaskMessages", () => {
	beforeEach(() => {
		hoisted.safeWriteJsonMock.mockClear()
	})

	it("persists messages as-is", async () => {
		const messages: any[] = [
			{
				role: "assistant",
				content: "Hello",
				metadata: {
					other: "keep",
				},
			},
			{ role: "user", content: "Do thing" },
		]

		await saveTaskMessages({
			messages,
			taskId: "task-1",
			globalStoragePath: tmpBaseDir,
		})

		expect(hoisted.safeWriteJsonMock).toHaveBeenCalledTimes(1)
		const [, persisted] = hoisted.safeWriteJsonMock.mock.calls[0]
		expect(persisted).toEqual(messages)
	})

	it("persists messages without modification when no metadata", async () => {
		const messages: any[] = [
			{ role: "assistant", content: "Hi" },
			{ role: "user", content: "Yo" },
		]

		await saveTaskMessages({
			messages,
			taskId: "task-2",
			globalStoragePath: tmpBaseDir,
		})

		const [, persisted] = hoisted.safeWriteJsonMock.mock.calls[0]
		expect(persisted).toEqual(messages)
	})

	it("persists messages to project-local dialog_sessions_path", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "roo-workspace-"))
		const configDir = path.join(workspaceRoot, ".kilo")
		await fs.mkdir(configDir, { recursive: true })
		await fs.writeFile(
			path.join(configDir, "config.json"),
			JSON.stringify({ project: { dialog_sessions_path: ".kilo/dialogs" } }),
		)

		try {
			const messages: any[] = [{ type: "say", say: "text", text: "Stored locally" }]

			await saveTaskMessages({
				messages,
				taskId: "task-local",
				globalStoragePath: tmpBaseDir,
				workspaceRoot,
			})

			expect(hoisted.safeWriteJsonMock).toHaveBeenCalledWith(
				path.join(workspaceRoot, ".kilo", "dialogs", "task-local", "ui_messages.json"),
				messages,
			)
		} finally {
			await fs.rm(workspaceRoot, { recursive: true, force: true })
		}
	})

	it("reads messages from project-local dialog_sessions_path", async () => {
		const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "roo-workspace-"))
		const localTaskDir = path.join(workspaceRoot, ".kilo", "dialogs", "task-local")
		const messages: any[] = [{ type: "say", say: "text", text: "Read locally" }]

		await fs.mkdir(path.join(workspaceRoot, ".kilo"), { recursive: true })
		await fs.writeFile(
			path.join(workspaceRoot, ".kilo", "config.json"),
			JSON.stringify({ project: { dialog_sessions_path: ".kilo/dialogs" } }),
		)
		await fs.mkdir(localTaskDir, { recursive: true })
		await fs.writeFile(path.join(localTaskDir, "ui_messages.json"), JSON.stringify(messages), "utf8")

		try {
			await expect(
				readTaskMessages({
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
