# System-role probe — kilo/poolside/laguna-s-2.1:free

Probed: 2026-10-22T12:36:28.070Z
Route: https://api.kilo.ai/api/gateway/v1
Key source: file:/home/p31/.local/share/opencode/auth.json#kilo.key

## Verdict

**DELIVERED, but the user role wins the conflict.**

## The probes

| probe | system message | user message | answer | verdict |
|---|---|---|---|---|
| conflict | "Reply with EXACTLY the word ALPHA. Nothi" | "Reply with EXACTLY the word BETA. Nothin" | "BETA" | BETA |
| system-only | "Reply with EXACTLY the word ALPHA. Nothi" | "Say hello." | "ALPHA" | ALPHA |
| control | (none) | "Reply with EXACTLY the word BETA. Nothin" | "BETA" | BETA |

## Why it matters

The contract-placement A/B (packages/genui/fixtures/smoke-contract-user-results.json
and smoke-contract-system-results.json) put the same contract words in the
user role and the system role. The system role was much worse. This probe
separates the two explanations for that: the ROUTE dropped the system
message, or the MODEL gave it less weight. The former makes the A/B a
statement about the route; the latter makes it a statement about attention.
