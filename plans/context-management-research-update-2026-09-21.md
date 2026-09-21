# Context management research update — 2026-09-21

## Scope

This note extends `skill-state-context-improvements.md` and `skill-state-u1-u3-integration-plan.md`.
It records research published after the original SKILL.state v2 analysis and translates it into concrete constraints for Kilo Code.

## Updated evidence

### SKILL.state v3

The source paper has advanced from the locally archived v2 to arXiv v3 (2026-09-02).
The core conclusion is unchanged: a mutable, validated execution state is a better long-horizon working representation than repeatedly reconstructing state from append-only conversational history.

For Kilo Code, the transferable idea remains:
- keep task semantics in a bounded structured state;
- validate state at runtime;
- do not make raw history the only source of task continuity.

### Scroll — Context as an Environment

Scroll (arXiv:2608.21690) adds a useful complement to SKILL.state:
- preserve an append-only event log as lossless ground truth;
- keep a separate typed working namespace;
- materialize only explicit projections into the model context;
- retain compact addresses/landmarks for evicted spans so old evidence can be recovered without re-sending the whole log.

This directly supports Kilo Code's existing non-destructive history model. It argues against destructive deletion of tool results and for addressable projection/eviction.

### Context Window Lifecycle (CWL)

CWL (arXiv:2606.11213) reinforces another design rule:
- evict semantically typed, recoverable episodes before user intent and active reasoning;
- prefer deterministic eviction policies over repeated LLM summarization when the effect of an action is already persisted in the environment.

For coding agents, tool outputs whose durable effect is a file edit, command exit status, or persisted artifact are strong candidates for early replacement by compact observations.

## Architectural decision

The target architecture is now explicitly a two-plane model:

1. **Lossless plane**
   - full API/task history remains persisted;
   - tool use/result pairing is preserved;
   - rewind/audit/resume can recover original evidence.

2. **Working-context plane**
   - bounded `TaskExecutionStateV1`;
   - latest user/tool observation;
   - recent conversational turns needed for local coherence;
   - compact references to evicted/replaced historical evidence.

The working plane may become O(1)-bounded in steady state, while the lossless plane may continue to grow on disk.

## Current branch status after this update

### Phase 0 — implemented
- context composition instrumentation;
- bounded context-window overflow recovery;
- regression coverage around legacy context management.

### Phase 1 / U1 — implemented behind `taskExecutionState`
- versioned bounded schema;
- separate `task_execution_state.json` persistence;
- runtime-owned todo synchronization;
- deterministic bounded rendering;
- task-state accounting separated from general environment details;
- session-level treatment lock by persisted state-file presence;
- missing/corrupt state fails back to legacy context and never blocks the task.

### U2 — next gate, shadow first
Do not hide raw tool results yet. First record typed observations and simulate retention decisions while sending the exact legacy payload.

Recommended observation envelope:
- stable observation id;
- tool name / tool-use id;
- timestamp;
- semantic class (read/search/command/edit/browser/MCP/other);
- compact projection;
- recoverability pointer to source message/block;
- retention class: pinned / recent / replaceable / protected-pair;
- estimated raw vs projected token counts.

### U3 — after U2 shadow quality gate
Structured condense should update state transactionally and preserve a short narrative only for information not representable in state. It must retain provider-specific thinking/tool-pair validity and fall back to legacy condense on parse/validation failure.

## Non-negotiable safety constraints

- Never destructively delete history as part of U1/U2 rollout.
- Never break native tool_use/tool_result pairs.
- Never reconstruct decisions/hypotheses from old history silently.
- Never let task-state persistence failures stop a task.
- Never enable compact-history treatment for a pre-existing legacy session merely because a global experiment flag changed.
- Treat user turns and explicit user constraints as non-evictable unless represented losslessly and recoverably.
- Keep telemetry content-free: sizes, counts, retention classes, and ids only.

## Evaluation portfolio

Following the repository's eval guidance, use three layers:

### Canary
Small deterministic release blockers:
- flag-off payload equivalence;
- state schema validation;
- corrupt/missing state fallback;
- native tool pair integrity;
- resume/rewind state treatment stability;
- no raw content in telemetry.

### Golden
Representative long coding sessions:
- multi-file refactor;
- test/fix loop with long command output;
- codebase search followed by edits;
- subtask delegation and parent resume;
- provider switch with extended thinking.

Metrics:
- task success;
- cumulative input tokens;
- p50/p95 prompt tokens per turn;
- repeat-tool/action rate;
- condense count and latency;
- fallback rate.

### Chaos
Adversarial/failure cases:
- huge terminal output;
- malformed persisted state;
- task killed during state write;
- tool result containing XML-like closing tags;
- provider context-overflow error;
- rewind across condense boundary;
- duplicate/native tool ids.

## Rollout gates

Keep the existing Gate A-D structure, with one additional rule:

**No destructive U2 compaction until shadow mode demonstrates both**
1. zero protocol-integrity regressions, and
2. recoverability of every replaceable observation through a stable persisted source reference.
