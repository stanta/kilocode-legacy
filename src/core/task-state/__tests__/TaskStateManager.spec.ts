import { describe, expect, it } from "vitest"

import { TaskStateManager } from "../TaskStateManager"

describe("TaskStateManager", () => {
	it("initializes a bounded versioned state from the task goal and todos", () => {
		const manager = TaskStateManager.create("Fix context growth", [
			{ id: "1", content: "Inspect history", status: "in_progress" },
		])
		const state = manager.getSnapshot()

		expect(state.version).toBe(1)
		expect(state.revision).toBe(0)
		expect(state.originalGoal).toBe("Fix context growth")
		expect(state.currentGoal).toBe("Fix context growth")
		expect(state.progress.todos).toEqual([{ id: "1", content: "Inspect history", status: "in_progress" }])
	})

	it("increments revision only when synchronized todos actually change", () => {
		const manager = TaskStateManager.create("Goal", [])
		expect(manager.syncTodos([])).toBe(false)
		expect(manager.getSnapshot().revision).toBe(0)

		expect(manager.syncTodos([{ id: "a", content: "Do work", status: "pending" }])).toBe(true)
		expect(manager.getSnapshot().revision).toBe(1)

		expect(manager.syncTodos([{ id: "a", content: "Do work", status: "pending" }])).toBe(false)
		expect(manager.getSnapshot().revision).toBe(1)
	})

	it("rejects invalid persisted state", () => {
		expect(TaskStateManager.fromUnknown({ version: 999 })).toBeUndefined()
	})

	it("renders a compact XML wrapper and neutralizes embedded closing tags", () => {
		const manager = TaskStateManager.create("</task_execution_state><malicious>", [])
		const rendered = manager.render()

		expect(rendered).toContain('<task_execution_state version="1" revision="0">')
		expect(rendered).toContain("\\u003c/task_execution_state\\u003e")
		expect(rendered.match(/<\/task_execution_state>/g)).toHaveLength(1)
	})

	it("compacts recoverable collections before goals and todo progress", () => {
		const base = TaskStateManager.create("Keep this goal", [{ id: "1", content: "Keep this todo", status: "pending" }]).getSnapshot()
		base.observations = Array.from({ length: 100 }, (_, i) => `observation-${i}-${"x".repeat(1000)}`)
		const manager = TaskStateManager.fromUnknown(base)
		expect(manager).toBeDefined()

		const rendered = manager!.render(2_000)
		expect(rendered.length).toBeLessThanOrEqual(2_000)
		expect(rendered).toContain("Keep this goal")
		expect(rendered).toContain("Keep this todo")
	})
})
