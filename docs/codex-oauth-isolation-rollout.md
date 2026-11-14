# Codex OAuth and request isolation — rollout notes

Scope: one local VS Code credential/lock domain, with all windows upgraded to the same version. Mixed versions, different profiles with independent globalStorageUri, Remote SSH, containers and other computers have not been verified and must not be described as protected by the same lock.

## Transport and cancellation

- Codex defaults to SDK transport with its own retries disabled. KILOCODE_CODEX_TRANSPORT=sse is an explicit opt-in for predetermined SDK incompatibility; there is no post-dispatch SDK-to-SSE replay.
- A finite request budget covers OAuth waiting, connection open, and streaming. Default: 600 seconds. Explicit HTTP 401 allows one refresh/retry in the remaining budget, only before response content is accepted.
- Only definite pre-response HTTP 429 or 5xx are eligible for two Task-managed automatic retries. Unknown network outcomes, user cancellation, HTTP 403, and partial reasoning/tool/text output are terminal; the UI must offer an explicit continuation.
- Condensing has its own handler and cancellation controller.

## SecretStorage and child agents

- Credentials are stored only in VS Code SecretStorage. Lock and epoch files contain no tokens, email, account IDs or prompts.
- Parent/child IPC shares only an access-token and account-ID snapshot. No refresh token is passed through environment, on-disk config or IPC.
- The lock key uses the current extension globalStorageUri. Before release, manually establish that all windows intended to share a credential store also share the same lock directory, including any VS Code profiles being supported; verify SecretStorage reads genuinely observe another process's completed writes. If not, do not enable cross-profile guarantees; choose a single credential owner instead.
- Stale-lock recovery is not distributed exactly-once OAuth. Server rotation followed by a crash before persistence can require explicit login.

## Verification gates

1. Run focused Codex tests, extension/runtime type checks, lint, format check and git diff --check.
2. Locally exercise two real windows using a test ChatGPT account: parallel tasks, cancel only A, complete B, sign out of A during B refresh, then sign in again; check both windows' account snapshot/version behavior.
3. Verify bounded HTTP 401/403/429, TCP close on cancellation, post-header SSE timeout, truncated stream/EOF behavior, and tool-history persistence after errors.
4. Test Agent Manager with two children, stopping the parent, cancellation of one child, switching a virtual-quota profile to Codex, and reconnecting. Inspect logs for accidental token/argument leakage.
5. Update all active VS Code windows together; do not claim support for mixed versions or unverified domains.

Synthetic two-process lock tests and localhost HTTP tests do not establish production SecretStorage or ChatGPT server behavior.
