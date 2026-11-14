import * as fs from "fs/promises"
import { readFileSync } from "fs"
import { randomUUID } from "crypto"
import * as path from "path"
import * as lockfile from "proper-lockfile"
import type { ExtensionContext } from "vscode"

/**
 * One local lock per extension/profile credential store. This must NOT be keyed
 * by workspace, task, model, account or token. Secrets never enter the lock file.
 *
 * Only supported when VS Code exposes a local globalStorageUri. Different
 * profiles and remote extension hosts are separate, unverified domains.
 */
const CREDENTIAL_EPOCH_FILE = ".openai-codex-session-epoch"

/** Non-secret generation, shared by collaborating windows in the same credential domain. */
export function getCodexCredentialEpoch(context: Pick<ExtensionContext, "globalStorageUri">): string {
	const directory = context.globalStorageUri?.fsPath
	if (!directory) throw new Error("Codex OAuth credential domain unavailable")
	try {
		return readFileSync(path.join(directory, CREDENTIAL_EPOCH_FILE), "utf8").trim() || "0"
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "0"
		throw error
	}
}

/** Advance only under withCodexOAuthLock, before committing login/logout. */
export async function advanceCodexCredentialEpoch(context: Pick<ExtensionContext, "globalStorageUri">): Promise<void> {
	await fs.writeFile(path.join(context.globalStorageUri.fsPath, CREDENTIAL_EPOCH_FILE), randomUUID(), { mode: 0o600 })
}

export async function withCodexOAuthLock<T>(
	context: Pick<ExtensionContext, "globalStorageUri">,
	action: (lockSignal: AbortSignal) => Promise<T>,
): Promise<T> {
	const directory = context.globalStorageUri?.fsPath
	if (!directory || (context.globalStorageUri.scheme && context.globalStorageUri.scheme !== "file")) {
		throw new Error("OpenAI Codex OAuth requires local extension globalStorageUri for coordinated credentials")
	}
	await fs.mkdir(directory, { recursive: true })
	const controller = new AbortController()
	let compromised = false
	const release = await lockfile.lock(path.join(directory, ".openai-codex-oauth"), {
		realpath: false,
		stale: 60000,
		update: 15000,
		retries: { retries: 15, minTimeout: 150, maxTimeout: 2000, factor: 1.4 },
		onCompromised: () => {
			compromised = true
			controller.abort(new Error("OpenAI Codex OAuth lock was lost"))
		},
	})
	let result!: T
	let actionFailed = false
	let actionError: unknown
	let releaseError: unknown
	try {
		if (compromised) throw new Error("OpenAI Codex OAuth lock was lost")
		result = await action(controller.signal)
		if (compromised) throw new Error("OpenAI Codex OAuth lock was lost")
	} catch (error) {
		actionFailed = true
		actionError = error
	} finally {
		controller.abort()
		try {
			await release()
		} catch (error) {
			releaseError = error
		}
	}
	if (actionFailed) throw actionError
	if (compromised) throw new Error("OpenAI Codex OAuth lock was lost")
	if (releaseError) throw releaseError
	return result
}
