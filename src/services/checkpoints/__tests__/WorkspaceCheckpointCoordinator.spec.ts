import { describe, it, expect, vi, afterEach } from "vitest"

import { WorkspaceCheckpointCoordinator } from "../WorkspaceCheckpointCoordinator"

describe("WorkspaceCheckpointCoordinator", () => {
	afterEach(() => {
		WorkspaceCheckpointCoordinator.resetForTests()
		vi.useRealTimers()
	})

	it("serializes concurrent operations for the same workspace", async () => {
		const order: string[] = []
		let activeOperations = 0
		let maxActiveOperations = 0

		const runOperation = (name: string) =>
			WorkspaceCheckpointCoordinator.withWorkspaceLock("/test/workspace", async () => {
				activeOperations += 1
				maxActiveOperations = Math.max(maxActiveOperations, activeOperations)
				order.push(`${name}:start`)
				await Promise.resolve()
				order.push(`${name}:end`)
				activeOperations -= 1
			})

		await Promise.all([runOperation("first"), runOperation("second"), runOperation("third")])

		expect(maxActiveOperations).toBe(1)
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end", "third:start", "third:end"])
	})
})
