# superseded-2026-10-22

Nothing measured is ever deleted — only superseded. This directory holds the
**first run** of the contract-placement A/B, kept because the second run
replaced it at the canonical paths.

## What these are

| file | what it is |
|---|---|
| `smoke-contract-user-results.run1.json` | the control arm (contract in the USER role), six prompts, 2026-10-22T12:32Z |
| `smoke-contract-system-results.run1.json` | the treatment arm (contract in the SYSTEM role), the same six prompts |
| `manifest-smoke-user.run1.json` | run 1's user-arm manifest |
| `manifest-smoke-system.run1.json` | run 1's system-arm manifest |

## Why they were superseded

The A/B was measured once (12:32–12:35Z), and then measured AGAIN from
scratch (12:42–12:45Z) so the result would be a replication rather than a
single sample, and so the fixtures would carry the **contract-text hash**
that the harness gained between the two runs (claim register row 25: the arm
fingerprint cannot see the prompt's words).

Run 1's result and run 2's agree: the control is 6/6 first-pass in both,
the treatment is 0/6 first-pass in both. The current fixtures at
`packages/genui/fixtures/smoke-contract-*.json` are run 2.

## Reading them

These files predate the contract-text hash, so their rows carry no
`contractTextHash` and count as `unknown` — they were measured with the
same contract text as run 2 (nothing in the contract changed between the
two runs), but the harness could not record that at the time.
