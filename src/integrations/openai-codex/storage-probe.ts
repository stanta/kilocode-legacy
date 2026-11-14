import { createHash, randomUUID } from "crypto"
import * as vscode from "vscode"

const PROBE_KEY = "openai-codex-secretstorage-probe-synthetic-v1"

export type CodexStorageProbeAction = "write" | "read" | "clear"

/**
 * Operates on a dedicated synthetic SecretStorage key, never the OAuth credentials.
 * The domain fingerprint hashes only the extension's local storage PATH, not a token.
 * Matching marker + domain in two VS Code windows is required before cross-window QA.
 */
export async function codexStorageProbe(
	context: Pick<vscode.ExtensionContext, "secrets" | "globalStorageUri">,
	action: CodexStorageProbeAction,
): Promise<{ domain: string; marker: string | undefined }> {
	const uri = context.globalStorageUri
	if (!uri?.fsPath || uri.scheme !== "file") {
		throw new Error("Codex storage probe requires local VS Code extension storage")
	}
	const domain = createHash("sha256").update(uri.fsPath).digest("hex").slice(0, 12)
	let marker: string | undefined
	if (action === "write") {
		marker = randomUUID()
		await context.secrets.store(PROBE_KEY, marker)
		if ((await context.secrets.get(PROBE_KEY)) !== marker) {
			throw new Error("VS Code SecretStorage did not read back the synthetic marker")
		}
	} else if (action === "read") {
		marker = await context.secrets.get(PROBE_KEY)
	} else {
		await context.secrets.delete(PROBE_KEY)
	}
	return { domain, marker }
}

export function registerCodexStorageProbe(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
): vscode.Disposable {
	return vscode.commands.registerCommand("kilo-code.codexStorageProbe", async () => {
		const action = await vscode.window.showQuickPick(
			[
				{ label: "Write synthetic marker in window A", action: "write" as const },
				{ label: "Read synthetic marker in window B", action: "read" as const },
				{ label: "Clear synthetic marker", action: "clear" as const },
			],
			{ placeHolder: "Codex SecretStorage verification (no OAuth credentials read or written)" },
		)
		if (!action) return
		try {
			const result = await codexStorageProbe(context, action.action)
			const message =
				"Codex probe: domain=" + result.domain + "; synthetic marker=" + (result.marker ?? "missing")
			output.appendLine(message)
			await vscode.window.showInformationMessage(message)
		} catch {
			await vscode.window.showErrorMessage("Codex SecretStorage probe failed; check the extension storage domain")
		}
	})
}
