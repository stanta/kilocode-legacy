import * as fs from "fs/promises"
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
	try {
		if (compromised) throw new Error("OpenAI Codex OAuth lock was lost")
		const result = await action(controller.signal)
		if (compromised) throw new Error("OpenAI Codex OAuth lock was lost")
		return result
	} finally {
		controller.abort()
		try {
			await release()
		} catch (error) {
			if (!compromised) throw error
		}
	}
}
