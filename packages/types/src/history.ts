import { z } from "zod"

import { providerSettingsSchema } from "./provider-settings.js"
import { toolProtocolSchema } from "./tool.js"

// kilocode_change start: versioned per-session runtime configuration
export const sessionRuntimeModeBindingSchema = z.object({
	mode: z.string(),
	apiConfigName: z.string().optional(),
	apiConfiguration: providerSettingsSchema,
	provider: z.string().optional(),
	modelId: z.string().optional(),
	toolProtocol: toolProtocolSchema.optional(),
	updatedAt: z.number(),
	source: z
		.enum([
			"new-session",
			"history",
			"legacy-history",
			"mode-switch",
			"profile-switch",
			"global-default",
			"fallback",
		])
		.optional(),
})

export const sessionRuntimeConfigSchema = z.object({
	version: z.literal(1),
	sessionId: z.string().optional(),
	taskId: z.string().optional(),
	currentMode: z.string().optional(),
	modeBindings: z.record(z.string(), sessionRuntimeModeBindingSchema).optional(),
	activeApiConfigName: z.string().optional(),
	activeProvider: z.string().optional(),
	activeModelId: z.string().optional(),
	toolProtocol: toolProtocolSchema.optional(),
	updatedAt: z.number().optional(),
	source: z
		.enum([
			"new-session",
			"history",
			"legacy-history",
			"mode-switch",
			"profile-switch",
			"global-default",
			"fallback",
		])
		.optional(),
})

export type SessionRuntimeModeBinding = z.infer<typeof sessionRuntimeModeBindingSchema>
export type SessionRuntimeConfig = z.infer<typeof sessionRuntimeConfigSchema>
// kilocode_change end

/**
 * HistoryItem
 */

export const historyItemSchema = z.object({
	id: z.string(),
	rootTaskId: z.string().optional(),
	parentTaskId: z.string().optional(),
	number: z.number(),
	ts: z.number(),
	task: z.string(),
	tokensIn: z.number(),
	tokensOut: z.number(),
	cacheWrites: z.number().optional(),
	cacheReads: z.number().optional(),
	totalCost: z.number(),
	size: z.number().optional(),
	workspace: z.string().optional(),
	isFavorited: z.boolean().optional(), // kilocode_change
	mode: z.string().optional(),
	/**
	 * The tool protocol used by this task. Once a task uses tools with a specific
	 * protocol (XML or Native), it is permanently locked to that protocol.
	 *
	 * - "xml": Tool calls are parsed from XML text (no tool IDs)
	 * - "native": Tool calls come as tool_call chunks with IDs
	 *
	 * This ensures task resumption works correctly even when NTC settings change.
	 */
	toolProtocol: z.enum(["xml", "native"]).optional(),
	apiConfigName: z.string().optional(), // Provider profile name for sticky profile feature
	sessionRuntimeConfig: sessionRuntimeConfigSchema.optional(), // kilocode_change: session-local mode/profile/model bindings
	status: z.enum(["active", "completed", "delegated"]).optional(),
	delegatedToId: z.string().optional(), // Last child this parent delegated to
	childIds: z.array(z.string()).optional(), // All children spawned by this task
	awaitingChildId: z.string().optional(), // Child currently awaited (set when delegated)
	completedByChildId: z.string().optional(), // Child that completed and resumed this parent
	completionResultSummary: z.string().optional(), // Summary from completed child
})

export type HistoryItem = z.infer<typeof historyItemSchema>
