// npx vitest run api/providers/__tests__/openai-codex.spec.ts

import { openAiCodexModels } from "@roo-code/types"

import { OpenAiCodexHandler } from "../openai-codex"

describe("OpenAiCodexHandler.getModel", () => {
	const currentModelIds = [
		"gpt-6.1-sol",
		"gpt-6-astra",
		"gpt-6-sol",
		"gpt-6-luna",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
	]

	it.each(currentModelIds)("should return specified model when a valid model id is provided: %s", (apiModelId) => {
		const handler = new OpenAiCodexHandler({ apiModelId })
		const model = handler.getModel()

		expect(model.id).toBe(apiModelId)
		expect(model.info).toBeDefined()
		// All current subscription models default to medium reasoning.
		expect(model.info.reasoningEffort).toBe("medium")
	})

	it("should expose only the current subscription catalog", () => {
		expect(Object.keys(openAiCodexModels)).toEqual(currentModelIds)
	})

	it.each(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"])(
		"should expose current GPT-6 model capabilities: %s",
		(apiModelId) => {
			const model = new OpenAiCodexHandler({ apiModelId }).getModel()

			expect(model.info.contextWindow).toBe(1_050_000)
			expect(model.info.maxTokens).toBe(128_000)
			expect(model.info.supportsImages).toBe(true)
			expect(model.info.supportsNativeTools).toBe(true)
			expect(model.info.supportsPromptCache).toBe(true)
			expect(model.info.supportsReasoningEffort).toContain("max")
		},
	)

	it.each([
		"gpt-5.5",
		"gpt-5.4",
		"gpt-5.3-codex",
		"gpt-5.2",
		"gpt-5.2-codex",
		"gpt-5.1-codex-max",
		"gpt-5.1-codex",
		"gpt-5.1-codex-mini",
		"gpt-5.1",
		"gpt-5-codex",
		"gpt-5-codex-mini",
		"gpt-5",
	])("should fall back when an obsolete subscription model is provided: %s", (apiModelId) => {
		const handler = new OpenAiCodexHandler({ apiModelId })

		expect(handler.getModel().id).toBe("gpt-6.1-sol")
	})

	it("should fall back to default model when an invalid model id is provided", () => {
		const handler = new OpenAiCodexHandler({ apiModelId: "not-a-real-model" })
		const model = handler.getModel()

		expect(model.id).toBe("gpt-6.1-sol")
		expect(model.info).toBeDefined()
	})
})
