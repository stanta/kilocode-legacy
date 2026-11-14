import { VirtualQuotaFallbackHandler } from "../virtual-quota-fallback"

describe("Virtual quota wrapper respects Codex request ownership", () => {
	function fakeWrapper(createMessage: (...args: any[]) => AsyncGenerator<any>) {
		const handler = Object.create(VirtualQuotaFallbackHandler.prototype) as any
		const delegate = vi.fn(createMessage)
		handler.initialize = vi.fn(async () => {})
		handler.adjustActiveHandler = vi.fn(async () => {})
		handler.activeHandler = { createMessage: delegate }
		handler.activeProfileId = "synthetic-profile"
		handler.usage = { consume: vi.fn(async () => {}), setCooldown: vi.fn(async () => {}) }
		return { handler: handler as VirtualQuotaFallbackHandler, delegate, adjust: handler.adjustActiveHandler }
	}

	it("does not switch providers after a typed Codex request error", async () => {
		const error = Object.assign(new Error("Codex HTTP 429"), {
			codexRequest: true,
			status: 429,
			safeToRetry: true,
		})
		const { handler, delegate, adjust } = fakeWrapper(async function* () {
			throw error
		})
		await expect(async () => {
			for await (const _ of handler.createMessage("test", [])) {
			}
		}).rejects.toBe(error)
		expect(delegate).toHaveBeenCalledTimes(1)
		expect(adjust).not.toHaveBeenCalledWith("Retryable Error")
	})

	it("does not replay after reasoning or tool output, even if HTTP error looks retryable", async () => {
		const { handler, delegate, adjust } = fakeWrapper(async function* () {
			yield { type: "reasoning", text: "partially accepted" }
			throw Object.assign(new Error("rate limit"), { status: 429 })
		})
		const received: unknown[] = []
		await expect(async () => {
			for await (const chunk of handler.createMessage("test", [])) received.push(chunk)
		}).rejects.toThrow(/rate limit/)
		expect(received).toEqual([{ type: "reasoning", text: "partially accepted" }])
		expect(delegate).toHaveBeenCalledTimes(1)
		expect(adjust).not.toHaveBeenCalledWith("Retryable Error")
	})

	it("passes cancellation options to the delegated Codex handler", async () => {
		const controller = new AbortController()
		const { handler, delegate } = fakeWrapper(async function* () {
			yield { type: "text", text: "ok" }
		})
		for await (const _ of handler.createMessage("test", [], undefined, { signal: controller.signal })) {
		}
		expect(delegate).toHaveBeenCalledWith("test", [], undefined, { signal: controller.signal })
	})
})
