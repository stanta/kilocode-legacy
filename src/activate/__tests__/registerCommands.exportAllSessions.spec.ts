// kilocode_change - new file
import * as vscode from "vscode"

import { getCommandsMap } from "../registerCommands"
import { ClineProvider } from "../../core/webview/ClineProvider"
import { exportAllSessions } from "../../kilocode/history/exportAllSessions"

vi.mock("vscode", () => ({
	window: {
		showOpenDialog: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
}))

vi.mock("../../core/webview/ClineProvider", () => ({
	ClineProvider: {
		getVisibleInstance: vi.fn(),
	},
}))

vi.mock("../../kilocode/history/exportAllSessions", () => ({
	exportAllSessions: vi.fn(),
}))

vi.mock("../humanRelay", () => ({
	registerHumanRelayCallback: vi.fn(),
	unregisterHumanRelayCallback: vi.fn(),
	handleHumanRelayResponse: vi.fn(),
}))

vi.mock("../handleTask", () => ({
	handleNewTask: vi.fn(),
}))

vi.mock("../handleUri", () => ({
	handleUri: vi.fn(),
}))

vi.mock("../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: vi.fn(),
	},
}))

vi.mock("../../services/mdm/MdmService", () => ({
	MdmService: vi.fn(),
}))

vi.mock("../../core/kilocode/agent-manager/AgentManagerProvider", () => ({
	AgentManagerProvider: vi.fn(),
}))

vi.mock("../../core/config/importExport", () => ({
	exportSettings: vi.fn(),
	importSettingsWithFeedback: vi.fn(),
}))

vi.mock("../../utils/focusPanel", () => ({
	focusPanel: vi.fn(),
}))

vi.mock("../../utils/terminalCommandGenerator", () => ({
	generateTerminalCommand: vi.fn(),
}))

vi.mock("../../i18n", () => ({
	t: vi.fn((key: string) => key),
}))

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTitleButtonClicked: vi.fn(),
		},
	},
}))

vi.mock("@roo-code/types", async () => {
	const actual = await vi.importActual<object>("@roo-code/types")
	return {
		...actual,
		getAppUrl: vi.fn(() => "https://kilo.ai"),
	}
})

describe("exportAllSessions command", () => {
	const outputChannel = {
		appendLine: vi.fn(),
	} as unknown as vscode.OutputChannel

	const context = {
		subscriptions: [],
	} as unknown as vscode.ExtensionContext

	const visibleProvider = {
		contextProxy: { globalStorageUri: { fsPath: "/global-storage" } },
		getTaskHistory: vi.fn(() => []),
	} as unknown as ClineProvider

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(ClineProvider.getVisibleInstance).mockReturnValue(visibleProvider)
	})

	it("returns without exporting when folder selection is cancelled", async () => {
		vi.mocked(vscode.window.showOpenDialog).mockResolvedValue(undefined)

		await getCommandsMap({ context, outputChannel, provider: visibleProvider }).exportAllSessions()

		expect(vscode.window.showOpenDialog).toHaveBeenCalledWith({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			title: "Select folder to export all Kilo Code sessions",
		})
		expect(exportAllSessions).not.toHaveBeenCalled()
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("Kilo session export cancelled.")
	})

	it("passes the selected folder path to exportAllSessions", async () => {
		vi.mocked(vscode.window.showOpenDialog).mockResolvedValue([{ fsPath: "/selected/export" }] as vscode.Uri[])
		vi.mocked(exportAllSessions).mockResolvedValue({
			outputDir: "/selected/export",
			taskHistoryPath: "/selected/export/task_history.json",
			manifestPath: "/selected/export/export_manifest.json",
			storageBasePath: "/global-storage",
			total: 2,
			exported: 1,
			refreshed: 1,
			skipped: 0,
			failed: [],
			warnings: [],
		})

		await getCommandsMap({ context, outputChannel, provider: visibleProvider }).exportAllSessions()

		expect(exportAllSessions).toHaveBeenCalledWith(visibleProvider, { outputDir: "/selected/export" })
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
			"Exported 1, refreshed 1, skipped 0 of 2 Kilo session task directories, failed 0. Output: /selected/export",
		)
	})
})
