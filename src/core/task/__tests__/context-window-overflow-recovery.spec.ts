// cd src && pnpm test core/task/__tests__/context-window-overflow-recovery.spec.ts

import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import type { GlobalState, ProviderSettings, TokenUsage } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"
import { MAX_CONTEXT_WINDOW_RETRIES } from "../../context/context-management/context-window-recovery"

// Mock @roo-code/core
vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		getTools: vi.fn().mockReturnValue([]),
		hasTool: vi.fn().mockReturnValue(false),
		getTool: vi.fn().mockReturnValue(undefined),
	},
}))

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
}))

vi.mock("fs/promises", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, any>
	const mockFunctions = {
		mkdir: vi.fn().mockResolvedValue(undefined),
		writeFile: vi.fn().mockResolvedValue(undefined),
		readFile: vi.fn().mockImplementation(() => Promise.resolve("[]")),
		unlink: vi.fn().mockResolvedValue(undefined),
		rmdir: vi.fn().mockResolvedValue(undefined),
	}

	return {
		...actual,
		...mockFunctions,
		default: mockFunctions,
	}
})

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }),
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (key: string, defaultValue: any) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(() => mockEventEmitter),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text) => {
		return Promise.resolve(`processed: ${text}`)
	}),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath, taskId) => Promise.resolve(`${globalStoragePath}/tasks/${taskId}`)),
	getSettingsDirectoryPath: vi
		.fn()
		.mockImplementation((globalStoragePath) => Promise.resolve(`${globalStoragePath}/settings`)),
}))

vi.mock("../../../utils/fs", () => ({
	fileExistsAtPath: vi.fn().mockImplementation(() => false),
}))

