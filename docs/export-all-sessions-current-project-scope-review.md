# Current-project export scope review

## Summary

This review checks whether the export-all-sessions feature now exports only sessions for the current project and does not affect other workspace folders. Overall assessment: **mostly well implemented, with minor/medium hardening recommendations**.

The core scoping requirement is implemented in [`exportAllSessions()`](../src/kilocode/history/exportAllSessions.ts:70): it filters history items by [`HistoryItem.workspace`](../packages/types/src/history.ts) matching [`provider.cwd`](../src/kilocode/history/exportAllSessions.ts:15), writes only those filtered history items to [`task_history.json`](../src/kilocode/history/exportAllSessions.ts:100), and only copies task storage directories whose names are in the filtered current-project task ID set.

## Requirement compliance

| Requirement                                             | Status | Evidence                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Export only sessions for the current project            |   Pass | [`currentProjectHistory`](../src/kilocode/history/exportAllSessions.ts:93) filters by `item.workspace === provider.cwd`.                                                                                                                                     |
| Do not export sessions from other workspaces            |   Pass | [`currentProjectTaskIds`](../src/kilocode/history/exportAllSessions.ts:96) is built only from filtered current-project history, and the copy loop iterates only those IDs at [`exportAllSessions.ts:114`](../src/kilocode/history/exportAllSessions.ts:114). |
| Do not touch other workspace folders                    |   Pass | The code only reads from the global Kilo task storage and writes to the user-selected output folder; it does not delete or mutate source task directories. Copying is constrained to filtered task IDs.                                                      |
| Exported history index scoped to current project        |   Pass | [`task_history.json`](../src/kilocode/history/exportAllSessions.ts:100) serializes [`currentProjectHistory`](../src/kilocode/history/exportAllSessions.ts:93), not full global history.                                                                      |
| Manifest clearly states scope                           |   Pass | [`export_manifest.json`](../src/kilocode/history/exportAllSessions.ts:135) includes [`scope: "currentProject"`](../src/kilocode/history/exportAllSessions.ts:140) and [`workspace: provider.cwd`](../src/kilocode/history/exportAllSessions.ts:141).         |
| Tests protect against other-workspace export regression |   Pass | [`exportAllSessions.spec.ts`](../src/kilocode/history/__tests__/exportAllSessions.spec.ts:153) asserts only current-project directories and history are exported, while other-workspace and orphan directories are skipped.                                  |

## Positive findings

- The filter is applied before both output index creation and raw directory copying, which is the right architectural point. Specifically, [`currentProjectHistory`](../src/kilocode/history/exportAllSessions.ts:93), [`currentProjectTaskIds`](../src/kilocode/history/exportAllSessions.ts:96), and the copy loop at [`exportAllSessions.ts:114`](../src/kilocode/history/exportAllSessions.ts:114) all align around the same scoped task ID set.
- The exporter does not mutate source storage. It only reads entries via [`readTaskDirectories()`](../src/kilocode/history/exportAllSessions.ts:158) and copies files recursively via [`copyDirectoryRecursive()`](../src/kilocode/history/exportAllSessions.ts:174).
- Orphan storage directories are intentionally skipped because the copy loop does not iterate the full [`taskDirectories`](../src/kilocode/history/exportAllSessions.ts:102) set; it iterates [`currentProjectTaskIds`](../src/kilocode/history/exportAllSessions.ts:96).
- The tests explicitly cover the main cross-workspace safety case: [`task-2`](../src/kilocode/history/__tests__/exportAllSessions.spec.ts:156) belongs to [`/other`](../src/kilocode/history/__tests__/exportAllSessions.spec.ts:156), has raw files at [`/custom-storage/tasks/task-2`](../src/kilocode/history/__tests__/exportAllSessions.spec.ts:162), and is asserted absent from the export at [`exportAllSessions.spec.ts:193`](../src/kilocode/history/__tests__/exportAllSessions.spec.ts:193).

## Findings and recommendations

### Medium — Workspace matching uses exact string equality

Evidence: [`exportAllSessions()`](../src/kilocode/history/exportAllSessions.ts:93) filters current project sessions with:

```ts
return Boolean(item.id && typeof item.workspace === "string" && item.workspace === provider.cwd)
```

Why this matters:

- Exact string equality is consistent with existing task-history filtering patterns, but it can be brittle when paths differ only by trailing slash, symlink resolution, casing on case-insensitive filesystems, or path normalization.
- This is more likely to cause false negatives, where valid current-project sessions are not exported. In rarer cases, non-canonical path handling can confuse users in multi-root setups.

Recommendation:

- Consider comparing normalized workspace paths, for example with [`path.resolve()`](../src/kilocode/history/exportAllSessions.ts:3), while being cautious about platform casing semantics.
- A minimal helper would make intent explicit:

```ts
function isCurrentWorkspace(item: HistoryItem, cwd: string): item is HistoryItem & { id: string; workspace: string } {
	return Boolean(item.id && typeof item.workspace === "string" && path.resolve(item.workspace) === path.resolve(cwd))
}
```

### Minor — User-facing command text still says “all Kilo Code sessions”

Evidence:

- The folder picker title is [`Select folder to export all Kilo Code sessions`](../src/activate/registerCommands.ts:306).
- The command contribution title remains [`Export All Sessions`](../src/package.json:160).

Why this matters:

- The behavior is now current-project-only, so UI text should not imply global/all-workspaces export.

Recommendation:

- Rename user-facing text to something like `Export Current Project Sessions` and `Select folder to export current project Kilo Code sessions`.
- The changeset already uses current-project wording at [`.changeset/export-all-sessions.md`](../.changeset/export-all-sessions.md:5), which is good.

### Minor — Result summary does not explicitly mention current-project scope

Evidence: [`registerCommands.ts`](../src/activate/registerCommands.ts:316) reports `Exported X of Y Kilo session task directories...`.

Recommendation:

- Consider changing the summary to `Exported X of Y current project Kilo session task directories...` so users understand other workspace sessions were intentionally excluded.

### Minor — Missing task directories are counted as failures

Evidence: current-project history entries with no storage directory produce failures at [`exportAllSessions.ts:115`](../src/kilocode/history/exportAllSessions.ts:115).

This is acceptable because it makes data inconsistency visible. If users frequently have history items without raw task folders after cleanup/migration, it may be better to distinguish `missing` from `failed` in the manifest. That is not required for the current scope requirement.

## Test quality assessment

The updated tests are well targeted for the new scope requirement:

- [`copies only current-project raw task directories and writes current-project task history`](../src/kilocode/history/__tests__/exportAllSessions.spec.ts:153) verifies the main behavior.
- [`skips orphan storage task directories not represented in current-project history`](../src/kilocode/history/__tests__/exportAllSessions.spec.ts:206) protects against accidentally exporting all raw task dirs.
- [`records missing raw task directories for current-project history items`](../src/kilocode/history/__tests__/exportAllSessions.spec.ts:239) defines behavior when history and disk storage diverge.
- [`records all current-project history items as missing when the storage tasks directory does not exist`](../src/kilocode/history/__tests__/exportAllSessions.spec.ts:261) covers missing storage root behavior.

Recommended additional test:

- Add a path-normalization test if the code adopts normalized workspace comparison, such as `workspace: "/workspace/"` and `cwd: "/workspace"`.

## Verdict

**Approve with minor follow-up recommendations.** The implementation now correctly scopes export to the current project and does not copy or mutate sessions belonging to other workspace folders. The main remaining improvements are user-facing wording and more robust workspace path comparison.
