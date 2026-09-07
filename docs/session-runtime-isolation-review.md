# Review: Session Runtime Isolation and Checkpoint Restore Safety

## Scope

This review evaluates whether the implemented session isolation prevents model/context crossing between Kilo Code sessions and whether checkpoint checkout/rollback in one session can clear or corrupt other sessions.

Reviewed areas:

- Session runtime model/profile/mode ownership in [`Task`](../src/core/task/Task.ts:617), [`ClineProvider`](../src/core/webview/ClineProvider.ts:356), and [`HistoryItem`](../packages/types/src/history.ts:60)
- Runtime provider switching paths in [`ClineProvider.activateProviderProfile()`](../src/core/webview/ClineProvider.ts:2020), [`ClineProvider.handleModeSwitch()`](../src/core/webview/ClineProvider.ts:1751), and [`ProviderSettingsManager.resolveProfile()`](../src/core/config/ProviderSettingsManager.ts:411)
- Checkpoint save/restore paths in [`checkpointRestore()`](../src/core/checkpoints/index.ts:255), [`handleCheckpointRestoreOperation()`](../src/core/webview/checkpointRestoreHandler.ts:26), [`RepoPerTaskCheckpointService.create()`](../src/services/checkpoints/RepoPerTaskCheckpointService.ts:7), and [`ShadowCheckpointService.restoreCheckpoint()`](../src/services/checkpoints/ShadowCheckpointService.ts:359)
- Targeted test suites for session/profile isolation and checkpoint restore behavior

## Executive summary

The role/model isolation implementation is mostly sound for the main LLM runtime path: active tasks now use a session-owned snapshot instead of live global provider state, and global provider profile changes no longer broadcast into all active tasks. However, checkpoint restore remains workspace-wide by design: a restore in one task does not delete other sessions' message histories, but it does mutate the shared workspace files seen by every VS Code window opened on the same workspace. This should be treated as a major isolation boundary that is not yet fully addressed.

Verdict: **Request changes before claiming “maximum isolation”**. The model/runtime isolation is strong enough for merge with follow-up hardening, but checkpoint restore needs explicit cross-session coordination or product-level warning because it affects the shared workspace.

## What is implemented well

### 1. Task owns a session-local runtime snapshot

[`Task`](../src/core/task/Task.ts:617) now creates or restores [`SessionRuntimeConfig`](../packages/types/src/history.ts:28) during construction. For history restore, it prefers the persisted versioned runtime snapshot; for new tasks, it seeds from the provider/window runtime once.

Positive impact:

- A task has its own current mode, profile name, full provider settings, model id, reasoning settings, and tool protocol.
- Later changes to global defaults no longer live-update existing tasks.
- History items can persist full runtime state via [`taskMetadata()`](../src/core/task-persistence/taskMetadata.ts:43).

### 2. LLM requests use session-local provider settings

The actual request path in [`Task.attemptApiRequest()`](../src/core/task/Task.ts:4599) resolves [`apiConfiguration`](../src/core/task/Task.ts:4604) from [`Task.getSessionApiConfiguration()`](../src/core/task/Task.ts:854), not from global state. This is the most important correctness point for model isolation.

Positive impact:

- Changing model/profile in session A should not affect the next LLM request in session B.
- Reasoning effort, model id, provider, and tool protocol follow the task snapshot.

### 3. Global profile activation no longer drives session runtime by default

[`ClineProvider.activateProviderProfile()`](../src/core/webview/ClineProvider.ts:2020) uses non-mutating profile resolution by default and only writes global defaults when explicitly requested through `persistGlobalDefault` in [`ClineProvider.activateProviderProfile()`](../src/core/webview/ClineProvider.ts:2025).

Positive impact:

- Normal chat-side profile switches are session-local.
- Saved profiles remain shared templates, but active session runtime is detached.

### 4. The old cross-session provider event leak appears removed

Search found no remaining task listener for `ProviderProfileChanged`; only event emission remains in [`ClineProvider.applyRuntimeProviderProfile()`](../src/core/webview/ClineProvider.ts:443). This removes the prior design where all active tasks reloaded global provider settings after any profile change.

Positive impact:

- The strongest historical source of model synchronization across tasks is gone.

### 5. History restore avoids global mode/profile mutation

[`ClineProvider.createTaskWithHistoryItem()`](../src/core/webview/ClineProvider.ts:1249) restores mode/profile into the provider/window runtime and task snapshot rather than calling global activation. The tests also assert that global activation is not called for provider restore in [`ClineProvider.sticky-profile.spec.ts`](../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:455).

Positive impact:

- Reopening one historical task should not rewrite global `mode` or `currentApiConfigName` for other sessions.

## Critical / major findings

