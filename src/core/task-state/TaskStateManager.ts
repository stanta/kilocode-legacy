// kilocode_change - new file
import type { TaskExecutionStateV1, TodoItem } from "@roo-code/types"
import { taskExecutionStateV1Schema } from "@roo-code/types"

const DEFAULT_RENDER_BUDGET = 12_000
const MIN_GOAL_CHARS = 1_000

function cloneState(state: TaskExecutionStateV1): TaskExecutionStateV1 {
	return structuredClone(state)
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value
	return value.slice(0, Math.max(0, max - 1)) + "…"
}

function escapeXmlSensitiveJson(json: string): string {
	// Keep the payload valid JSON while preventing user-controlled text from closing
	// the wrapper element or introducing XML markup around the state block.
	return json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
}

export class TaskStateManager {
	private state: TaskExecutionStateV1

	private constructor(state: TaskExecutionStateV1) {
		this.state = state
	}

	static create(originalGoal: string, todos: TodoItem[] = [], source: "runtime" | "resume-fallback" = "runtime") {
		const now = Date.now()
		const state: TaskExecutionStateV1 = {
			version: 1,
			revision: 0,
			originalGoal: truncate(originalGoal ?? "", 8_000),
			currentGoal: truncate(originalGoal ?? "", 4_000),
			progress: {
				todos: todos.slice(0, 100).map((todo) => ({
					id: truncate(todo.id, 256),
					content: truncate(todo.content, 2_000),
					status: todo.status,
				})),
			},
			files: [],
			decisions: [],
			hypotheses: [],
			constraints: [],
			pendingQuestions: [],
			observations: [],
			provenance: { createdAt: now, updatedAt: now, source },
		}
		return new TaskStateManager(taskExecutionStateV1Schema.parse(state))
	}

	static fromUnknown(value: unknown): TaskStateManager | undefined {
		const parsed = taskExecutionStateV1Schema.safeParse(value)
		return parsed.success ? new TaskStateManager(parsed.data) : undefined
	}

	getSnapshot(): TaskExecutionStateV1 {
		return cloneState(this.state)
	}

	syncTodos(todos: TodoItem[]): boolean {
		const normalized = todos.slice(0, 100).map((todo) => ({
			id: truncate(todo.id, 256),
			content: truncate(todo.content, 2_000),
			status: todo.status,
		}))
		if (JSON.stringify(normalized) === JSON.stringify(this.state.progress.todos)) return false

		this.state.progress.todos = normalized
		this.state.revision += 1
		this.state.provenance.updatedAt = Date.now()
		return true
	}

	render(maxChars: number = DEFAULT_RENDER_BUDGET): string {
		const budget = Math.max(2_000, maxChars)
		const working = this.getSnapshot()
		const serialize = () => escapeXmlSensitiveJson(JSON.stringify(working))
		const wrap = (json: string) =>
			`<task_execution_state version="1" revision="${working.revision}">${json}</task_execution_state>`

		let rendered = wrap(serialize())
		if (rendered.length <= budget) return rendered

		// Deterministic compaction order: remove the most replaceable/recoverable
		// collections first, preserving goals and active todo progress longest.
		for (const key of ["observations", "hypotheses", "pendingQuestions", "decisions", "constraints", "files"] as const) {
			const collection = working[key]
			while (collection.length > 0 && rendered.length > budget) {
				collection.pop()
				rendered = wrap(serialize())
			}
		}

		while (working.progress.todos.length > 1 && rendered.length > budget) {
			working.progress.todos.pop()
			rendered = wrap(serialize())
		}

		if (rendered.length > budget) {
			working.originalGoal = truncate(working.originalGoal, MIN_GOAL_CHARS)
			working.currentGoal = truncate(working.currentGoal, MIN_GOAL_CHARS)
			rendered = wrap(serialize())
		}

		// Schema bounds plus the reductions above normally make this unnecessary.
		// Keep the wrapper valid even for an unusually small caller-supplied budget.
		return rendered.length <= budget ? rendered : wrap(
			escapeXmlSensitiveJson(JSON.stringify({
				version: working.version,
				revision: working.revision,
				currentGoal: truncate(working.currentGoal, 512),
				progress: { todos: working.progress.todos.slice(0, 1) },
				provenance: working.provenance,
			})),
		)
	}
}