// kilocode_change start
// Phase 0 regression coverage: context-window overflow recovery and
// context-composition instrumentation wired into attemptApiRequest.
describe("Context window overflow recovery (Task.attemptApiRequest)", () => {
	let mockProvider: any
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: any
	let mockExtensionContext: vscode.ExtensionContext

	const contextWindowError = Object.assign(new Error("This model's maximum context length is 4096 tokens"), {
		status: 400,
	})

	function errorStream(error: unknown) {
		return {
			[Symbol.asyncIterator]: () => ({
				next: () => Promise.reject(error),
			}),
		}
	}

	function okStream() {
		return {
			async *[Symbol.asyncIterator]() {
				yield { type: "usage" as const, inputTokens: 1, outputTokens: 1 }
			},
		}
	}

	function makeFakeApi(createMessage: () => any) {
		return {
			createMessage: vi.fn(createMessage),
			getModel: () => ({
				id: "test-model",
				info: {
					contextWindow: 100_000,
					maxTokens: 8192,
					supportsPromptCache: false,
					supportsImages: false,
					supportsNativeTools: false,
					inputPrice: 0,
					outputPrice: 0,
					description: "test",
				},
			}),
			countTokens: vi.fn().mockResolvedValue(0),
			contextWindow: 100_000,
		}
	}

	async function makeTask(createMessage: () => any) {
		const task = new Task({
			context: mockExtensionContext,
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
		}) as any

		task.api = makeFakeApi(createMessage)
		task.apiConversationHistory = [{ role: "user", content: "hello" }]

		vi.spyOn(task, "getSystemPrompt").mockResolvedValue("system prompt")
		vi.spyOn(task, "ensureSessionCondensingSettings").mockResolvedValue({})
		vi.spyOn(task, "getTokenUsage").mockReturnValue({ contextTokens: 0 } as TokenUsage)
		vi.spyOn(task.autoApprovalHandler, "checkAutoApprovalLimits").mockResolvedValue({ shouldProceed: true })
		vi.spyOn(task, "ask").mockResolvedValue({ response: "noButtonClicked" } as never)

		return task
	}

	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		const storageUri = {
			fsPath: path.join(os.tmpdir(), "test-storage"),
		}

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockImplementation((_key) => Promise.resolve(undefined)),
				store: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				delete: vi.fn().mockImplementation((_key) => Promise.resolve()),
			},
			extensionUri: {
				fsPath: "/mock/extension/path",
			},
			extension: {
				packageJSON: {
					version: "1.0.0",
				},
			},
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		mockProvider = new ClineProvider(
			mockExtensionContext,
			mockOutputChannel,
			"sidebar",
			new ContextProxy(mockExtensionContext),
		) as any

		mockApiConfig = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.getState = vi.fn().mockResolvedValue({})
		vi.spyOn(mockProvider, "getKiloConfig").mockResolvedValue(null)
	})

	it("recovers once and retries successfully when the provider reports a context window overflow", async () => {
		mockProvider.getState = vi.fn().mockResolvedValue({})
		let calls = 0
		const task = await makeTask(() => {
			calls++
			return calls === 1 ? errorStream(contextWindowError) : okStream()
		})

		const recoverySpy = vi.spyOn(task, "handleContextWindowExceededError").mockResolvedValue(undefined as never)

		const chunks: unknown[] = []
		for await (const chunk of task.attemptApiRequest(0, { skipProviderRateLimit: true })) {
			chunks.push(chunk)
		}

		expect(calls).toBe(2) // original + retry after recovery
		expect(recoverySpy).toHaveBeenCalledTimes(1)
		expect(chunks.length).toBeGreaterThan(0)
	})

	it("stops automatic recovery after MAX_CONTEXT_WINDOW_RETRIES attempts and defers to generic handling", async () => {
		mockProvider.getState = vi.fn().mockResolvedValue({})
		let calls = 0
		const task = await makeTask(() => {
			calls++
			return errorStream(contextWindowError)
		})

		const recoverySpy = vi.spyOn(task, "handleContextWindowExceededError").mockResolvedValue(undefined as never)

		await expect(async () => {
			for await (const _chunk of task.attemptApiRequest(0, { skipProviderRateLimit: true })) {
				// consume
			}
		}).rejects.toThrow("API request failed")

		// Initial attempt + 3 recovery retries = 4 API calls; recovery ran exactly MAX times.
		expect(calls).toBe(MAX_CONTEXT_WINDOW_RETRIES + 1)
		expect(recoverySpy).toHaveBeenCalledTimes(MAX_CONTEXT_WINDOW_RETRIES)
		// Generic handling surfaced the failure to the user.
		expect(task.ask).toHaveBeenCalledWith("api_req_failed", expect.any(String))
	})

	it("does not trigger context recovery for non-context errors (generic retry semantics preserved)", async () => {
		mockProvider.getState = vi.fn().mockResolvedValue({})
		const genericError = Object.assign(new Error("Internal server error"), { status: 500 })
		const task = await makeTask(() => errorStream(genericError))

		const recoverySpy = vi.spyOn(task, "handleContextWindowExceededError").mockResolvedValue(undefined as never)

		await expect(async () => {
			for await (const _chunk of task.attemptApiRequest(0, { skipProviderRateLimit: true })) {
				// consume
			}
		}).rejects.toThrow("API request failed")

		expect(recoverySpy).not.toHaveBeenCalled()
		expect(callsCount(task)).toBe(1)
	})

	it("falls through to generic handling when the recovery itself throws", async () => {
		mockProvider.getState = vi.fn().mockResolvedValue({})
		let calls = 0
		const task = await makeTask(() => {
			calls++
			return errorStream(contextWindowError)
		})

		vi.spyOn(task, "handleContextWindowExceededError").mockRejectedValue(new Error("condense failed"))

		await expect(async () => {
			for await (const _chunk of task.attemptApiRequest(0, { skipProviderRateLimit: true })) {
				// consume
			}
		}).rejects.toThrow("API request failed")

		// No retry was issued because recovery failed.
		expect(calls).toBe(1)
		expect(task.ask).toHaveBeenCalledWith("api_req_failed", expect.any(String))
	})

	it("does not emit context composition telemetry when the experiment flag is off", async () => {
		mockProvider.getState = vi.fn().mockResolvedValue({})
		const task = await makeTask(() => okStream())

		const telemetrySpy = vi.spyOn(TelemetryService.instance, "captureContextComposition")

		for await (const _chunk of task.attemptApiRequest(0, { skipProviderRateLimit: true })) {
			// consume
		}

		expect(telemetrySpy).not.toHaveBeenCalled()
	})

	it("emits context composition telemetry (sizes only) when the experiment flag is on", async () => {
		mockProvider.getState = vi.fn().mockResolvedValue({
			experiments: { contextCompositionInstrumentation: true },
		})
		const task = await makeTask(() => okStream())

		const telemetrySpy = vi.spyOn(TelemetryService.instance, "captureContextComposition")

		for await (const _chunk of task.attemptApiRequest(0, { skipProviderRateLimit: true })) {
			// consume
		}

		expect(telemetrySpy).toHaveBeenCalledTimes(1)
		const [, composition] = telemetrySpy.mock.calls[0]
		expect(composition.categories.systemPrompt.chars).toBe("system prompt".length)
		expect(composition.categories.taskState).toEqual({ chars: 0, estTokens: 0 })
		expect(composition.messageCount).toBeGreaterThanOrEqual(1)
		// Payload must contain sizes only - no message content.
		expect(JSON.stringify(composition)).not.toContain("hello")
	})

	function callsCount(task: any): number {
		return task.api.createMessage.mock ? task.api.createMessage.mock.calls.length : -1
	}
})
// kilocode_change end
