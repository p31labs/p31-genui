#!/usr/bin/env bash
# probe-strict-enforcement-daily.sh — is the SCHEMA enforced on the strict
# route, or is it only in the prompt?
#
# WHY THIS RUNS DAILY.
#
# The strict arm's heal causes are `fence=2, trailingProse=5`. A
# CONSTRAINED decoder cannot emit a code fence and cannot emit trailing
# prose — those are precisely the two things a structured-output decoder
# removes. So those heals are evidence AGAINST the schema being enforced
# on that route, and the route's enforcement status is a property of the
# PROVIDER, not of a single day's output: it can change with a provider
# upgrade, a router change, or a model swap. A claim about the route that
# is checked once is a claim that goes stale silently.
#
# The probe is 2 requests per route (the strict run and the no-schema
# control), against an arm's ~110, so it is cheap enough to run every day
# next to the dialect probe.
#
# The results are written to a dated file under packages/genui/fixtures/ so
# the verdict is a committed artifact, not a log line.
set -u
cd /home/p31/production
LOG=${P31_LOG_DIR:-/home/p31/.p31/runs}
OUT=packages/genui/fixtures/strict-probe
mkdir -p "$LOG" "$OUT"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SUMMARY="$OUT/probe-$STAMP.md"

{
  echo "# Strict-enforcement probe — $STAMP"
  echo
  echo "A strict schema with a SINGLE-VALUE enum, and a prompt that invites a"
  echo "DIFFERENT value. If the strict output carries the invited value, the"
  echo "route is not constraining the decoder. The no-schema control shows"
  echo "what the model wanted to say."
  echo
} > "$SUMMARY"

probe () {
  local name="$1"; shift
  local log="$LOG/probe-strict-$name-$STAMP.log"
  echo "=== STRICT PROBE $name $(date -u +%H:%M:%S) ===" >> "$LOG/chain.log"
  node scripts/with-env.mjs node packages/genui/scripts/probe-strict-enforcement.mjs "$@" \
    > "$log" 2>&1
  local code=$?
  echo "=== STRICT PROBE EXIT $code $name $(date -u +%H:%M:%S) ===" >> "$LOG/chain.log"
  {
    echo "## $name"
    echo
    echo '```'
    cat "$log"
    echo '```'
    echo
  } >> "$SUMMARY"
}

# Kilo: the route the strict arm runs on.
probe kilo-poolside --provider=kilo --model=poolside/laguna-s-2.1:free
# Groq: the route the legacy strict arm ran on.
#
# OFF while GROQ_API_KEY is the EXPOSED key — it was pasted into a
# transcript, so it is burned and public (docs/runbooks/credential-rotation.md
# §2). An automated daily job must not keep spending a credential that is
# known to be exposed, and the rotation is dashboard work the agent cannot
# do. The Kilo leg still answers the question this probe asks — does the
# route ENFORCE the schema — so the artifact keeps its value.
if [ "${P31_PROBE_GROQ:-0}" = "1" ]; then
  probe groq-gpt-oss --provider=groq --model=openai/gpt-oss-20b
else
  {
    echo "## groq-gpt-oss"
    echo
    echo '```'
    echo "SKIPPED — GROQ_API_KEY is the EXPOSED key (docs/runbooks/credential-rotation.md §2)."
    echo "Set P31_PROBE_GROQ=1 to run this leg again, after the rotation."
    echo '```'
    echo
  } >> "$SUMMARY"
  echo "groq-gpt-oss probe SKIPPED (exposed GROQ_API_KEY; set P31_PROBE_GROQ=1 after rotating)"
fi

cp "$SUMMARY" "$OUT/probe.current.md"
echo "strict-enforcement probe written: $SUMMARY"
