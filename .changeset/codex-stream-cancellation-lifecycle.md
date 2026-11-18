---
"kilo-code": patch
---

Prevent Codex transport cleanup from being mistaken for user Stop, process the final stream fragment before reading ahead, close usage collection before a new request, and surface safe terminal errors without replaying partially accepted work.
