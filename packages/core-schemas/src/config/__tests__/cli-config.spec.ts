import { describe, expect, it } from "vitest"
import { DEFAULT_MAX_CONCURRENT_FILE_READS, cliConfigSchema, isValidConfig } from "../cli-config.js"

describe("cliConfigSchema", () => {
	const validConfig = {
		version: "1.0.0",
		mode: "code",
		telemetry: true,
		provider: "primary",
		providers: [{ id: "primary", provider: "kilocode" }],
	}

	it("accepts a valid config and applies the concurrent-read default", () => {
		const config = cliConfigSchema.parse(validConfig)

		expect(config.maxConcurrentFileReads).toBe(DEFAULT_MAX_CONCURRENT_FILE_READS)
		expect(isValidConfig(config)).toBe(true)
	})

	it("rejects invalid versions and non-positive concurrent-read limits", () => {
		expect(isValidConfig({ ...validConfig, version: "2.0.0" })).toBe(false)
		expect(isValidConfig({ ...validConfig, maxConcurrentFileReads: 0 })).toBe(false)
	})
})
