// kilocode_change - new file
import path from "path"

type RestoreListener = (event: { workspacePath: string; sourceTaskId: string; commitHash: string }) => void

export class WorkspaceCheckpointCoordinator {
	private static readonly operationTails = new Map<string, Promise<void>>()
	private static readonly listeners = new Map<string, Set<RestoreListener>>()

	private static normalizeWorkspacePath(workspacePath: string): string {
		return path.resolve(workspacePath)
	}

	static async withWorkspaceLock<T>(workspacePath: string, operation: () => Promise<T>): Promise<T> {
		const key = this.normalizeWorkspacePath(workspacePath)
		const previousTail = this.operationTails.get(key) ?? Promise.resolve()

		let release!: () => void
		const currentTail = new Promise<void>((resolve) => {
			release = resolve
		})
		const queuedTail = previousTail.then(() => currentTail)
		this.operationTails.set(key, queuedTail)

		await previousTail

		try {
			return await operation()
		} finally {
			release()
			if (this.operationTails.get(key) === queuedTail) {
				this.operationTails.delete(key)
			}
		}
	}

	static subscribe(workspacePath: string, listener: RestoreListener): () => void {
		const key = this.normalizeWorkspacePath(workspacePath)
		const listeners = this.listeners.get(key) ?? new Set<RestoreListener>()
		listeners.add(listener)
		this.listeners.set(key, listeners)

		return () => {
			const currentListeners = this.listeners.get(key)
			currentListeners?.delete(listener)
			if (currentListeners?.size === 0) {
				this.listeners.delete(key)
			}
		}
	}

	static broadcastRestore(workspacePath: string, event: { sourceTaskId: string; commitHash: string }): void {
		const key = this.normalizeWorkspacePath(workspacePath)
		for (const listener of this.listeners.get(key) ?? []) {
			listener({ workspacePath: key, ...event })
		}
	}

	static resetForTests(): void {
		this.operationTails.clear()
		this.listeners.clear()
	}
}
