// kilocode_change - new file
// npx vitest core/webview/__tests__/ClineProvider.kilocode-organization.spec.ts

import { setupCommonMocks, setupProvider, createMockWebviewView } from "../../../__tests__/common-mocks"

// Setup all mocks before any imports
setupCommonMocks()

describe("ClineProvider", () => {
	let provider: any
	let mockWebviewView: any

	beforeEach(() => {
		vi.clearAllMocks()
		const setup = setupProvider()
		provider = setup.provider
		mockWebviewView = createMockWebviewView()
	})

	describe("kilocodeOrganizationId", () => {
		test("preserves kilocodeOrganizationId when no previous token exists", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			const mockUpsertProviderProfile = vi.fn()
			;(provider as any).upsertProviderProfile = mockUpsertProviderProfile
			;(provider as any).providerSettingsManager = {
				getProfile: vi.fn().mockResolvedValue({
					// Simulate saved config with NO kilocodeToken (common case)
					name: "test-config",
					apiProvider: "anthropic",
					apiKey: "test-key",
					id: "test-id",
				}),
			} as any

			await messageHandler({
				type: "upsertApiConfiguration",
				text: "test-config",
				apiConfiguration: {
					apiProvider: "anthropic" as const,
					apiKey: "test-key",
					kilocodeToken: "test-kilo-token",
					kilocodeOrganizationId: "org-123",
				},
			})

			expect(mockUpsertProviderProfile).toHaveBeenCalledWith(
				"test-config",
				expect.objectContaining({
					kilocodeToken: "test-kilo-token",
					kilocodeOrganizationId: "org-123", // Should be preserved
				}),
				false, // activate parameter
			)
		})

		test("clears kilocodeOrganizationId when token actually changes", async () => {
			await provider.resolveWebviewView(mockWebviewView)
			const messageHandler = (mockWebviewView.webview.onDidReceiveMessage as any).mock.calls[0][0]

			const mockUpsertProviderProfile = vi.fn()
			;(provider as any).upsertProviderProfile = mockUpsertProviderProfile
			;(provider as any).providerSettingsManager = {
				getProfile: vi.fn().mockResolvedValue({
					// Simulate saved config with DIFFERENT kilocodeToken
					name: "test-config",
					apiProvider: "anthropic",
					apiKey: "test-key",
					kilocodeToken: "old-kilo-token",
					id: "test-id",
				}),
			} as any

			await messageHandler({
				type: "upsertApiConfiguration",
				text: "test-config",
				apiConfiguration: {
					apiProvider: "anthropic" as const,
					apiKey: "test-key",
					kilocodeToken: "new-kilo-token", // Different token
					kilocodeOrganizationId: "org-123",
				},
			})

			// Verify the organization ID was cleared for security
			expect(mockUpsertProviderProfile).toHaveBeenCalledWith(
				"test-config",
				expect.objectContaining({
					kilocodeToken: "new-kilo-token",
					kilocodeOrganizationId: undefined, // Should be cleared
				}),
				false, // activate parameter
			)
		})
	})

	describe("Kilo Code re-authentication", () => {
		const createSessionTask = (initialConfiguration: Record<string, unknown>) => {
			let sessionConfiguration = { ...initialConfiguration }
			let runtimeConfiguration = { ...initialConfiguration }
			let api = {
				getModel: vi.fn(() => ({ id: sessionConfiguration.kilocodeModel })),
			}
			const task: any = {
				apiConfiguration: { ...initialConfiguration },
				getSessionApiConfiguration: vi.fn(() => ({ ...sessionConfiguration })),
				getSessionRuntimeConfig: vi.fn(() => ({
					currentMode: "code",
					activeProvider: runtimeConfiguration.apiProvider,
					activeModelId: runtimeConfiguration.kilocodeModel,
					modeBindings: {
						code: { apiConfiguration: { ...runtimeConfiguration } },
					},
				})),
				api,
			}
			task.updateApiConfiguration = vi.fn((configuration) => {
				task.apiConfiguration = { ...configuration }
				sessionConfiguration = { ...configuration }
				runtimeConfiguration = { ...configuration }
				api = { getModel: vi.fn(() => ({ id: sessionConfiguration.kilocodeModel })) }
				task.api = api
			})
			return task
		}

		test("preserves an existing Kilo Code task model across re-authentication", async () => {
			const task = createSessionTask({
				apiProvider: "kilocode",
				kilocodeModel: "model-A",
				apiModelId: "stale-model-B",
				kilocodeOrganizationId: "org-A",
				kilocodeReasoningEffort: "high",
				toolProtocol: "native",
			})
			const originalApi = task.api
			;(provider as any).getCurrentTask = vi.fn().mockReturnValue(task)
			;(provider as any).getState = vi.fn().mockResolvedValue({
				apiConfiguration: { apiProvider: "kilocode", kilocodeModel: "sidebar-model" },
				currentApiConfigName: "default",
			})
			;(provider as any).upsertProviderProfile = vi.fn().mockResolvedValue(undefined)

			await provider.handleKiloCodeCallback("new-token")

			expect(task.updateApiConfiguration).toHaveBeenCalledWith(
				expect.objectContaining({ apiProvider: "kilocode", kilocodeModel: "model-A" }),
			)
			expect(task.api).not.toBe(originalApi)
			expect(task.api.getModel().id).toBe("model-A")
			expect(task.apiConfiguration).toMatchObject({
				apiProvider: "kilocode",
				kilocodeModel: "model-A",
				kilocodeToken: "new-token",
				kilocodeOrganizationId: "org-A",
			})
			expect(task.apiConfiguration.apiModelId).toBeUndefined()
			expect(task.getSessionApiConfiguration()).toEqual(task.apiConfiguration)
			expect(task.getSessionRuntimeConfig().activeModelId).toBe("model-A")
			expect(task.getSessionRuntimeConfig().modeBindings.code.apiConfiguration).toEqual(task.apiConfiguration)
		})

		test("migrates a non-Kilo Code task to the configured Kilo Code model without stale model fields", async () => {
			const task = createSessionTask({
				apiProvider: "openrouter",
				openRouterModelId: "openrouter-session-model",
				toolProtocol: "native",
			})
			;(provider as any).getCurrentTask = vi.fn().mockReturnValue(task)
			;(provider as any).getState = vi.fn().mockResolvedValue({
				apiConfiguration: {
					apiProvider: "kilocode",
					kilocodeModel: "configured-kilo-model",
					openRouterModelId: "stale-sidebar-model",
				},
				currentApiConfigName: "default",
			})
			;(provider as any).upsertProviderProfile = vi.fn().mockResolvedValue(undefined)

			await provider.handleKiloCodeCallback("new-token")

			expect(task.api.getModel().id).toBe("configured-kilo-model")
			expect(task.apiConfiguration).toMatchObject({
				apiProvider: "kilocode",
				kilocodeModel: "configured-kilo-model",
				kilocodeToken: "new-token",
			})
			expect(task.apiConfiguration.openRouterModelId).toBeUndefined()
			expect(task.getSessionRuntimeConfig().activeModelId).toBe("configured-kilo-model")
			expect(task.getSessionRuntimeConfig().modeBindings.code.apiConfiguration).toEqual(task.apiConfiguration)
		})
	})
})
