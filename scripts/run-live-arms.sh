#!/usr/bin/env bash
# run-live-arms.sh — the live fidelity arms, in the order they were measured.
#
# Every arm writes a result file under packages/genui/fixtures/ and the
# side-by-side report reads them:
#
#   node packages/genui/scripts/report-live.mjs --in=... --in=...
#
# THE BUDGET IS THE MEASUREMENT CEILING (measured 2026-10-21): Groq's
# per-model DAILY token cap is 200 000 tokens and frees tokens slowly
# (~500/minute). One 50-prompt arm costs ~150 000 tokens — most of a day's
# allowance — and a prompt that outruns the cap never reaches the model.
# The report says so per arm ("reached the model", and a BUDGET-CAPPED
# warning), because an arm that measured the budget instead of the pipeline
# must not be read as a property of the pipeline.
#
# PROVIDERS. `--provider=` picks the endpoint (packages/genui/src/providers.ts
# is the registry: the base URL, where the key lives, that provider's budget).
# A key is NEVER a command-line argument: it comes from the environment or
# from a key file by path+field. The harness prints where the key came from,
# never the key.
#
#   groq        the historical arms; the daily cap is spent on this account
#   openrouter  the free pool; the key is in the estate's scoped env
#   kilo        the free pool; the key is in opencode's auth store
#
# The OpenRouter and Kilo legs may run CONCURRENTLY (separate quota pools);
# the Groq legs are sequential (one shared budget).
#
# THE MODEL IS PINNED, never a router: a router picks a model per request, so
# an arm that cannot name the model it ran on measures nothing. The harness
# records the model the provider says it SERVED, next to the one requested.
#
# The prompt carries the node SHAPE and the per-component prop CONTRACT.
# Both are ON by default (they are the biggest measured lever); the eval
# harness keeps them as flags because a measured arm must state which
# prompt it ran: --no-prop-contract / --no-node-shape measure the control,
# and the report names the contract each arm ran.
#
# Usage:
#   bash packages/genui/scripts/run-live-arms.sh [groq|openrouter|kilo|all]
#   LIMIT=12 MODEL=... bash packages/genui/scripts/run-live-arms.sh openrouter
set -u
cd "$(dirname "$0")/../../.."

F=packages/genui/fixtures
LOG=${LOG:-/tmp/opencode}
MODEL=${MODEL:-qwen/qwen3.8-27b}
OR_MODEL=${OR_MODEL:-poolside/laguna-s-2.1:free}
OR_MODEL2=${OR_MODEL2:-nvidia/nemotron-3-ultra-550b-a55b:free}
KILO_MODEL=${KILO_MODEL:-poolside/laguna-s-2.1:free}
LIMIT=${LIMIT:-12}
WHICH=${1:-all}

mkdir -p "$LOG"

run () {
  local name="$1"; shift
  echo "=== START $name $(date -u +%H:%M:%S) ===" >> "$LOG/chain.log"
  node scripts/with-env.mjs node packages/genui/scripts/eval-live.mjs "$@" \
    > "$LOG/$name.log" 2>&1
  echo "=== EXIT $? $name $(date -u +%H:%M:%S) ===" >> "$LOG/chain.log"
}

# ---------------------------------------------------------------- groq legs --
# The historical arms. Groq's per-model daily cap is spent on this account,
# so these cannot be re-measured today; they are kept so the committed
# fixtures stay reproducible.
if [ "$WHICH" = "groq" ] || [ "$WHICH" = "all" ]; then
  # The mode comparison: the SAME 50-prompt live set the json-object arm
  # used (--limit caps it to what the daily budget can carry).
  run live-strict-qwen \
    --mode=strict --model=$MODEL --prompts=$F/live-prompts.json --limit=$LIMIT \
    --out=$F/live-strict-qwen-results.json

  # The held-out set (12 specs by a different author), strict WITHOUT the
  # prop contract — the control for the fix below.
  run live-heldout-strict \
    --mode=strict --model=$MODEL --prompts=$F/heldout-prompts.json \
    --out=$F/live-heldout-strict-results.json

  # The FIX arm: the per-component prop contract in the prompt.
  run live-heldout-strict-contract \
    --mode=strict --model=$MODEL --prompts=$F/heldout-prompts.json --prop-contract \
    --out=$F/live-heldout-strict-contract-results.json

  # The prompt's control: the same prompt change under json-object.
  run live-heldout-jsonobject-contract \
    --mode=json-object --model=$MODEL --prompts=$F/heldout-prompts.json --prop-contract \
    --out=$F/live-heldout-jsonobject-contract-results.json
fi

