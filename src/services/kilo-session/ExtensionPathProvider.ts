import * as vscode from "vscode"
import * as path from "path"
import { createHash } from "crypto"
import { existsSync, mkdirSync } from "fs"
import type { IPathProvider } from "../../shared/kilocode/cli-sessions/types/IPathProvider"
import { getDialogSessionStoragePathsSync, type DialogSessionStorageOptions } from "../../utils/storage"

export class ExtensionPathProvider implements IPathProvider {
	private readonly globalStoragePath: string
	private readonly storageOptions: DialogSessionStorageOptions // kilocode_change: project-local dialog session storage

	constructor(context: vscode.ExtensionContext, storageOptions: DialogSessionStorageOptions = {}) {
		this.globalStoragePath = context.globalStorageUri.fsPath
		this.storageOptions = storageOptions // kilocode_change: project-local dialog session storage
	}

	getTasksDir(): string {
		return getDialogSessionStoragePathsSync(this.globalStoragePath, this.storageOptions).tasksDir
	}

	getSessionFilePath(workspaceName: string): string {
		const hash = createHash("sha256").update(workspaceName).digest("hex").substring(0, 16)
		const workspaceDir = path.join(this.globalStoragePath, "sessions", hash)

		if (!existsSync(workspaceDir)) {
			mkdirSync(workspaceDir, { recursive: true })
		}

		return path.join(workspaceDir, "session.json")
	}
}
