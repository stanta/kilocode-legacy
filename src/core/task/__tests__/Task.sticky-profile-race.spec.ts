// npx vitest run core/task/__tests__/Task.sticky-profile-race.spec.ts

import * as vscode from "vscode"

import type { ProviderSettings } from "@roo-code/types"
import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn().mockReturnValue(true),
		createInstance: vi.fn(),
		get instance() {
			return {
				captureTaskCreated: vi.fn(),
				captureTaskRestarted: vi.fn(),
				captureModeSwitch: vi.fn(),
				captureConversationMessage: vi.fn(),
				captureLlmCompletion: vi.fn(),
				captureConsecutiveMistakeError: vi.fn(),
				captureCodeActionUsed: vi.fn(),
				setProvider: vi.fn(),
			}
		},
	},
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
			getConfiguration: vi.fn(() => ({ get: (_k: string, d: any) => d })),
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
		version: "1.85.0",
	}
})

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("p-wait-for", () => ({
	default: vi.fn().mockImplementation(async () => Promise.resolve()),
}))

vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

describe("Task - sticky provider profile init race", () => {
	it("does not overwrite task apiConfigName if set during async initialization", async () => {
		const apiConfig: ProviderSettings = {
			apiProvider: "anthropic",
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		} as any

		const mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/storage" },
			},
			getState: vi.fn().mockResolvedValue({ currentApiConfigName: "old-profile" }),
			getRuntimeProviderProfile: vi.fn().mockReturnValue({
				currentMode: "code",
				currentApiConfigName: "old-profile",
				apiConfiguration: apiConfig,
			}),
			log: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider

		const task = new Task({
			context: mockProvider.context as any, // kilocode_change
			provider: mockProvider,
			apiConfiguration: apiConfig,
			task: "test task",
			startTask: false,
		})

		// Simulate a profile switch happening after task creation.
		task.setTaskApiConfigName("new-profile")

		await task.waitForApiConfigInitialization()

		expect(task.taskApiConfigName).toBe("new-profile")
		expect(task.getCurrentSessionModeBinding()).toMatchObject({
			mode: "code",
			apiConfigName: "new-profile",
			apiConfiguration: apiConfig,
		})
	})

	it("seeds new sessions from runtime defaults once and then detaches from later provider defaults", async () => {
		const initialConfig: ProviderSettings = {
			apiProvider: "anthropic",
			apiModelId: "claude-session",
			reasoningEffort: "medium",
		} as any
		const laterConfig: ProviderSettings = {
			apiProvider: "openrouter",
			openRouterModelId: "openai/global-later",
			reasoningEffort: "high",
		} as any

		const runtimeProfile = {
			currentMode: "code",
			currentApiConfigName: "session-profile",
			apiConfiguration: initialConfig,
		}
		const mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/storage" },
			},
			getState: vi.fn().mockResolvedValue({
				mode: "architect",
				currentApiConfigName: "global-later",
			}),
			getRuntimeProviderProfile: vi.fn(() => runtimeProfile),
			log: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider

		const task = new Task({
			context: mockProvider.context as any,
			provider: mockProvider,
			apiConfiguration: initialConfig,
			task: "test task",
			startTask: false,
		})

		runtimeProfile.currentMode = "architect"
		runtimeProfile.currentApiConfigName = "global-later"
		runtimeProfile.apiConfiguration = laterConfig

		expect(await task.getTaskMode()).toBe("code")
		expect(task.taskApiConfigName).toBe("session-profile")
		expect(task.getSessionApiConfiguration()).toMatchObject({
			apiProvider: "anthropic",
			apiModelId: "claude-session",
			reasoningEffort: "medium",
		})
		expect(mockProvider.getState).not.toHaveBeenCalled()
	})

	it("keeps same role slug isolated with different model and reasoning settings per session", async () => {
		const configA: ProviderSettings = {
			apiProvider: "anthropic",
			apiModelId: "claude-a",
			reasoningEffort: "low",
		} as any
		const configB: ProviderSettings = {
			apiProvider: "openrouter",
			openRouterModelId: "openai/gpt-b",
			reasoningEffort: "high",
		} as any

		const createProvider = (apiConfiguration: ProviderSettings, currentApiConfigName: string) =>
			({
				context: {
					globalStorageUri: { fsPath: "/test/storage" },
				},
				getState: vi.fn().mockResolvedValue({ mode: "code", currentApiConfigName }),
				getRuntimeProviderProfile: vi.fn().mockReturnValue({
					currentMode: "code",
					currentApiConfigName,
					apiConfiguration,
				}),
				log: vi.fn(),
				on: vi.fn(),
				off: vi.fn(),
				postStateToWebview: vi.fn().mockResolvedValue(undefined),
				updateTaskHistory: vi.fn().mockResolvedValue(undefined),
			}) as unknown as ClineProvider

		const taskA = new Task({
			context: { globalStorageUri: { fsPath: "/test/storage" } } as any,
			provider: createProvider(configA, "profile-a"),
			apiConfiguration: configA,
			task: "session A",
			startTask: false,
		})
		const taskB = new Task({
			context: { globalStorageUri: { fsPath: "/test/storage" } } as any,
			provider: createProvider(configB, "profile-b"),
			apiConfiguration: configB,
			task: "session B",
			startTask: false,
		})

		expect(taskA.getSessionRuntimeConfig().modeBindings?.code).toMatchObject({
			mode: "code",
			apiConfigName: "profile-a",
			modelId: "claude-a",
			apiConfiguration: expect.objectContaining({ reasoningEffort: "low" }),
		})
		expect(taskB.getSessionRuntimeConfig().modeBindings?.code).toMatchObject({
			mode: "code",
			apiConfigName: "profile-b",
			modelId: "openai/gpt-b",
			apiConfiguration: expect.objectContaining({ reasoningEffort: "high" }),
		})
	})

	it("restores versioned history runtime without reading global provider defaults", async () => {
		const historyConfig: ProviderSettings = {
			apiProvider: "openrouter",
			openRouterModelId: "openai/gpt-4.1",
			reasoningEffort: "high",
			toolProtocol: "native",
		} as any
		const globalConfig: ProviderSettings = {
			apiProvider: "anthropic",
			apiModelId: "claude-global",
			apiKey: "global-key",
		} as any

		const mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/storage" },
			},
			getState: vi.fn().mockResolvedValue({
				mode: "code",
				currentApiConfigName: "global-profile",
			}),
			getRuntimeProviderProfile: vi.fn().mockReturnValue({
				currentMode: "code",
				currentApiConfigName: "global-profile",
				apiConfiguration: globalConfig,
			}),
			log: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider

		const task = new Task({
			context: mockProvider.context as any,
			provider: mockProvider,
			apiConfiguration: globalConfig,
			historyItem: {
				id: "history-session",
				number: 1,
				ts: Date.now(),
				task: "historical task",
				tokensIn: 0,
				tokensOut: 0,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0,
				mode: "code",
				apiConfigName: "legacy-profile",
				sessionRuntimeConfig: {
					version: 1,
					taskId: "history-session",
					currentMode: "architect",
					activeApiConfigName: "session-profile",
					activeProvider: "openrouter",
					activeModelId: "openai/gpt-4.1",
					toolProtocol: "native",
					updatedAt: Date.now(),
					modeBindings: {
						architect: {
							mode: "architect",
							apiConfigName: "session-profile",
							apiConfiguration: historyConfig,
							provider: "openrouter",
							modelId: "openai/gpt-4.1",
							toolProtocol: "native",
							updatedAt: Date.now(),
						},
					},
				},
			},
			startTask: false,
		})

		expect(await task.getTaskMode()).toBe("architect")
		expect(task.taskApiConfigName).toBe("session-profile")
		expect(task.getSessionApiConfiguration()).toMatchObject({
			apiProvider: "openrouter",
			openRouterModelId: "openai/gpt-4.1",
			reasoningEffort: "high",
			toolProtocol: "native",
		})
		expect(mockProvider.getState).not.toHaveBeenCalled()
	})

	it("lazy-migrates legacy history to a session runtime snapshot", async () => {
		const legacyConfig: ProviderSettings = {
			apiProvider: "openrouter",
			openRouterModelId: "legacy/model",
			toolProtocol: "native",
		} as any

		const mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/storage" },
			},
			getState: vi.fn().mockResolvedValue({
				mode: "code",
				currentApiConfigName: "global-profile",
			}),
			getRuntimeProviderProfile: vi.fn().mockReturnValue({
				currentMode: "code",
				currentApiConfigName: "global-profile",
				apiConfiguration: legacyConfig,
			}),
			log: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			updateTaskHistory: vi.fn().mockResolvedValue(undefined),
		} as unknown as ClineProvider

		const task = new Task({
			context: mockProvider.context as any,
			provider: mockProvider,
			apiConfiguration: legacyConfig,
			historyItem: {
				id: "legacy-session",
				number: 1,
				ts: Date.now(),
				task: "legacy task",
				tokensIn: 0,
				tokensOut: 0,
				cacheWrites: 0,
				cacheReads: 0,
				totalCost: 0,
				mode: "debug",
				apiConfigName: "legacy-profile",
				toolProtocol: "native",
			},
			startTask: false,
		})

		const runtime = task.getSessionRuntimeConfig()
		expect(runtime).toMatchObject({
			version: 1,
			taskId: "legacy-session",
			currentMode: "debug",
			activeApiConfigName: "legacy-profile",
			toolProtocol: "native",
			source: "legacy-history",
		})
		expect(runtime.modeBindings?.debug).toMatchObject({
			mode: "debug",
			apiConfigName: "legacy-profile",
			apiConfiguration: legacyConfig,
			toolProtocol: "native",
		})
	})
})
