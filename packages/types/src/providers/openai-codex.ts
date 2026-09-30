import type { ModelInfo } from "../model.js"

/**
 * OpenAI Codex Provider
 *
 * This provider uses OAuth authentication via a ChatGPT subscription instead
 * of direct API keys. Requests are routed to the Codex backend at
 * https://chatgpt.com/backend-api/codex/responses
 *
 * Key differences from openai-native:
 * - Uses OAuth Bearer tokens instead of API keys
 * - Subscription-based pricing (no per-token costs)
 * - Limited model subset available
 * - Custom routing to Codex backend
 */

export type OpenAiCodexModelId = keyof typeof openAiCodexModels

// GPT-6.1 Sol is OpenAI's recommended model for complex Codex workflows. // kilocode_change
export const openAiCodexDefaultModelId: OpenAiCodexModelId = "gpt-6.1-sol"

/**
 * Models currently available through ChatGPT sign-in for Codex.
 *
 * Keep this catalog aligned with https://developers.openai.com/codex/models.
 * Costs are 0 because usage is covered by the user's ChatGPT plan.
 */
export const openAiCodexModels = {
	// kilocode_change start
	"gpt-6.1-sol": {
		maxTokens: 128_000,
		contextWindow: 1_050_000,
		supportsNativeTools: true,
		defaultToolProtocol: "native",
		includedTools: ["apply_patch"],
		excludedTools: ["apply_diff", "write_to_file"],
		supportsImages: true,
		supportsComputerUse: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
		reasoningEffort: "medium",
		supportsVerbosity: true,
		inputPrice: 0,
		outputPrice: 0,
		supportsTemperature: false,
		description: "GPT-6.1 Sol: Near-Astra performance for complex coding and professional work",
	},
	"gpt-6-astra": {
		maxTokens: 128_000,
		contextWindow: 1_050_000,
		supportsNativeTools: true,
		defaultToolProtocol: "native",
		includedTools: ["apply_patch"],
		excludedTools: ["apply_diff", "write_to_file"],
		supportsImages: true,
		supportsComputerUse: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["low", "medium", "high", "xhigh", "max"],
		reasoningEffort: "medium",
		supportsVerbosity: true,
		inputPrice: 0,
		outputPrice: 0,
		supportsTemperature: false,
		description: "GPT-6 Astra: OpenAI's most capable model for demanding end-to-end work",
	},
	"gpt-6-sol": {
		maxTokens: 128_000,
		contextWindow: 1_050_000,
		supportsNativeTools: true,
		defaultToolProtocol: "native",
		includedTools: ["apply_patch"],
		excludedTools: ["apply_diff", "write_to_file"],
		supportsImages: true,
		supportsComputerUse: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
		reasoningEffort: "medium",
		supportsVerbosity: true,
		inputPrice: 0,
		outputPrice: 0,
		supportsTemperature: false,
		description: "GPT-6 Sol: Model for complex coding and agentic workflows",
	},
	"gpt-6-luna": {
		maxTokens: 128_000,
		contextWindow: 1_050_000,
		supportsNativeTools: true,
		defaultToolProtocol: "native",
		includedTools: ["apply_patch"],
		excludedTools: ["apply_diff", "write_to_file"],
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh", "max"],
		reasoningEffort: "medium",
		supportsVerbosity: true,
		inputPrice: 0,
		outputPrice: 0,
		supportsTemperature: false,
		description: "GPT-6 Luna: Efficient model for focused, high-volume coding tasks",
	},
	"gpt-5.6-sol": {
		maxTokens: 128_000,
		contextWindow: 1_050_000,
		supportsNativeTools: true,
		defaultToolProtocol: "native",
		includedTools: ["apply_patch"],
		excludedTools: ["apply_diff", "write_to_file"],
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh"],
		reasoningEffort: "medium",
		supportsVerbosity: true,
		inputPrice: 0,
		outputPrice: 0,
		supportsTemperature: false,
		description: "GPT-5.6 Sol: Frontier model retained during the GPT-6 rollout",
	},
	"gpt-5.6-terra": {
		maxTokens: 128_000,
		contextWindow: 1_050_000,
		supportsNativeTools: true,
		defaultToolProtocol: "native",
		includedTools: ["apply_patch"],
		excludedTools: ["apply_diff", "write_to_file"],
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh"],
		reasoningEffort: "medium",
		supportsVerbosity: true,
		inputPrice: 0,
		outputPrice: 0,
		supportsTemperature: false,
		description: "GPT-5.6 Terra: Balanced model retained during the GPT-6 rollout",
	},
	"gpt-5.6-luna": {
		maxTokens: 128_000,
		contextWindow: 1_050_000,
		supportsNativeTools: true,
		defaultToolProtocol: "native",
		includedTools: ["apply_patch"],
		excludedTools: ["apply_diff", "write_to_file"],
		supportsImages: true,
		supportsPromptCache: true,
		supportsReasoningEffort: ["none", "low", "medium", "high", "xhigh"],
		reasoningEffort: "medium",
		supportsVerbosity: true,
		inputPrice: 0,
		outputPrice: 0,
		supportsTemperature: false,
		description: "GPT-5.6 Luna: Efficient model retained during the GPT-6 rollout",
	},
	// kilocode_change end
} as const satisfies Record<string, ModelInfo>
