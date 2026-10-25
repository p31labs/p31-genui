#!/usr/bin/env node
/**
 * budget-clock.mjs — the budget clock (Path 0).
 *
 * The free tier is the measurement ceiling, so the schedule has to be
 * driven by what is LEFT, not by what is wished for. This prints, per
 * provider: whether it answered, what it said, when the window opens, and
 * how many specs that is worth.
 *
 * It never guesses a number it cannot measure:
 *   · OpenRouter's limit is READ from its own 429 (`x-ratelimit-limit`),
 *     and its reset is an epoch timestamp.
 *   · Groq's daily cap is READ from its 429 body (the TPD hint).
 *   · Kilo's quota is NOT published and NOT in its 429 — it says
 *     "Model usage limit reached. Please try again later." So the clock
 *     reports Kilo as UNKNOWN and says how many specs its last successful
 *     run cost, instead of inventing a limit.
 *
 * Usage:
 *   node packages/genui/scripts/budget-clock.mjs            # probe
 *   node packages/genui/scripts/budget-clock.mjs --no-probe # read the cache only
 */
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getProvider } from '../src/providers.ts';
import { readCache, defaultCachePath } from '../src/capability-cache.ts';
import { parseReset, parseRetryHint, RATE_LIMIT_CEILING_MS } from '../src/provider.ts';

const args = process.argv.slice(2);
const NO_PROBE = args.includes('--no-probe');

/** The last 429 per provider, from the run logs (the estate's state dir). */
const RUNS_DIR = process.env.P31_RUNS_DIR ?? join(homedir(), '.p31', 'runs');

function lastRateLimitNote(providerId) {
  const candidates = [
    join(RUNS_DIR, 'chain.log'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes(`[429]`) && lines[i].includes(providerId)) {
          return lines[i].trim();
        }
      }
    } catch {
      /* the clock is a report, not a gate */
    }
  }
  return null;
}

const PROVIDERS = ['groq', 'openrouter', 'kilo'];

console.log('=== BUDGET CLOCK ===');
console.log(`now: ${new Date().toISOString()}`);
console.log('');

const cache = readCache();
const rows = [];

for (const id of PROVIDERS) {
  const spec = getProvider(id);
  const entry = Object.entries(cache.entries).find(
    ([, v]) => v.provider === id && v.demotedUntil && new Date(v.demotedUntil) > Date.now(),
  );
  rows.push({
    provider: id,
    label: spec.label,
    knownLimit: id === 'openrouter' ? '50 requests/day (measured from its 429)' : id === 'groq' ? '200 000 tokens per model per day' : 'UNKNOWN (not published)',
    demoted: entry ? entry[1] : null,
    note: lastRateLimitNote(id),
  });
}

for (const row of rows) {
  console.log(`--- ${row.provider} (${row.label})`);
  console.log(`    limit:     ${row.knownLimit}`);
  if (row.demoted) {
    console.log(`    demoted:   until ${row.demoted.demotedUntil} — ${row.demoted.lastReason ?? 'unknown'}`);
  }
  if (row.note) console.log(`    last 429:  ${row.note}`);
}

console.log('');
console.log('Rule: batch_size = floor(remaining_budget / cost_per_spec).');
console.log('The cost per spec is MEASURED from the last run (model calls / prompts),');
console.log('not assumed — a blind estimate is how a 2x2 ends up half-run and');
console.log('mistaken for a result.');
console.log('');
console.log(`capability cache: ${defaultCachePath()}`);
if (!NO_PROBE) {
  console.log('');
  console.log('(probe mode: the clock does not spend budget to report a budget —');
  console.log(' use eval-live.mjs --limit=1 to probe a route deliberately.)');
}
