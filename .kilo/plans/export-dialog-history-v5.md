# Plan: Export Kilo Code v5 Dialog History

## Goal

Add a project-local export flow that scans the Kilo Code history for the currently open project/workspace and writes one markdown file per dialog to:

```text
.kilo/history/dialogs/<taskId>.md
```

The export must be idempotent: if `.kilo/history/dialogs/<taskId>.md` already exists, leave it unchanged and skip that dialog. The output is intended for indexing and text search over prior dialogs.

## Kilo Code v5 Findings

- Current repository version is Kilo Code `5.16.1` from `src/package.json`.
- The authoritative in-extension task list is available through `ClineProvider.getTaskHistory()`.
- The current project path is available through `ClineProvider.cwd`.
- Kilo v5 already filters current-project history with `item.workspace === cwd` in `src/shared/kilocode/getTaskHistory.ts`.
- Dialog files for each task are resolved through `ClineProvider.getTaskWithId(taskId)`.
- Per-task storage files are named with `GlobalFileNames`:
- `api_conversation_history.json`
- `ui_messages.json`
- The storage root comes from `provider.contextProxy.globalStorageUri.fsPath`, but implementation should prefer `provider.getTaskWithId()` so custom storage path behavior remains centralized.

## Preferred Architecture

Implement this as an in-extension Kilo Code v5 export command, not as a standalone Node script.

Reason: `taskHistory` lives in VS Code/Kilo global state, not in a simple project file. A standalone script would need a brittle external dump of `taskHistory` or would have to reverse-engineer VS Code memento storage. The in-extension command can use the existing provider APIs directly.

## User-Facing Behavior

Add a VS Code command, for example:

```text
kilo-code.exportDialogHistory
```

Behavior:

- Use the visible `ClineProvider` instance.
- Read `provider.cwd` as the target workspace path.
- Read `provider.getTaskHistory()`.
- Filter to tasks where `task.id`, `task.task`, and `task.ts` exist and `task.workspace === provider.cwd`.
- Sort newest first for deterministic output.
- Create `.kilo/history/dialogs/` under `provider.cwd`.
- For each task, write `.kilo/history/dialogs/<taskId>.md` only if it does not already exist.
- Log or show a completion summary with exported count, skipped count, and failed count.

## Markdown Output Format

Each exported file should contain YAML frontmatter plus readable transcript content.

Proposed structure:

```md
---
id: "<taskId>"
title: "<task title>"
workspace: "<absolute workspace path>"
createdAt: "<ISO timestamp>"
mode: "<mode if present>"
model: "<model/profile info if present>"
tokensIn: <number if present>
tokensOut: <number if present>
totalCost: <number if present>
source: "kilo-code-v5"
---

# <task title>

Task ID: `<taskId>`

## Messages

### user

...

### assistant

...
```

Rendering rules:

- Prefer `ui_messages.json` for readable UI transcript because it reflects what the user saw.
- Fall back to `api_conversation_history.json` if UI messages are unavailable or empty.
- Extract text conservatively from common shapes: `text`, string `content`, array `content[].text`, and simple string entries.
- Do not embed images/base64 payloads; emit a placeholder like `[image omitted]` if needed.
- Preserve tool/result text only when it is already textual and reasonably useful for search.

## Files To Add Or Modify

Implementation should be small and Kilo-specific.

1. Add an exporter module, for example:

```text
src/kilocode/history/exportDialogHistory.ts
```

This path contains `kilocode`, so `kilocode_change` markers are not required by project rules.

Responsibilities:

- `exportDialogHistory(provider: ClineProvider): Promise<ExportDialogHistoryResult>`
- `renderDialogMarkdown(...)`
- safe filename handling for `<taskId>.md`
- idempotent skip-if-exists behavior
- per-task error collection without aborting the entire export

2. Register a command in:

```text
src/activate/registerCommands.ts
```

This file is core extension code, so wrap changes with `// kilocode_change start` and `// kilocode_change end` if modifying shared sections.

3. Add the command id type/metadata where command ids are defined in `@roo-code/types` if required by TypeScript.

