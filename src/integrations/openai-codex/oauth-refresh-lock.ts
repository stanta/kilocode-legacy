import * as fs from "fs/promises"
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs"
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
const PENDING_SECRET_WRITE_FILE = ".openai-codex-secret-write-pending"

export class CodexOAuthStorageUncertainError extends Error {
	constructor() {
		super("Codex OAuth SecretStorage write is pending or uncertain; close all VS Code windows before recovery")
		this.name = "CodexOAuthStorageUncertainError"
	}
}

export function assertCodexSecretStorageSafe(context: Pick<ExtensionContext, "globalStorageUri">): void {
	const directory = context.globalStorageUri?.fsPath
	if (!directory) throw new CodexOAuthStorageUncertainError()
	if (existsSync(path.join(directory, PENDING_SECRET_WRITE_FILE))) {
		throw new CodexOAuthStorageUncertainError()
	}
}

/**
 * SecretStorage writes cannot be aborted once dispatched. Write a non-secret
 * pending marker synchronously *before* beginning the async operation.
 * A recovered/stolen lock cannot start a competing credential operation while
 * this write is pending. On loss of ownership or ambiguous failure the marker
 * stays in place and the credential domain fails closed until manual recovery.
 */
export async function writeCodexSecretUnderLock(
	context: Pick<ExtensionContext, "globalStorageUri">,
	lockSignal: AbortSignal,
	write: () => PromiseLike<void>,
): Promise<void> {
	assertCodexSecretStorageSafe(context)
	if (lockSignal.aborted) throw new Error("Codex OAuth lock lost before SecretStorage write")
	const marker = path.join(context.globalStorageUri.fsPath, PENDING_SECRET_WRITE_FILE)
	// Atomic exclusive creation, no access or refresh token (or account ID) on disk.
	writeFileSync(marker, "pending\n", { flag: "wx", mode: 0o600 })
	let acknowledged = false
	try {
		if (lockSignal.aborted) throw new Error("Codex OAuth lock lost during SecretStorage write")
		await write()
		if (lockSignal.aborted) throw new Error("Codex OAuth lock lost during SecretStorage write")
		acknowledged = true
	} finally {
		// Deleting the marker after a failed/compromised write could allow another
		// writer to race an operation whose persistence status is unknown.
		if (acknowledged) unlinkSync(marker)
	}
}

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
		assertCodexSecretStorageSafe(context)
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
