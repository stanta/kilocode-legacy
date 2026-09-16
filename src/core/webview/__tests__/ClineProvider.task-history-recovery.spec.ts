// kilocode_change - new file

import * as fs from "fs/promises"
import * as vscode from "vscode"

import { saveApiMessages } from "../../task-persistence"
import { readTaskMessages } from "../../task-persistence/taskMessages"
import { fileExistsAtPath } from "../../../utils/fs"
import { ClineProvider } from "../ClineProvider"

vi.mock("fs/promises", () => {
	const mockedFs = { readFile: vi.fn() }
	return { ...mockedFs, default: mockedFs }
})

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn(),
}))

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/storage/tasks/task-1"),
}))

vi.mock("../../task-persistence", () => ({
	saveApiMessages: vi.fn(),
	saveTaskMessages: vi.fn(),
	readApiMessages: vi.fn(),
}))

vi.mock("../../task-persistence/taskMessages", () => ({
	readTaskMessages: vi.fn(),
}))

vi.mock("vscode", () => ({
	window: {
		showErrorMessage: vi.fn(),
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
	},
	CodeActionKind: {
		QuickFix: { value: "quickfix" },
		RefactorRewrite: { value: "refactor.rewrite" },
	},
	workspace: {
		getConfiguration: vi.fn(() => ({ get: vi.fn(), update: vi.fn() })),
	},
	Uri: {
		file: vi.fn((filePath: string) => ({ fsPath: filePath })),
		joinPath: vi.fn(),
	},
}))

describe("ClineProvider.getTaskWithId task history recovery", () => {
	const historyItem = {
		id: "task-1",
		number: 1,
		ts: 1,
		task: "Interrupted task",
		tokensIn: 0,
		tokensOut: 0,
		cacheWrites: 0,
		cacheReads: 0,
		totalCost: 0,
	}

	const createProvider = () =>
		({
			getGlobalState: vi.fn().mockReturnValue([historyItem]),
			contextProxy: { globalStorageUri: { fsPath: "/storage" } },
			log: vi.fn(),
		}) as unknown as ClineProvider

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("creates an empty API history when an interrupted task still has its initial UI message", async () => {
		vi.mocked(fileExistsAtPath).mockImplementation(async (filePath) =>
			String(filePath).endsWith("ui_messages.json"),
		)
		vi.mocked(readTaskMessages).mockResolvedValue([
			{ ts: 1, type: "say", say: "text", text: "Interrupted task" },
			{ ts: 2, type: "say", say: "api_req_started", text: "{}" },
		])

		const provider = createProvider()
		const result = await ClineProvider.prototype.getTaskWithId.call(provider, "task-1")

		expect(saveApiMessages).toHaveBeenCalledWith({
			messages: [],
			taskId: "task-1",
			globalStoragePath: "/storage",
		})
		expect(result.apiConversationHistory).toEqual([])
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("does not recover a stale history entry without a persisted task message", async () => {
		vi.mocked(fileExistsAtPath).mockResolvedValue(false)

		const provider = createProvider()
		await expect(ClineProvider.prototype.getTaskWithId.call(provider, "task-1")).rejects.toThrow("Task not found")

		expect(readTaskMessages).not.toHaveBeenCalled()
		expect(saveApiMessages).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledOnce()
	})

	it("reads an existing API history without rewriting it", async () => {
		vi.mocked(fileExistsAtPath).mockResolvedValue(true)
		vi.mocked(fs.readFile).mockResolvedValue('[{"role":"user","content":"existing"}]')

		const provider = createProvider()
		const result = await ClineProvider.prototype.getTaskWithId.call(provider, "task-1")

		expect(result.apiConversationHistory).toEqual([{ role: "user", content: "existing" }])
		expect(saveApiMessages).not.toHaveBeenCalled()
	})
})
