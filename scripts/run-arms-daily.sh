#!/usr/bin/env bash
# run-arms-daily.sh — the DAILY BATCH runner (Path 0 / Path A).
#
# The free tier cannot carry a 50-prompt arm in one sitting: OpenRouter
# allows 50 requests/day (measured from its own 429) and a 50-prompt arm
# costs ~110 calls. So an arm is run in BATCHES across windows, and the
# result file IS the cursor: each batch skips the prompts already measured
# and merges into the same fixture. A batch that is cut short is not lost —
# the next window continues it.
#
# THE SCHEDULE IS PROMPT-MAJOR.
#
# Each prompt goes through EVERY arm in turn, so a budget cut leaves the
# arms measured on the SAME prompts. The old arm-major schedule (A1's
# first 20, then A3's first 20, …) spent the whole day's budget on A1
# and left the other arms with nothing, so the arms could not be compared
# on a shared span — and a comparison across different spans says more
# about the schedule than about the arm. The rule this script exists to
# keep checkable: only the PAIRED PREFIX of the prompt set is comparable
# (see packages/genui/src/pairing.ts).
#
# THE CIRCUIT BREAKER.
#
# A 429 does not fail fast: the provider adapter sleeps and retries, and a
# DAILY token cap frees tokens slowly (measured ~500 tokens/minute), so a
# request can wait minutes. Left alone, a capped arm spends its window
# asleep and records a column of provider errors instead of measurements —
# which is exactly what happened (A2 and A4 recorded 19 and 20 provider
# errors in a row). After N consecutive rate-limit errors the arm STOPS
# for the window, keeps its cursor, and the next window resumes it. The
# other arms carry on: one arm hitting the cap is not a reason to stop
# measuring the others.
#
# The rules this script enforces:
#   · one pinned model per arm (a router picks a model per request, and an
#     arm that cannot name the model it ran on measures nothing)
#   · the arm's configuration is fingerprinted, and a resume REFUSES to
#     append to a fixture measured with a different configuration
#   · every window writes a manifest per arm (git SHA, flags, hashes,
#     route, model)
#   · a BUDGET-CAPPED arm is recorded as such and never read as a property
#     of the pipeline
#
# Usage:
#   bash packages/genui/scripts/run-arms-daily.sh [arm ...]
#   ARMS="A1 A3" BATCH=20 bash packages/genui/scripts/run-arms-daily.sh
#   BREAKER=3 bash packages/genui/scripts/run-arms-daily.sh
#
# The arms (Path A of the runbook):
#   A1  json-object, contract ON   — the control
#   A2  json-object, contract OFF  — the contract A/B
#   A3  strict,      contract ON   — the strict leg
#   A4  strict,      contract OFF  — the contract A/B in strict mode
#   S1  sealed set, strict, contract ON
#   S2  sealed set, json-object, contract ON
#   S3  sealed set, json-object, contract OFF
#   S4  sealed set, strict, contract OFF
set -u
cd "$(dirname "$0")/../../.."

F=packages/genui/fixtures
M=$F/manifests
LOG=${P31_LOG_DIR:-/home/p31/.p31/runs}
PROVIDER=${PROVIDER:-kilo}
MODEL=${MODEL:-poolside/laguna-s-2.1:free}
# The batch size: how many PROMPTS this window may measure, PER GROUP.
# Each prompt costs one measurement per arm in the group, and the measured
# cost per spec is ~2.2 calls, so BATCH=20 spends ~176 calls across the
# four dev arms — the same spend as before, but now spread over the SAME
# twenty prompts instead of twenty prompts per arm.
BATCH=${BATCH:-20}
# How many consecutive rate-limit errors open the circuit for an arm.
BREAKER=${BREAKER:-3}
# DRY=1 prints the schedule instead of running it. The schedule is the part
# that is easy to get wrong and expensive to discover by running it.
DRY=${DRY:-0}
mkdir -p "$M" "$LOG"

