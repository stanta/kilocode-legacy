import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs/promises"
import { constants as fsConstants } from "fs"
import * as fsSync from "fs" // // kilocode_change

import { Package } from "../shared/package"
import { t } from "../i18n"
import { getKilocodeConfigFile } from "./kilo-config-file"

// kilocode_change start: project-local dialog session storage
export interface DialogSessionStorageOptions {
	workspaceRoot?: string
}

export interface DialogSessionStoragePaths {
	basePath: string
	tasksDir: string
	isProjectLocal: boolean
}

export function resolveDialogSessionsPath(
	workspaceRoot: string,
	configuredPath: string | undefined,
): string | undefined {
	if (!configuredPath || configuredPath.trim().length === 0) {
		return undefined
	}

	if (path.isAbsolute(configuredPath)) {
		return undefined
	}

	const resolvedWorkspaceRoot = path.resolve(workspaceRoot)
	const resolvedPath = path.resolve(resolvedWorkspaceRoot, configuredPath)

	if (resolvedPath !== resolvedWorkspaceRoot && !resolvedPath.startsWith(`${resolvedWorkspaceRoot}${path.sep}`)) {
		return undefined
	}

	return resolvedPath
}

export async function getDialogSessionStoragePaths(
	defaultPath: string,
	options: DialogSessionStorageOptions = {},
): Promise<DialogSessionStoragePaths> {
	if (options.workspaceRoot) {
		try {
			const config = await getKilocodeConfigFile(options.workspaceRoot)
			const projectDialogSessionsPath = resolveDialogSessionsPath(
				options.workspaceRoot,
				config?.project?.dialog_sessions_path,
			)

			if (projectDialogSessionsPath) {
				await fs.mkdir(projectDialogSessionsPath, { recursive: true })
				return {
					basePath: projectDialogSessionsPath,
					tasksDir: projectDialogSessionsPath,
					isProjectLocal: true,
				}
			}
		} catch (error) {
			console.warn(
				`Could not resolve project dialog sessions path - using default storage: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	const basePath = await getStorageBasePath(defaultPath)
	return {
		basePath,
		tasksDir: path.join(basePath, "tasks"),
		isProjectLocal: false,
	}
}

export function getDialogSessionStoragePathsSync(
	defaultPath: string,
	options: DialogSessionStorageOptions = {},
): DialogSessionStoragePaths {
	if (options.workspaceRoot) {
		try {
			const configPath = path.join(options.workspaceRoot, ".kilo", "config.json")
			const fallbackConfigPath = path.join(options.workspaceRoot, ".kilocode", "config.json")
			const readableConfigPath = fsSync.existsSync(configPath) ? configPath : fallbackConfigPath
			if (fsSync.existsSync(readableConfigPath)) {
				const parsedConfig = JSON.parse(fsSync.readFileSync(readableConfigPath, "utf8")) as {
					project?: { dialog_sessions_path?: unknown }
				}
				const projectDialogSessionsPath = resolveDialogSessionsPath(
					options.workspaceRoot,
					typeof parsedConfig.project?.dialog_sessions_path === "string"
						? parsedConfig.project.dialog_sessions_path
						: undefined,
				)

				if (projectDialogSessionsPath) {
					fsSync.mkdirSync(projectDialogSessionsPath, { recursive: true })
					return {
						basePath: projectDialogSessionsPath,
						tasksDir: projectDialogSessionsPath,
						isProjectLocal: true,
					}
				}
			}
		} catch (error) {
			console.warn(
				`Could not resolve project dialog sessions path - using default storage: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	const basePath = getStorageBasePathSync(defaultPath)
	return {
		basePath,
		tasksDir: path.join(basePath, "tasks"),
		isProjectLocal: false,
	}
}

export async function getDialogSessionsBasePath(
	defaultPath: string,
	options: DialogSessionStorageOptions = {},
): Promise<string> {
	return (await getDialogSessionStoragePaths(defaultPath, options)).basePath
}
// kilocode_change end

/**
 * Gets the base storage path for conversations
 * If a custom path is configured, uses that path
 * Otherwise uses the default VSCode extension global storage path
 */
export async function getStorageBasePath(defaultPath: string): Promise<string> {
	// Get user-configured custom storage path
	let customStoragePath = ""

	try {
		// This is the line causing the error in tests
		const config = vscode.workspace.getConfiguration(Package.name)
		customStoragePath = config.get<string>("customStoragePath", "")
	} catch (error) {
		console.warn("Could not access VSCode configuration - using default path")
		return defaultPath
	}

	// If no custom path is set, use default path
	if (!customStoragePath) {
		return defaultPath
	}

	try {
		// Ensure custom path exists
		await fs.mkdir(customStoragePath, { recursive: true })

		// Check directory write permission without creating temp files
		await fs.access(customStoragePath, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK)

		return customStoragePath
	} catch (error) {
		// If path is unusable, report error and fall back to default path
		console.error(`Custom storage path is unusable: ${error instanceof Error ? error.message : String(error)}`)
		if (vscode.window) {
			vscode.window.showErrorMessage(t("common:errors.custom_storage_path_unusable", { path: customStoragePath }))
		}
		return defaultPath
	}
}

// kilocode_change - start
export function getStorageBasePathSync(defaultPath: string): string {
	let customStoragePath = ""
	try {
		const config = vscode.workspace.getConfiguration(Package.name)
		customStoragePath = config.get<string>("customStoragePath", "")
	} catch (error) {
		console.warn("Could not access VSCode configuration - using default path")
		return defaultPath
	}
	if (!customStoragePath) {
		return defaultPath
	}
	try {
		fsSync.mkdirSync(customStoragePath, { recursive: true })
		const testFile = path.join(customStoragePath, ".write_test")
		fsSync.writeFileSync(testFile, "test")
		fsSync.rmSync(testFile)
		return customStoragePath
	} catch (error) {
		return defaultPath
	}
}
// kilocode_change - end

/**
 * Gets the storage directory path for a task
 */
export async function getTaskDirectoryPath(
	globalStoragePath: string,
	taskId: string,
	options: DialogSessionStorageOptions = {},
): Promise<string> {
	// kilocode_change start: allow project-local dialog session storage
	const { tasksDir } = await getDialogSessionStoragePaths(globalStoragePath, options)
	const taskDir = path.join(tasksDir, taskId)
	// kilocode_change end
	await fs.mkdir(taskDir, { recursive: true })
	return taskDir
}

/**
 * Gets the settings directory path
 */
export async function getSettingsDirectoryPath(globalStoragePath: string): Promise<string> {
	const basePath = await getStorageBasePath(globalStoragePath)
	const settingsDir = path.join(basePath, "settings")
	await fs.mkdir(settingsDir, { recursive: true })
	return settingsDir
}

/**
 * Gets the cache directory path
 */
export async function getCacheDirectoryPath(globalStoragePath: string): Promise<string> {
	const basePath = await getStorageBasePath(globalStoragePath)
	const cacheDir = path.join(basePath, "cache")
	await fs.mkdir(cacheDir, { recursive: true })
	return cacheDir
}

// kilocode_change - start
/**
 * Gets the local vector store directory path
 */
export function getLancedbVectorStoreDirectoryPath(globalStoragePath: string): string {
	const basePath = getStorageBasePathSync(globalStoragePath)
	const cacheDir = path.join(basePath, "vector")
	fsSync.mkdirSync(cacheDir, { recursive: true })
	return cacheDir
}
// kilocode_change - end

/**
 * Prompts the user to set a custom storage path
 * Displays an input box allowing the user to enter a custom path
 */
export async function promptForCustomStoragePath(): Promise<void> {
	if (!vscode.window || !vscode.workspace) {
		console.error("VS Code API not available")
		return
	}

	let currentPath = ""
	try {
		const currentConfig = vscode.workspace.getConfiguration(Package.name)
		currentPath = currentConfig.get<string>("customStoragePath", "")
	} catch (error) {
		console.error("Could not access configuration")
		return
	}

	const result = await vscode.window.showInputBox({
		value: currentPath,
		placeHolder: t("common:storage.path_placeholder"),
		prompt: t("common:storage.prompt_custom_path"),
		validateInput: (input) => {
			if (!input) {
				return null // Allow empty value (use default path)
			}

			try {
				// Validate path format
				path.parse(input)

				// Check if path is absolute
				if (!path.isAbsolute(input)) {
					return t("common:storage.enter_absolute_path")
				}

				return null // Path format is valid
			} catch (e) {
				return t("common:storage.enter_valid_path")
			}
		},
	})

	// If user canceled the operation, result will be undefined
	if (result !== undefined) {
		try {
			const currentConfig = vscode.workspace.getConfiguration(Package.name)
			await currentConfig.update("customStoragePath", result, vscode.ConfigurationTarget.Global)

			if (result) {
				try {
					// Test if path is accessible
					await fs.mkdir(result, { recursive: true })
					await fs.access(result, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK)
					vscode.window.showInformationMessage(t("common:info.custom_storage_path_set", { path: result }))
				} catch (error) {
					vscode.window.showErrorMessage(
						t("common:errors.cannot_access_path", {
							path: result,
							error: error instanceof Error ? error.message : String(error),
						}),
					)
				}
			} else {
				vscode.window.showInformationMessage(t("common:info.default_storage_path"))
			}
		} catch (error) {
			console.error("Failed to update configuration", error)
		}
	}
}
