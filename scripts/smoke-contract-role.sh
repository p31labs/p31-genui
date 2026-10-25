#!/usr/bin/env bash
# smoke-contract-role.sh — the CONTRACT-PLACEMENT A/B, on the prompts that
# failed to compile.
#
# WHAT THIS MEASURES
#
# Two questions, one run:
#
#   1. Does the contract-text fix (the slot table, the per-component
#      examples, the "the top-level object IS the root node" rule) stop the
#      compile failures? The six prompts below are exactly the six prompts
#      the A1 arm (json-object, contract ON) failed to compile, measured with
#      the contract text as it stood BEFORE the fix. Their rejected trees
#      are archived in the fixture, so the failure classes are known:
#      a "root" envelope, props next to "component" instead of inside
#      "props", and props from the wrong component.
#
#   2. Does the contract travel better in the SYSTEM role than in the user
#      role? The same words, in a different role. The default placement
#      (user) is the control, and its prompt bytes are pinned by
#      scripts/contract-role.test.mjs, so the only thing that differs
#      between the two arms is where the contract sits.
#
# THE SCHEDULE IS PROMPT-MAJOR
#
# Each prompt goes through BOTH placements in turn, so a budget cut leaves
# the two arms paired on the same prompts. The result files are the cursors:
# each invocation resumes the same arm and skips what it already measured.
#
# Usage:
#   bash packages/genui/scripts/smoke-contract-role.sh
#   PROMPTS="L4 L8" bash packages/genui/scripts/smoke-contract-role.sh
#   PROVIDER=groq MODEL=openai/gpt-oss-20b bash .../smoke-contract-role.sh
set -u
cd "$(dirname "$0")/../../.."

F=packages/genui/fixtures
M=$F/manifests
LOG=${P31_LOG_DIR:-/home/p31/.p31/runs}
PROVIDER=${PROVIDER:-kilo}
MODEL=${MODEL:-poolside/laguna-s-2.1:free}
# The six prompts the A1 arm failed on (the control arm's own failures).
PROMPTS=${PROMPTS:-"L4 L8 L9 L12 L15 L35"}
# The node binary: the session PATH has no nvm, so bare `node` is v20 and
# the .ts imports fail with ERR_UNKNOWN_FILE_EXTENSION.
NODE=${NODE:-/home/p31/.config/nvm/versions/node/v24.16.0/bin/node}
mkdir -p "$M" "$LOG"

WINDOW_STARTED=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

run_one () {
  local role="$1" pid="$2"
  local out="$F/smoke-contract-$role-results.json"
  local log="$LOG/smoke-$role-$pid-$STAMP.log"
  echo "=== START smoke $role prompt=$pid ($(date -u +%H:%M:%SZ))" >> "$LOG/chain.log"
  "$NODE" scripts/with-env.mjs "$NODE" packages/genui/scripts/eval-live.mjs \
    --provider="$PROVIDER" --model="$MODEL" --mode=json-object \
    --node-shape --prop-contract \
    --contract-role="$role" \
    --prompts="$F/live-prompts.json" \
    --only="$pid" \
    --resume \
    --max-prompts=1 \
    --window-started="$WINDOW_STARTED" \
    --manifest="$M/smoke-$role-$STAMP.manifest.json" \
    --out="$out" \
    > "$log" 2>&1
  local code=$?
  echo "=== EXIT $code smoke $role prompt=$pid ($(date -u +%H:%M:%SZ)) log=$log" >> "$LOG/chain.log"
  # A provider error (the budget is gone) is not a measurement: the row is
  # not written, and the next window tries the prompt again.
  if [ "$code" != "0" ]; then
    echo "!! smoke $role prompt=$pid exited $code — see $log" >&2
  fi
  return $code
}

for pid in $PROMPTS; do
  # PROMPT-MAJOR: the control first, then the treatment, on the SAME prompt.
  run_one user "$pid" || true
  run_one system "$pid" || true
done

for role in user system; do
  if [ -f "$M/smoke-$role-$STAMP.manifest.json" ]; then
    cp "$M/smoke-$role-$STAMP.manifest.json" "$M/smoke-$role.current.manifest.json"
  fi
done

echo "=== CONTRACT-ROLE SMOKE DONE ($(date -u +%H:%M:%SZ)) ===" >> "$LOG/chain.log"
echo "results: $F/smoke-contract-user-results.json  $F/smoke-contract-system-results.json"