WINDOW_STARTED=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

# --- the arms --------------------------------------------------------------
# arm: mode|contract|prompt file|result file
arm_spec () {
  case "$1" in
    A1) echo "json-object|on|$F/live-prompts.json|$F/live-kilo-poolside-json-results.json" ;;
    A2) echo "json-object|off|$F/live-prompts.json|$F/live-kilo-poolside-json-nocontract-results.json" ;;
    A3) echo "strict|on|$F/live-prompts.json|$F/live-kilo-poolside-strict-results.json" ;;
    A4) echo "strict|off|$F/live-prompts.json|$F/live-kilo-poolside-strict-nocontract-results.json" ;;
    S1) echo "strict|on|$F/sealed-heldout-prompts.json|$F/live-sealed-kilo-strict-contract-results.json" ;;
    S2) echo "json-object|on|$F/sealed-heldout-prompts.json|$F/live-sealed-kilo-json-contract-results.json" ;;
    S3) echo "json-object|off|$F/sealed-heldout-prompts.json|$F/live-sealed-kilo-json-nocontract-results.json" ;;
    S4) echo "strict|off|$F/sealed-heldout-prompts.json|$F/live-sealed-kilo-strict-nocontract-results.json" ;;
    *) echo "" ;;
  esac
}

# --- one measurement --------------------------------------------------------
# run_one <arm> <prompt-id>
#
# Measures ONE prompt of ONE arm. The prompt is named explicitly (--only)
# because the schedule is prompt-major: the scheduler decides which prompt
# goes next, not the arm.
run_one () {
  local arm="$1" pid="$2"
  local spec mode contract prompts out
  spec=$(arm_spec "$arm")
  [ -n "$spec" ] || { echo "unknown arm: $arm" >&2; return 2; }
  mode=$(echo "$spec" | cut -d'|' -f1)
  contract=$(echo "$spec" | cut -d'|' -f2)
  prompts=$(echo "$spec" | cut -d'|' -f3)
  out=$(echo "$spec" | cut -d'|' -f4)

  local flags="--provider=$PROVIDER --model=$MODEL --mode=$mode"
  if [ "$contract" = "on" ]; then
    flags="$flags --node-shape --prop-contract"
  else
    flags="$flags --node-shape --no-prop-contract"
  fi
  if [ "$DRY" = "1" ]; then
    echo "DRY $arm prompt=$pid mode=$mode contract=$contract out=$out"
    return 0
  fi
  local log="$LOG/$arm-$pid-$STAMP.log"
  echo "=== START $arm prompt=$pid ($(date -u +%H:%M:%SZ)) mode=$mode contract=$contract" >> "$LOG/chain.log"
  node scripts/with-env.mjs node packages/genui/scripts/eval-live.mjs \
    $flags \
    --prompts="$prompts" \
    --only="$pid" \
    --resume \
    --max-prompts=1 \
    --circuit-breaker="$BREAKER" \
    --window-started="$WINDOW_STARTED" \
    --manifest="$M/$arm-$STAMP.manifest.json" \
    --out="$out" \
    > "$log" 2>&1
  local code=$?
  echo "=== EXIT $code $arm prompt=$pid ($(date -u +%H:%M:%SZ)) log=$log" >> "$LOG/chain.log"
  return $code
}

