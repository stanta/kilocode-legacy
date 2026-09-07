# Review: `/export_all_dialogs` current-project text dialog export

## Summary

The implementation adds a Kilo Code command and slash-command flow for exporting current-project text dialog histories into user-selected output folders. Overall, the feature is substantially complete: it is wired through VS Code commands, slash command parsing, webview slash command discovery, and includes focused tests for exporter behavior and command invocation.

**Verdict:** Approve with minor follow-up recommendations.

## Requirement coverage

| Requirement                            | Assessment    | Evidence                                                                                                                                                                                       |
| -------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slash command `/export_all_dialogs`    | Implemented   | [`parseKiloSlashCommands()`](../src/core/slash-commands/kilo.ts#L69) returns an action signal for `export_all_dialogs`.                                                                        |
| Real command execution from user input | Implemented   | [`processKiloUserContentMentions()`](../src/core/mentions/processKiloUserContentMentions.ts#L88) and [`Task.loadContext()`](../src/core/task/Task.ts#L4361) execute `exportAllDialogs`.        |
| Folder selected by user                | Implemented   | [`registerCommands.ts`](../src/activate/registerCommands.ts#L339) uses `showOpenDialog()` with folder-only selection.                                                                          |
| Current-project scope                  | Implemented   | [`exportAllDialogs()`](../src/kilocode/history/exportAllDialogs.ts#L122) filters history using normalized workspace path comparison.                                                           |
| Text-only dialog extraction            | Implemented   | [`extractTextDialogMessages()`](../src/kilocode/history/exportAllDialogs.ts#L227) includes only selected `say`/`ask` kinds, including terminal approval asks.                                  |
| Internal/noise exclusion               | Implemented   | [`includedSayKinds`](../src/kilocode/history/exportAllDialogs.ts#L87) excludes `api_req_started`, `checkpoint_saved`, `reasoning`, and other non-dialog event kinds.                           |
| Incremental export                     | Implemented   | [`readExistingExportMetadata()`](../src/kilocode/history/exportAllDialogs.ts#L400) compares existing `messageCount` and `contentHash` with extracted dialog metadata.                          |
| Tests                                  | Good coverage | [`exportAllDialogs.spec.ts`](../src/kilocode/history/__tests__/exportAllDialogs.spec.ts#L137) covers scoping, text-only extraction, incrementality, failures, manifest, and sanitized history. |

## Positive observations

1. **The exporter is separated from command wiring.** The core logic lives in [`exportAllDialogs()`](../src/kilocode/history/exportAllDialogs.ts#L94), while VS Code UI behavior remains in [`registerCommands.ts`](../src/activate/registerCommands.ts#L333). This keeps the exporter testable and avoids coupling it directly to VS Code APIs.

2. **The implementation correctly avoids exporting unrelated workspaces.** Current-project filtering is explicit in [`exportAllDialogs()`](../src/kilocode/history/exportAllDialogs.ts#L117), and the test in [`exportAllDialogs.spec.ts`](../src/kilocode/history/__tests__/exportAllDialogs.spec.ts#L137) verifies that other workspace items and orphan task directories are ignored.

3. **The exporter has a useful safety guard for destination paths.** [`assertExportDestinationIsSafe()`](../src/kilocode/history/exportAllDialogs.ts#L417) prevents writing the generated `dialogs` folder inside Kilo Code task storage, reducing the risk of recursive self-export or storage pollution.

4. **Sensitive runtime config is not exported in task history.** The sanitized history projection in [`sanitizeTaskHistoryItem()`](../src/kilocode/history/exportAllDialogs.ts#L221) avoids writing `sessionRuntimeConfig` and nested provider credentials to [`dialogs_task_history.json`](../src/kilocode/history/exportAllDialogs.ts#L108). The test in [`exportAllDialogs.spec.ts`](../src/kilocode/history/__tests__/exportAllDialogs.spec.ts#L167) confirms this behavior.

5. **The command is discoverable.** [`webview-ui/src/utils/slash-commands.ts`](../webview-ui/src/utils/slash-commands.ts#L39) registers `export_all_dialogs` for the slash-command menu, and [`src/package.json`](../src/package.json#L164) exposes the VS Code command.

## Findings

### Critical issues

None found.

### Major issues

None blocking. The implementation satisfies the stated functional requirement.

### Minor issues and recommendations

#### 1. Workspace matching should be normalized before comparison — resolved

Current-project filtering now uses normalized workspace path comparison in [`isSameWorkspace()`](../src/kilocode/history/exportAllDialogs.ts#L432), including trailing slash normalization, filesystem `realpath` canonicalization when available, graceful fallback to resolved normalized paths, and Windows path casing normalization.

#### 2. Incremental comparison by `messageCount` can skip same-length edits — resolved

The exporter now writes a stable Markdown frontmatter `contentHash` from extracted text dialog messages and refreshes existing Markdown when either `messageCount` or `contentHash` differs. Older exports without `contentHash` refresh safely with a warning.

#### 3. `ask:command` and `ask:command_output` are not included — resolved

Terminal approval dialog kinds `command` and `command_output` are now included in [`includedAskKinds`](../src/kilocode/history/exportAllDialogs.ts#L88), preserving their raw text in Markdown exports.

#### 4. `Task.loadContext()` command-wiring branch has formatting drift

The added slash command handling in [`Task.loadContext()`](../src/core/task/Task.ts#L4344) is functionally valid and type-checks, but indentation is visibly inconsistent around [`parseKiloSlashCommands()`](../src/core/task/Task.ts#L4344) and the command execution block at [`Task.loadContext()`](../src/core/task/Task.ts#L4356).

**Recommendation:** run the project formatter on [`src/core/task/Task.ts`](../src/core/task/Task.ts) or manually align the block. This is not a runtime issue, but it increases review friction in a high-churn core file.

#### 5. Add direct tests for the `Task.loadContext()` path

The command action is covered through [`processKiloUserContentMentions()`](../src/core/mentions/processKiloUserContentMentions.ts#L88), but [`Task.loadContext()`](../src/core/task/Task.ts#L4361) is a separate duplicated path and currently has no direct regression test for `/export_all_dialogs` command invocation.

**Recommendation:** add a focused test around [`Task.loadContext()`](../src/core/task/Task.ts#L4307) or refactor shared slash-action execution into a single helper used by both paths.

## Verification performed

The following checks were run successfully:

```bash
cd src && pnpm test kilocode/history/__tests__/exportAllDialogs.spec.ts activate/__tests__/registerCommands.exportAllDialogs.spec.ts core/slash-commands/__tests__/kilo.spec.ts core/mentions/__tests__/processKiloUserContentMentions.spec.ts
```

Result: 4 test files passed, 54 tests passed.

```bash
cd webview-ui && pnpm test src/utils/__tests__/slash-commands.spec.ts
```

Result: 1 test file passed, 23 tests passed.

```bash
pnpm check-types
```

Result: TypeScript checks passed.

```bash
git diff --check
```

Result: whitespace diff check passed.

A non-blocking environment warning appeared during package scripts: the repo requests Node `20.20.0`, while the current runtime is Node `22.20.0`.

## Final assessment

The `/export_all_dialogs` feature is complete enough for merge from a functional standpoint. It correctly exports current-project text dialog histories, avoids unrelated workspaces, supports incremental skip/refresh behavior, avoids raw credential-bearing runtime config in the exported task history, and has good test coverage for the exporter and command plumbing.

Recommended follow-ups are low-risk polish items: normalize workspace path comparisons, consider adding a content hash for stronger incrementality, decide whether command approval text belongs in “text dialogs,” format the added [`Task.loadContext()`](../src/core/task/Task.ts#L4344) block, and add a direct regression test for that duplicate execution path.
