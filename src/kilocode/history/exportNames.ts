// kilocode_change - new file

export interface ExportNameFileSystemAdapter {
	readFile(path: string, encoding: "utf8"): Promise<string>
}

export const unknownExportDatePrefix = "unknown-date"

export async function getExportDatePrefix({
	fileSystem,
	uiMessagesPath,
	historyTimestamp,
}: {
	fileSystem: ExportNameFileSystemAdapter
	uiMessagesPath: string
	historyTimestamp?: number
}): Promise<string> {
	const uiMessageTimestamp = await readFirstUiMessageTimestamp(fileSystem, uiMessagesPath)

	return formatExportDatePrefix(uiMessageTimestamp ?? historyTimestamp)
}

export function formatExportDatePrefix(timestamp: number | undefined): string {
	if (timestamp === undefined || !Number.isFinite(timestamp)) {
		return unknownExportDatePrefix
	}

	const date = new Date(timestamp)

	if (Number.isNaN(date.getTime())) {
		return unknownExportDatePrefix
	}

	const day = padDatePart(date.getUTCDate())
	const month = padDatePart(date.getUTCMonth() + 1)
	const year = date.getUTCFullYear()
	const hours = padDatePart(date.getUTCHours())
	const minutes = padDatePart(date.getUTCMinutes())

	return `${day}-${month}-${year}_${hours}-${minutes}`
}

export function getSafeTaskId(taskId: string): string {
	return taskId.replace(/[^a-zA-Z0-9._-]/g, "_")
}

async function readFirstUiMessageTimestamp(
	fileSystem: ExportNameFileSystemAdapter,
	uiMessagesPath: string,
): Promise<number | undefined> {
	try {
		const content = await fileSystem.readFile(uiMessagesPath, "utf8")
		const parsed = JSON.parse(content) as unknown

		if (!Array.isArray(parsed)) {
			return undefined
		}

		for (const message of parsed) {
			if (!message || typeof message !== "object") {
				continue
			}

			const timestamp = (message as { ts?: unknown }).ts

			if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
				return timestamp
			}
		}

		return undefined
	} catch {
		return undefined
	}
}

function padDatePart(value: number): string {
	return value.toString().padStart(2, "0")
}
