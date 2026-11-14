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
- A non-secret `.openai-codex-secret-write-pending` marker prevents another participating window from committing credentials while a prior asynchronous SecretStorage write is still unresolved. If persistence fails ambiguously, or the lock is compromised during a write, the marker remains and reads/writes fail closed. **SecretStorage does not support cancelling an already dispatched write or transactional CAS.** Do not claim such guarantees for old extension versions or unshared lock domains.
- Recovery from a persistent pending-write marker: first close **all** windows/processes in that credential domain and ensure no SecretStorage operation can still be running. Remove only the non-secret pending marker from that extension profile's globalStorageUri, restart the updated extension, explicitly sign out and sign back in. Never remove the marker while another window is active; do not copy or inspect production tokens in diagnostics.

## Verification gates

1. Run focused Codex tests, extension/runtime type checks, lint, format check and git diff --check.
2. Locally exercise two real windows using a test ChatGPT account: parallel tasks, cancel only A, complete B, sign out of A during B refresh, then sign in again; check both windows' account snapshot/version behavior.
3. Verify bounded HTTP 401/403/429, TCP close on cancellation, post-header SSE timeout, truncated stream/EOF behavior, and tool-history persistence after errors.
4. Test Agent Manager with two children, stopping the parent, cancellation of one child, switching a virtual-quota profile to Codex, and reconnecting. Inspect logs for accidental token/argument leakage.
5. Update all active VS Code windows together; do not claim support for mixed versions or unverified domains.

Synthetic two-process lock tests and localhost HTTP tests do not establish production SecretStorage or ChatGPT server behavior.

Unrelated known issue: NativeToolCallParser's process-global streaming state remains outside this OAuth/request-lifecycle patch. Do not use its old failing characterization to gate this fix.

## Real VS Code SecretStorage acceptance (not simulated)

Use the **same fixed VSIX** in two local VS Code windows of one intended profile. In each window run **Command Palette → Codex: Verify Shared SecretStorage (Diagnostics)**. The command uses only a separate synthetic marker; it never reads or writes OAuth credentials.

1. Window A: **Write synthetic marker**. Record the 12-character storage-domain fingerprint and synthetic marker in the information message.
2. Window B: **Read synthetic marker**. Both the fingerprint **and** marker must exactly match A. A matching marker with a different fingerprint means the lock domain does **not** match the shared secret store; missing marker is also a failure.
3. Window B: **Clear synthetic marker**; Window A: **Read** and verify the marker is missing. Repeat with A/B reversed.
4. Using a **test ChatGPT account**, let a token expire naturally and request in both windows simultaneously. Check both Kilo-Code output channels: combined there must be only one `refresh.network-start` and one `refresh.network-complete`, and both tasks must stay on one consistent account. Never rotate production tokens with a debug script.
5. Test login/logout and account change in one window while another is active, including interrupted network followed by reconnect. A stale login must not revive a session; a running request must not silently change accounts. HTTP 403 must not delete credentials.
6. Clear the synthetic marker. Record only pass/fail and non-secret operation categories. **Never capture access tokens, refresh tokens, account IDs or prompt contents.** If storage domain or secret observations disagree, withhold the cross-window guarantee.

Unit tests exercise the probe contract with synthetic storage. An actual two-window VS Code acceptance run is mandatory and cannot be replaced by those mocks.