# ----------------------------------------------------------- openrouter legs --
# The free pool. poolside/laguna-s-2.1:free is used for the mode comparison
# because it implements the strict decoder; nemotron-550b is the stronger
# free model but its strict output is unparseable, so it runs json-object.
if [ "$WHICH" = "openrouter" ] || [ "$WHICH" = "all" ]; then
  # The headline json-object arm, on a model that works in BOTH modes (so the
  # strict leg can be compared with the model held constant).
  run live-or-poolside-json \
    --provider=openrouter --model=$OR_MODEL --mode=json-object \
    --node-shape --prop-contract \
    --prompts=$F/live-prompts.json \
    --out=$F/live-openrouter-poolside-json-results.json

  # The same set on a stronger free model: the model's own contribution.
  run live-or-nemotron-json \
    --provider=openrouter --model=$OR_MODEL2 --mode=json-object \
    --node-shape --prop-contract \
    --prompts=$F/live-prompts.json \
    --out=$F/live-openrouter-nemotron-json-results.json

  # The held-out set (12 specs by a different author), with the prompt contract
  # and without it: the A/B that says what the contract is worth.
  run live-heldout-or-json-contract \
    --provider=openrouter --model=$OR_MODEL --mode=json-object \
    --node-shape --prop-contract \
    --prompts=$F/heldout-prompts.json \
    --out=$F/live-heldout-openrouter-json-contract-results.json

  run live-heldout-or-json-nocontract \
    --provider=openrouter --model=$OR_MODEL --mode=json-object --node-shape --no-prop-contract \
    --prompts=$F/heldout-prompts.json \
    --out=$F/live-heldout-openrouter-json-nocontract-results.json
fi

# ----------------------------------------------------------------- kilo legs --
# The same free model behind Kilo's gateway. This is the leg that carries the
# CONTROLLED 2x2: {json-object, strict} x {contract on, off} on ONE pinned
# model, so the mode can be compared with the model held constant — the
# first time that comparison is not confounded.
if [ "$WHICH" = "kilo" ] || [ "$WHICH" = "all" ]; then
  # The headline strict arm, and the model-controlled json-object control.
  run live-kilo-poolside-strict \
    --provider=kilo --model=$KILO_MODEL --mode=strict \
    --node-shape --prop-contract \
    --prompts=$F/live-prompts.json \
    --out=$F/live-kilo-poolside-strict-results.json

  run live-kilo-poolside-json \
    --provider=kilo --model=$KILO_MODEL --mode=json-object \
    --node-shape --prop-contract \
    --prompts=$F/live-prompts.json \
    --out=$F/live-kilo-poolside-json-results.json

  # The SEALED held-out set (14 specs, written by a different agent, never
  # seen by the pipeline): the contract A/B in BOTH modes, on a set that was
  # not looked at while the contract was being developed.
  run live-sealed-kilo-strict-contract \
    --provider=kilo --model=$KILO_MODEL --mode=strict \
    --node-shape --prop-contract \
    --prompts=$F/sealed-heldout-prompts.json \
    --out=$F/live-sealed-kilo-strict-contract-results.json

  run live-sealed-kilo-json-contract \
    --provider=kilo --model=$KILO_MODEL --mode=json-object \
    --node-shape --prop-contract \
    --prompts=$F/sealed-heldout-prompts.json \
    --out=$F/live-sealed-kilo-json-contract-results.json

  run live-sealed-kilo-json-nocontract \
    --provider=kilo --model=$KILO_MODEL --mode=json-object --node-shape --no-prop-contract \
    --prompts=$F/sealed-heldout-prompts.json \
    --out=$F/live-sealed-kilo-json-nocontract-results.json

  run live-sealed-kilo-strict-nocontract \
    --provider=kilo --model=$KILO_MODEL --mode=strict --node-shape --no-prop-contract \
    --prompts=$F/sealed-heldout-prompts.json \
    --out=$F/live-sealed-kilo-strict-nocontract-results.json

  # The dev-set contract A/B (the other half of the 2x2).
  run live-kilo-poolside-json-nocontract \
    --provider=kilo --model=$KILO_MODEL --mode=json-object --node-shape --no-prop-contract \
    --prompts=$F/live-prompts.json \
    --out=$F/live-kilo-poolside-json-nocontract-results.json

  run live-kilo-poolside-strict-nocontract \
    --provider=kilo --model=$KILO_MODEL --mode=strict --node-shape --no-prop-contract \
    --prompts=$F/live-prompts.json \
    --out=$F/live-kilo-poolside-strict-nocontract-results.json
fi

echo "=== ARMS DONE $(date -u +%H:%M:%S) ===" >> "$LOG/chain.log"