### Major 1 — Checkpoint restore is task-scoped in storage, but workspace-wide in effect

Checkpoint repositories are per-task because [`RepoPerTaskCheckpointService.create()`](../src/services/checkpoints/RepoPerTaskCheckpointService.ts:7) stores data under `tasks/<taskId>/checkpoints`. That protects checkpoint metadata from cross-task deletion.

However, restore itself runs a hard reset against the checkpoint repo whose [`core.worktree`](../src/services/checkpoints/ShadowCheckpointService.ts:189) points to the shared workspace. [`ShadowCheckpointService.restoreCheckpoint()`](../src/services/checkpoints/ShadowCheckpointService.ts:359) calls a clean/reset sequence in [`ShadowCheckpointService.restoreCheckpoint()`](../src/services/checkpoints/ShadowCheckpointService.ts:368), which changes files in [`workspaceDir`](../src/services/checkpoints/ShadowCheckpointService.ts:125).

Impact:

- If two VS Code windows/sessions share the same workspace folder, restoring a checkpoint in session A changes the filesystem under session B.
- Session B's chat history is not cleared, but its assumptions about current files can become stale or wrong.
- If session B is mid-tool execution, a restore from session A can race with reads/writes/apply-diff and produce inconsistent results.

Recommendation:

- Add a workspace-level checkpoint restore coordinator keyed by canonical workspace path.
- Block or queue restore operations while another task in the same workspace is active or writing.
- Broadcast a `workspaceCheckpointRestored` event to all providers/windows for the same workspace.
- Force affected tasks to refresh environment context or require user confirmation before continuing.
- Update UI copy to distinguish “session rollback” from “workspace rollback”.

### Major 2 — `preview` checkpoint restore still mutates workspace files

[`checkpointRestore()`](../src/core/checkpoints/index.ts:255) always calls [`ShadowCheckpointService.restoreCheckpoint()`](../src/services/checkpoints/ShadowCheckpointService.ts:359) before checking `mode`. For `mode === "preview"`, it skips message rewind but still restores workspace files in [`checkpointRestore()`](../src/core/checkpoints/index.ts:273).

Impact:

- A “preview” restore is not read-only from a workspace isolation perspective.
- In multi-session usage, previewing a checkpoint in session A can unexpectedly alter files being used by session B.

Recommendation:

- Rename this behavior if intentional, or implement true preview through diff-only operations using [`checkpointDiff()`](../src/core/checkpoints/index.ts:336).
- Add tests proving preview does not mutate workspace if that is the expected UX.

### Major 3 — Checkpoint restore cancellation can rehydrate the wrong current task if user focus changes concurrently

The webview handler for direct checkpoint restore calls [`ClineProvider.cancelTask()`](../src/core/webview/ClineProvider.ts:3650), waits for current task initialization, then calls `provider.getCurrentTask()?.checkpointRestore(...)` in [`webviewMessageHandler.ts`](../src/core/webview/webviewMessageHandler.ts:1494). This relies on “current task” still being the intended task after cancel/rehydration.

Impact:

- In a multi-window or fast UI interaction scenario, a task focus change can make restore target ambiguous.
- The code is probably safe under the current single-open invariant inside one provider, but not robust enough for “maximum isolation” semantics.

Recommendation:

- Include `taskId` in checkpoint restore payload and validate it before and after cancellation.
- Call restore on a task resolved by id, not by whatever is current after rehydration.
- If the active task changes during restore preparation, abort the restore with a clear error.

### Major 4 — Checkpoint rollback only rewinds the active task history, but shared workspace rollback can invalidate other contexts

[`MessageManager.rewindToTimestamp()`](../src/core/message-manager/index.ts:45) operates on one task instance, and [`saveTaskMessages()`](../src/core/webview/checkpointRestoreHandler.ts:69) writes messages using the current task id. This means rollback does not directly clear other sessions' chat messages.

The gap is contextual rather than storage-level: other sessions' chat histories survive, but they may now describe files that no longer exist or have different contents due to the workspace reset in [`ShadowCheckpointService.restoreCheckpoint()`](../src/services/checkpoints/ShadowCheckpointService.ts:368).

Recommendation:

- After workspace restore, mark other active sessions in the same workspace as “workspace changed externally”.
- Require an explicit “refresh context and continue” or “pause task” decision.
- Consider persisting a workspace generation id in task metadata and compare it before tool execution.

## Minor findings and hardening opportunities

### Minor 1 — Some utility model calls still use global defaults by design

[`CommitMessageGenerator`](../src/services/commit-message/CommitMessageGenerator.ts:116) and [`terminalCommandGenerator`](../src/utils/terminalCommandGenerator.ts:159) still read [`ContextProxy.getProviderSettings()`](../src/core/config/ContextProxy.ts:320). This is acceptable if these tools are intentionally global utilities, but they are not session-isolated.

