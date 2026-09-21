// kilocode_change - new file
import { z } from "zod"

import { todoStatusSchema } from "./todo.js"

const boundedText = (max: number) => z.string().max(max)

export const taskExecutionStateTodoSchema = z.object({
	id: boundedText(256),
	content: boundedText(2_000),
	status: todoStatusSchema,
})

export const taskExecutionStateFileSchema = z.object({
	path: boundedText(1_024),
	status: z.enum(["read", "modified", "created", "deleted", "referenced"]),
	note: boundedText(1_000).optional(),
})

export const taskExecutionStateHypothesisSchema = z.object({
	text: boundedText(2_000),
	status: z.enum(["active", "tested", "rejected", "confirmed"]),
	evidence: boundedText(2_000).optional(),
})

export const taskExecutionStateV1Schema = z.object({
	version: z.literal(1),
	revision: z.number().int().nonnegative(),
	originalGoal: boundedText(8_000),
	currentGoal: boundedText(4_000),
	progress: z.object({
		todos: z.array(taskExecutionStateTodoSchema).max(100),
	}),
	files: z.array(taskExecutionStateFileSchema).max(100),
	decisions: z.array(boundedText(2_000)).max(50),
	hypotheses: z.array(taskExecutionStateHypothesisSchema).max(50),
	constraints: z.array(boundedText(2_000)).max(50),
	pendingQuestions: z.array(boundedText(2_000)).max(50),
	observations: z.array(boundedText(2_000)).max(100),
	provenance: z.object({
		createdAt: z.number().int().nonnegative(),
		updatedAt: z.number().int().nonnegative(),
		source: z.enum(["runtime", "resume-fallback", "model"]),
	}),
})

export type TaskExecutionStateV1 = z.infer<typeof taskExecutionStateV1Schema>
export type TaskExecutionStateFile = z.infer<typeof taskExecutionStateFileSchema>
export type TaskExecutionStateHypothesis = z.infer<typeof taskExecutionStateHypothesisSchema>