# --- a group of arms over one prompt set ------------------------------------
# A group is the set of arms that share a prompt set, so that a prompt can
# go through all of them in turn.
run_group () {
  local group="$1"
  local prompts=""
  local first=1
  local arm_args=""
  for arm in $group; do
    local spec mode contract p out
    spec=$(arm_spec "$arm")
    [ -n "$spec" ] || { echo "unknown arm: $arm" >&2; return 2; }
    mode=$(echo "$spec" | cut -d'|' -f1)
    contract=$(echo "$spec" | cut -d'|' -f2)
    p=$(echo "$spec" | cut -d'|' -f3)
    out=$(echo "$spec" | cut -d'|' -f4)
    [ "$first" = "1" ] && prompts="$p" && first=0
    arm_args="$arm_args --arm=$arm:$out"
  done

  # The worklist: the prompt ids that are NOT yet measured by EVERY arm in
  # the group. A prompt measured in one arm but not another is still
  # missing, because the arms have to be paired for the comparison to mean
  # anything.
  local worklist
  worklist=$(node packages/genui/scripts/arm-pairing.mjs --plan \
    --prompts="$prompts" $arm_args 2>/dev/null | head -n "$BATCH")
  if [ "$DRY" = "1" ]; then
    echo "DRY group [$group] prompts=$prompts worklist=$(echo "$worklist" | tr '\n' ' ')"
  fi
  if [ -z "$worklist" ]; then
    echo "=== GROUP $group: every prompt is already measured by every arm ===" >> "$LOG/chain.log"
    return 0
  fi
  local nwork
  nwork=$(echo "$worklist" | wc -l | tr -d ' ')
  echo "=== GROUP $group: $nwork prompt(s) to measure, prompt-major ($prompts) ===" >> "$LOG/chain.log"

  # tripped[arm] = the arm's circuit is open for this window.
  declare -A tripped=()
  for pid in $worklist; do
    local live=0
    for arm in $group; do
      [ -n "${tripped[$arm]:-}" ] && continue
      run_one "$arm" "$pid"
      local code=$?
      if [ "$code" = "75" ]; then
        # The circuit opened: this arm stops for the window.
        tripped[$arm]=1
        echo "=== CIRCUIT OPEN $arm ($(date -u +%H:%M:%SZ)) — it stops for this window ===" >> "$LOG/chain.log"
        continue
      fi
      live=$((live + 1))
    done
    # Every arm in the group is capped: the budget for the window is gone.
    if [ "$live" = "0" ]; then
      echo "=== EVERY ARM IN $group IS CAPPED — ending the window ($(date -u +%H:%M:%SZ)) ===" >> "$LOG/chain.log"
      break
    fi
  done

  # The window's manifests: one per arm, summarising the whole arm. Each
  # invocation overwrote the same path, so the last one written is the
  # arm's window manifest — and it carries the window's start, not the
  # invocation's.
  for arm in $group; do
    if [ -f "$M/$arm-$STAMP.manifest.json" ]; then
      cp "$M/$arm-$STAMP.manifest.json" "$M/$arm.current.manifest.json"
    fi
  done
}

# The order the runbook fixes: the strict-vs-json question first (A1, A3),
# then the contract A/B (A2, A4), then the sealed set.
#
# The ARMS the caller names are honoured, but they are GROUPED by prompt
# set: a prompt can only go through arms that share its prompt set.
# The arms can be named as ARGUMENTS (the documented usage) or in the ARMS
# environment variable. Arguments win: a caller who says "A1 A3" means
# those two arms, and silently running the whole estate instead would
# spend a day's budget on arms nobody asked for.
if [ "$#" -gt 0 ]; then
  ARMS="$*"
else
  ARMS=${ARMS:-"A1 A2 A3 A4 S1 S2 S3 S4"}
fi

dev_arms=""
sealed_arms=""
for arm in $ARMS; do
  case "$arm" in
    A1|A2|A3|A4) dev_arms="$dev_arms $arm" ;;
    S1|S2|S3|S4) sealed_arms="$sealed_arms $arm" ;;
    *) echo "unknown arm: $arm" >&2; exit 2 ;;
  esac
done

if [ -n "$dev_arms" ]; then
  run_group "$dev_arms"
fi
if [ -n "$sealed_arms" ]; then
  run_group "$sealed_arms"
fi

echo "=== DAILY BATCH DONE $(date -u +%H:%M:%SZ) ===" >> "$LOG/chain.log"
