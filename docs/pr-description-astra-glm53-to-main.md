# PR: Merge `astra_glm53` into `main`

## Title

feat: new models (GLM-5.3, GPT-6 Astra, GPT-5.6), session exports, per-session model isolation, and DeepSeek V4 Pro/Flash

## Summary

This PR merges the `astra_glm53` branch into `main` via fast-forward (`ae046acafd..9fdf336382`), bringing in **24 commits** across **132 files changed (9,652 insertions, 623 deletions)**. The work spans four themes: new model support across four providers, a complete session/dialog export toolkit, per-session runtime isolation for the Agent Manager, and cross-session checkpoint coordination. The extension version is bumped to **5.17.9**.

No breaking changes. All features ship with regression test coverage.

## Changes

### 1. New models and provider support

- **Z.AI GLM-5.3** (`9fdf336382`) — Added to both international and mainland model lists with a 1M context window, 128K max output, and required reasoning. The `reasoning_effort` parameter is now sent for models that require it via a new `requiredReasoningEffort` capability, which keeps thinking always enabled. A new `max` effort level is available in schemas, settings, and localized settings UI (en, ru).
- **GPT-6 Astra for OpenAI Codex** (`f968b1e480`) — Registered the GPT-6 Astra model for the Codex provider.
- **GPT-5.6 sol / terra / luna** (`52b8e425c4`) — Registered three GPT-5.6 variants for both native OpenAI and OpenAI Codex providers, including capabilities, pricing, long-context tier details, and selection/metadata tests.
- **DeepSeek V4 Pro/Flash API** (`73f42d90ba`) — Added V4 Pro and V4 Flash model support with thinking-mode control and `reasoning_effort` (minor changeset).
- **DeepSeek reasoning_content fix** (`d55af327eb`) — Assistant messages with tool calls now pass `reasoning_content` in thinking mode, fixing a 400 error that occurred when switching providers (patch changeset).

### 2. Session and dialog exports

A full export toolkit for current-project session backups:

- **Export dialog history** (`43fef33691`, `fa579e6e1b`) — New `kilo-code.exportDialogHistory` command and `/export_all_dialogs` slash command export task dialogs as sanitized, text-only Markdown files with a manifest. Internal API, checkpoint, and reasoning noise is excluded.
- **Export all sessions** (`0d633de203`, `ac68043907`) — New `kilo-code.exportAllSessions` command exports raw task session files plus the `task_history.json` index into a user-selected destination folder. The `/export_all_sessions` slash command opens the VS Code command directly.
- **Export correctness and safety hardening**:
    - Exports are scoped to the current project's workspace, with cross-workspace sessions filtered out and missing task directories recorded as failures (`3d378bdd29`).
    - Exports targeting the tasks storage directory itself are rejected (`b3e0b64a4a`).
    - API credentials embedded in session runtime mode bindings are sanitized before export (`1d52b13bee`).
    - Unchanged exports are skipped; existing exports are refreshed only when content changes, tracked via content hashes and message counts (`d559b9fd00`, `a38707cf92`).
    - Export filenames are prefixed with message timestamps (with history-timestamp fallback), and legacy export paths are detected so unchanged skips still work (`c8363fd53a`).

### 3. Per-session model isolation (Agent Manager)

- **Session model preservation on resume** (`23dda7f3d4`) — Cloud and local session model selections are now authoritative when resuming Agent Manager sessions instead of falling back to sidebar configuration. Model overrides are applied through provider-specific settings, the resolved handler model is validated before spawning, and task-local model settings survive Kilo Code re-authentication.
- **Runtime mode/profile state isolation** (`2d29167617`, `70a6f1f1ee`) — A versioned session runtime snapshot persisted on task history restores mode, profile, model, and tool protocol per session. Provider profiles resolve for the active window/task without mutating global defaults, and effective runtime configuration is used across tools, CLI helpers, completions, and history rehydration.

### 4. Cross-session checkpoint coordination

- (`fbe18ca5a9`) Checkpoint restores are serialized per workspace, and other open sessions are notified when files become stale after a restore. An explicit acknowledgement is required before continuing, and task IDs are validated on restore requests to prevent applying snapshots to the wrong task. Session-specific condensing settings and effective API config resolution are preserved for commit messages, terminal commands, and contribution tracking, with rate limits scoped by provider/profile/model.

### 5. Project-local dialog session storage

- (`af167364ae`) New `project.dialog_sessions_path` setting in `.kilo/config.json` (and legacy `.kilocode/config.json`) stores task histories inside the workspace. Task messages, API histories, metadata, diagnostics, exports, auto-purge, and CLI session paths all route through the resolved storage location.

### 6. Configuration fix

- (`c581025012`) The default file read limit is now applied from configuration.

## Changesets

| Changeset                                                 | Type  |
| --------------------------------------------------------- | ----- |
| DeepSeek V4 Pro/Flash support                             | minor |
| `/export_all_sessions` and `/export_all_dialogs` commands | minor |
| Export dialog history command                             | minor |
| DeepSeek reasoning_content fix                            | patch |
| Per-session model isolation                               | patch |
| Project-configurable dialog session storage               | patch |

## Testing

- New and updated spec suites cover every feature area, including:
    - Provider handlers: `zai.spec.ts`, `deepseek.spec.ts`, `openai-codex.spec.ts`, `openai-native.spec.ts`, `r1-format.spec.ts`
    - Exports: `exportAllDialogs.spec.ts` (612 lines), `exportAllSessions.spec.ts` (611 lines), `exportDialogHistory.spec.ts`
    - Runtime isolation: `Task.sticky-profile-race.spec.ts`, `AgentManagerProvider.spec.ts`, `RuntimeProcessHandler.spec.ts`, `RemoteSessionService.spec.ts`
    - Checkpoints: `checkpoint.test.ts`, `WorkspaceCheckpointCoordinator.spec.ts`
    - Storage/config: `project-config.spec.ts`, `cli-config.spec.ts`, `provider-settings-model-override.spec.ts`
- Full commit list: `git log --oneline ae046acafd..9fdf336382` (24 commits)

## Merge details

- **Base**: `main` at `ae046acafd`
- **Head**: `astra_glm53` at `9fdf336382`
- **Strategy**: Fast-forward, no conflicts
- **Impact**: 132 files changed, 9,652 insertions, 623 deletions
- **Version**: 5.17.9
