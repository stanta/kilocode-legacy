import { getModelId, withModelId, type ProviderSettings } from "../provider-settings.js"

describe("withModelId", () => {
	it.each([
		["kilocode", "kilocodeModel"],
		["openrouter", "openRouterModelId"],
		["requesty", "requestyModelId"],
		["anthropic", "apiModelId"],
	] as const)("writes %s model to %s without mutating the source", (apiProvider, modelIdKey) => {
		const source: ProviderSettings = {
			apiProvider,
			apiKey: "secret",
			apiModelId: "old-api-model",
			kilocodeModel: "old-kilocode-model",
			openRouterModelId: "old-openrouter-model",
			requestyModelId: "old-requesty-model",
		}

		const result = withModelId(source, "selected-model")

		expect(result).toMatchObject({ ok: true, modelIdKey })
		if (!result.ok) throw new Error(result.error)
		expect(result.settings).not.toBe(source)
		expect(result.settings).toMatchObject({ apiProvider, apiKey: "secret", [modelIdKey]: "selected-model" })
		expect(getModelId(result.settings)).toBe("selected-model")
		expect(source).toEqual({
			apiProvider,
			apiKey: "secret",
			apiModelId: "old-api-model",
			kilocodeModel: "old-kilocode-model",
			openRouterModelId: "old-openrouter-model",
			requestyModelId: "old-requesty-model",
		})
	})

	it("uses apiModelId for custom and faux providers", () => {
		for (const apiProvider of ["openai", "fake-ai"] as const) {
			const result = withModelId({ apiProvider }, "selected-model")
			expect(result).toMatchObject({ ok: true, modelIdKey: "apiModelId" })
		}
	})

	it("rejects selector-based vscode-lm instead of silently writing an incompatible model", () => {
		expect(withModelId({ apiProvider: "vscode-lm" }, "selected-model")).toEqual({
			ok: false,
			error: "Provider 'vscode-lm' does not support scalar model overrides in Agent Manager",
		})
	})
})