Recommendation:

- Document these as global utility completions, or add optional provider/session config injection if they can be invoked from a task context.

### Minor 2 — Contribution tracking still often reads state-level apiConfiguration

Tools such as [`ApplyDiffTool`](../src/core/tools/ApplyDiffTool.ts:179), [`WriteToFileTool`](../src/core/tools/WriteToFileTool.ts:154), and [`MultiApplyDiffTool`](../src/core/tools/MultiApplyDiffTool.ts:649) use `state.apiConfiguration` for contribution metadata. Because [`ClineProvider.getState()`](../src/core/webview/ClineProvider.ts:2925) now returns session-effective provider settings, this is mostly fine for current-task usage.

Recommendation:

- For consistency, use [`ClineProvider.getEffectiveApiConfiguration()`](../src/core/webview/ClineProvider.ts:448) in all task-aware tracking paths.

### Minor 3 — Runtime snapshot fallback helpers may hide missing mock/runtime methods

[`ClineProvider.getTaskSessionRuntimeConfig()`](../src/core/webview/ClineProvider.ts:513) and [`ClineProvider.setTaskSessionModeBinding()`](../src/core/webview/ClineProvider.ts:588) include compatibility fallbacks for older test mocks. This is pragmatic, but it can hide integration bugs if a real task-like object lacks the new runtime API.

Recommendation:

- Keep fallbacks only in test-specific helpers or add runtime assertions for production paths.

## Test coverage assessment

Targeted test command passed:

```text
cd src && pnpm test core/task/__tests__/Task.sticky-profile-race.spec.ts core/webview/__tests__/ClineProvider.sticky-profile.spec.ts core/webview/__tests__/ClineProvider.sticky-mode.spec.ts core/checkpoints/__tests__/checkpoint.test.ts core/webview/__tests__/checkpointRestoreHandler.spec.ts core/webview/__tests__/webviewMessageHandler.checkpoint.spec.ts
```

Result:

```text
6 test files passed
71 tests passed
```

Observed warning:

```text
Unsupported engine: wanted node 20.20.0, current node 22.20.0
```

Coverage is good for task-local model/profile/mode behavior, but incomplete for true multi-provider/multi-window isolation and checkpoint cross-session safety.

Recommended additional tests:

1. Two [`ClineProvider`](../src/core/webview/ClineProvider.ts:125) instances with the same shared [`ContextProxy`](../src/core/config/ContextProxy.ts:69) and different runtime profiles: switching profile in provider A must not change provider B's [`ClineProvider.getState()`](../src/core/webview/ClineProvider.ts:2925).
2. Two active tasks in separate provider instances with same mode slug but different model/reasoning configs: request path in task A must use model A, request path in task B must use model B.
3. Restoring history item in provider A must not mutate provider B runtime state.
4. Direct checkpoint restore payload should be task-id validated.
5. Restore in task A should not delete task B messages or task B checkpoint directory.
6. Restore in task A should notify or pause task B if both share the same workspace.
7. Preview checkpoint operation should either be verified as workspace-mutating and documented, or changed to read-only and tested.

## Final assessment

### Model/context isolation

Quality: **Good, with minor hardening needed**.

The main model context does not appear to cross between sessions during LLM requests. The key path uses [`Task.getSessionApiConfiguration()`](../src/core/task/Task.ts:854), session runtime snapshots are persisted in [`taskMetadata()`](../src/core/task-persistence/taskMetadata.ts:43), and global provider profile activation is no longer the default in [`ClineProvider.activateProviderProfile()`](../src/core/webview/ClineProvider.ts:2020).

### Checkpoint checkout/rollback isolation

Quality: **Partial**.

Task metadata and message rewinds are isolated by task id, but workspace restore is shared across all sessions using the same workspace. Rollback in one session should not clear other chat histories, but it can alter files and therefore invalidate the working context of other sessions.

## Recommended release gate

Do not describe the feature as “maximum/full isolation” until checkpoint restore has workspace-level coordination. A safer release statement is:

> Model, role, and provider runtime configuration are session-scoped. Checkpoint restore remains workspace-scoped and affects all sessions opened on the same workspace.

## Priority remediation plan

1. Add task-id validation to checkpoint restore requests.
2. Add workspace-level restore lock keyed by canonical workspace path.
3. Broadcast restore events to all active providers/sessions in the same workspace.
4. Mark affected sessions stale and require context refresh before further tool/LLM execution.
5. Clarify preview semantics or implement true diff-only preview.
6. Add multi-provider/multi-window tests for session runtime isolation.
7. Add checkpoint cross-session safety tests.
