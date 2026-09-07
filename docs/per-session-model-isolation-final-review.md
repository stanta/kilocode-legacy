# Final Review: Per-Session Model Isolation Fix

## Scope and method

Reviewed the working-tree implementation against [`plans/per-session-model-isolation-fix-plan.md`](../plans/per-session-model-isolation-fix-plan.md), including source and focused regression coverage. This review did not change production code.

## Actionable findings

### Major

1. **Kilo Code re-auth can still replace an existing session's Kilo Code model when that session retains a stale generic model field.**

    [`ClineProvider.handleKiloCodeCallback()`](../src/core/webview/ClineProvider.ts:2242) derives the prior model with [`getModelId()`](../packages/types/src/provider-settings.ts:779), then retains it only when it equals [`kilocodeModel`](../src/core/webview/ClineProvider.ts:2248). [`getModelId()`](../packages/types/src/provider-settings.ts:779) returns the first populated model key, and generic [`apiModelId`](../packages/types/src/provider-settings.ts:752) precedes [`kilocodeModel`](../packages/types/src/provider-settings.ts:769). Therefore, a valid existing Kilo Code task with `apiProvider: "kilocode"`, `kilocodeModel: "session-A"`, and a stale `apiModelId: "legacy-B"` fails the equality guard and instead receives the sidebar/default Kilo Code model. This violates the requirement to preserve existing Kilo Code session models during re-auth.

    **Recommendation:** For an existing Kilo Code task, select its non-empty [`kilocodeModel`](../src/core/webview/ClineProvider.ts:2251) directly. Use the configured/default Kilo Code model only when migrating a non-Kilo Code task or when that Kilo Code-specific field is absent. Add a regression case containing the stale [`apiModelId`](../packages/types/src/provider-settings.ts:752) field and assert the task handler, session configuration, and persisted runtime all retain `session-A`.

2. **The regression suite does not prove the effective runtime model for either resume path; the resume tests only inspect mocked spawn arguments.**

    The local, remote-only, remote-over-local, and legacy cases in [`AgentManagerProvider.spec.ts`](../src/core/kilocode/agent-manager/__tests__/AgentManagerProvider.spec.ts:588) replace [`RuntimeProcessHandler.spawnProcess()`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:311) and assert the `model` option. This validates precedence selection, but not the required outcome: that the serialized child configuration and the handler created from it use that model. The handler-focused tests in [`RuntimeProcessHandler.spec.ts`](../src/core/kilocode/agent-manager/__tests__/RuntimeProcessHandler.spec.ts:41) cover new-session serialization and mismatch rejection, but do not exercise a resumed remote metadata model.

    **Recommendation:** Add a composed start/resume test that uses the real [`RuntimeProcessHandler.buildAgentConfig()`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:217) path, parses `AGENT_CONFIG`, and asserts the provider-specific field plus [`buildApiHandler()`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:249) model for local and remote-only resumes. It should specifically prove remote `last_model = A` wins over a local/sidebar `B`.

### Minor

1. **The re-auth tests emulate the handler and session runtime rather than verifying real [`Task.updateApiConfiguration()`](../src/core/task/Task.ts:2006) behavior.**

    [`createSessionTask()`](../src/core/webview/__tests__/ClineProvider.kilocode-organization.spec.ts:99) is a hand-built test double: its reported handler model is derived directly from the mocked configuration at [`ClineProvider.kilocode-organization.spec.ts`](../src/core/webview/__tests__/ClineProvider.kilocode-organization.spec.ts:113), and its runtime state is similarly copied at [`ClineProvider.kilocode-organization.spec.ts`](../src/core/webview/__tests__/ClineProvider.kilocode-organization.spec.ts:115). The assertions establish callback intent, but cannot detect a regression in actual handler rebuilding or runtime binding persistence.

    **Recommendation:** Retain these fast unit tests, but add one focused integration-style case with a real [`Task`](../src/core/task/Task.ts:2006) (or a behavior-faithful fixture) and assert [`task.api.getModel().id`](../src/core/webview/__tests__/ClineProvider.kilocode-organization.spec.ts:140), [`Task.getSessionApiConfiguration()`](../src/core/task/Task.ts:861), and [`Task.getSessionRuntimeConfig()`](../src/core/task/Task.ts:850) agree after re-auth.

## Positive verification

- [`withModelId()`](../packages/types/src/provider-settings.ts:796) makes a new settings snapshot, removes incompatible model ID fields, maps typical providers through [`modelIdKeysByProvider`](../packages/types/src/provider-settings.ts:844), supports custom/faux providers with `apiModelId`, and rejects selector-only [`vscode-lm`](../packages/types/src/provider-settings.ts:802).
- [`RuntimeProcessHandler.buildAgentConfig()`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:217) applies an override to a session-owned copy, compares the requested and resolved handler models before [`fork()`](../src/core/kilocode/agent-manager/RuntimeProcessHandler.ts:388), and reports setup failure without creating a pending/registry session first.
- [`RemoteSessionService.fetchSessionDataForResume()`](../src/core/kilocode/agent-manager/RemoteSessionService.ts:84) propagates cloud `last_model`; [`AgentManagerProvider.resumeSession()`](../src/core/kilocode/agent-manager/AgentManagerProvider.ts:1474) correctly prioritizes it over local metadata and logs the legacy no-metadata path.
- Non-Kilo Code re-auth migration uses [`withModelId()`](../src/core/webview/ClineProvider.ts:2256), which clears stale model fields before [`Task.updateApiConfiguration()`](../src/core/webview/ClineProvider.ts:2277) is invoked.
- The reviewed changes in upstream-shared paths include appropriate `kilocode_change` markers. [`git diff --check`](../.gitignore) completed without whitespace errors.

## Test and build assessment

The focused extension suite passed: 69 tests across [`AgentManagerProvider.spec.ts`](../src/core/kilocode/agent-manager/__tests__/AgentManagerProvider.spec.ts), [`RuntimeProcessHandler.spec.ts`](../src/core/kilocode/agent-manager/__tests__/RuntimeProcessHandler.spec.ts), [`RemoteSessionService.spec.ts`](../src/core/kilocode/agent-manager/__tests__/RemoteSessionService.spec.ts), [`ClineProvider.kilocode-organization.spec.ts`](../src/core/webview/__tests__/ClineProvider.kilocode-organization.spec.ts), and [`Task.sticky-profile-race.spec.ts`](../src/core/task/__tests__/Task.sticky-profile-race.spec.ts). The [`withModelId()`](../packages/types/src/provider-settings.ts:796) test file passed all 6 tests. Type checks passed for [`packages/types`](../packages/types/package.json), [`packages/agent-runtime`](../packages/agent-runtime/package.json), and [`src`](../src/package.json).

The environment ran Node 22 while [`src/package.json`](../src/package.json:12) declares Node 20.20.0; this produced an engine warning but no test, type-check, or build failure.

## Verdict

**Request changes.** The implementation is close and the core provider-aware override/resume mechanics are sound, but the stale-field re-auth case can violate the stated session-model preservation invariant, and the tests do not yet demonstrate effective handler/runtime facts for resumed sessions.