Likely locations to inspect during implementation:

- `packages/types/src/...` command id definitions
- `src/shared/package` / command mapping utilities

4. Optional but useful: add a built-in slash command or project command only if the product expects invoking this from chat. Otherwise, the VS Code command is enough.

## Core Algorithm

Pseudo-code:

```ts
const cwd = provider.cwd
const outputDir = path.join(cwd, ".kilo", "history", "dialogs")
await fs.mkdir(outputDir, { recursive: true })

const tasks = provider
  .getTaskHistory()
  .filter((item) => item.id && item.ts && item.task && item.workspace === cwd)
  .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))

for (const task of tasks) {
  const outputPath = path.join(outputDir, `${safeTaskId(task.id)}.md`)

  if (await fileExists(outputPath)) {
    skipped++
    continue
  }

  try {
    const taskData = await provider.getTaskWithId(task.id, false)
    const uiMessages = await readJsonIfExists(taskData.uiMessagesFilePath, [])
    const apiHistory = taskData.apiConversationHistory ?? await readJsonIfExists(taskData.apiConversationHistoryFilePath, [])
    const markdown = renderDialogMarkdown({ historyItem: taskData.historyItem, uiMessages, apiHistory })
    await fs.writeFile(outputPath, markdown, "utf8")
    exported++
  } catch (error) {
    failed.push({ taskId: task.id, error })
  }
}
```

## Edge Cases

- Existing markdown file: skip and do not overwrite.
- Missing task files: record failure and continue.
- Task exists but `workspace` is missing: exclude by default to avoid exporting dialogs from other projects.
- Multi-root workspace: v5 currently uses `provider.cwd`; export should match that exact behavior.
- Custom storage path: avoid manually constructing storage paths when possible; use `provider.getTaskWithId()`.
- Unsafe task IDs: sanitize filename, but preserve original `id` in frontmatter.
- Empty dialogs: export metadata and a short note only if task files exist but contain no messages.

## Tests

Add focused unit tests near the exporter module or existing webview/provider tests.

Test cases:

- Exports only tasks whose `workspace` equals `provider.cwd`.
- Creates `.kilo/history/dialogs` under the workspace.
- Writes one markdown file per missing dialog.
- Skips existing files without overwriting content.
- Continues when one task fails and reports the failure.
- Renders UI messages when available.
- Falls back to API conversation history when UI messages are empty.
- Sanitizes unsafe task IDs in filenames.

Run tests from the workspace that owns the relevant `package.json`/vitest config, following repository instructions. For `src` tests, run from `src` with a relative path such as:

```bash
pnpm test path/to/exportDialogHistory.spec.ts
```

## Validation

After implementation:

- Run the new targeted tests.
- Run TypeScript checking for the affected workspace if practical.
- Manually trigger the command in a workspace with known Kilo history.
- Confirm generated files appear under `.kilo/history/dialogs/`.
- Confirm running the command twice reports files as skipped and does not rewrite them.
- Confirm files are searchable by normal text search/indexing.

## Alternative Standalone Script For v5

Only use this if an in-extension command is not acceptable.

Standalone script requirements:

- Accept `--storage=<globalStorageUri path>`.
- Accept `--history-json=<taskHistory export path>`.
- Accept `--workspace=<project path>` or default to `process.cwd()`.
- Filter `taskHistory` by `workspace === workspacePath`.
- Read `tasks/<taskId>/ui_messages.json` and `tasks/<taskId>/api_conversation_history.json`.
- Write `.kilo/history/dialogs/<taskId>.md` if missing.

Downside: it still needs a reliable way to obtain `taskHistory`; that is why the in-extension command is preferred for Kilo Code v5.

## Implementation Order

1. Add exporter module with pure rendering helpers and filesystem export function.
2. Add tests for filtering, idempotency, rendering, and failure handling.
3. Register `kilo-code.exportDialogHistory` command using the visible provider.
4. Add command id/type wiring if compilation requires it.
5. Run targeted tests and typecheck.
6. Verify manually on a project with existing Kilo dialogs.
