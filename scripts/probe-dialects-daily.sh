#!/usr/bin/env bash
# probe-dialects-daily.sh — the per-route schema-dialect probe.
#
# The per-component (adjacency) strict schema is a HYPOTHESIS about what a
# provider's strict decoder accepts. The provider rules were established by
# failing probes, so this one is probed the same way — and the probe is
# cheap (3 requests) compared with an arm (~110), so it runs FIRST: if a
# route accepts the adjacency dialect, an arm can use it; if it rejects
# it, the route stays on the proven dialect and the capability cache
# demotes the combination.
#
# The results are written to a dated file under packages/genui/fixtures/ so
# the capability table is a committed artifact, not a log line.
set -u
cd /home/p31/production
LOG=${P31_LOG_DIR:-/home/p31/.p31/runs}
OUT=packages/genui/fixtures/dialect-probe
mkdir -p "$LOG" "$OUT"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SUMMARY="$OUT/probe-$STAMP.md"

{
  echo "# Schema-dialect probe — $STAMP"
  echo
} > "$SUMMARY"

probe () {
  local name="$1"; shift
  local log="$LOG/probe-$name-$STAMP.log"
  echo "=== PROBE $name $(date -u +%H:%M:%S) ===" >> "$LOG/chain.log"
  node scripts/with-env.mjs node packages/genui/scripts/probe-schema-dialect.mjs "$@" \
    > "$log" 2>&1
  local code=$?
  echo "=== PROBE EXIT $code $name $(date -u +%H:%M:%S) ===" >> "$LOG/chain.log"
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
# Groq: the route with its own token budget, and the one that rejected a
# top-level anyOf before.
#
# OFF while GROQ_API_KEY is the EXPOSED key — it was pasted into a
# transcript, so it is burned and public (docs/runbooks/credential-rotation.md
# §2). An automated daily job must not keep spending a credential that is
# known to be exposed, and the rotation is dashboard work the agent cannot
# do. The other two legs still probe the same properties, so the artifact
# keeps its value.
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
# OpenRouter: the same model on the second free provider.
probe openrouter-poolside --provider=openrouter --model=poolside/laguna-s-2.1:free

cp "$SUMMARY" "$OUT/probe.current.md"
echo "dialect probe written: $SUMMARY"
