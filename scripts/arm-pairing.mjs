#!/usr/bin/env node
/**
 * arm-pairing.mjs — the scheduler's worklist, and the report's comparable
 * prefix.
 *
 * PROMPT-MAJOR MEANS PAIRED. The arms are scheduled so that each prompt
 * goes through every arm in turn: a budget cut leaves the arms measured
 * on the SAME prompts instead of leaving one arm with 40 prompts and
 * another with 20. This script is where that pairing is decided.
 *
 *   --plan      print the prompt ids that are NOT yet measured by EVERY
 *               arm — the scheduler's worklist, one id per line
 *   --paired    print the prompt ids that EVERY arm has measured — the
 *               comparable prefix
 *
 *   --prompts=<file>        the prompt set (ids + prompt text)
 *   --arm=<label>:<file>    an arm's result fixture; repeatable
 *
 * The join is by prompt TEXT: a fixture row carries the prompt, and a row
 * written before the id field existed carries nothing else.
 *
 * A prompt that a provider ERRORED on is not measured — the model never
 * answered it, so the next window must try it again. Only an answered
 * prompt counts towards the pairing.
 *
 * Usage:
 *   node packages/genui/scripts/arm-pairing.mjs --plan \
 *     --prompts=packages/genui/fixtures/live-prompts.json \
 *     --arm=A1:packages/genui/fixtures/live-kilo-poolside-json-results.json \
 *     --arm=A3:packages/genui/fixtures/live-kilo-poolside-strict-results.json
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { planPairing, compareArms } from '../src/pairing.ts';

const args = process.argv.slice(2);
const getArg = (name, dflt = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};

const PROMPTS = getArg('prompts');
if (!PROMPTS) {
  console.error('usage: arm-pairing.mjs --plan|--paired --prompts=<file> --arm=<label>:<file> …');
  process.exit(2);
}

const specs = JSON.parse(readFileSync(resolve(process.cwd(), PROMPTS), 'utf8'));

const arms = [];
for (const a of args.filter((x) => x.startsWith('--arm='))) {
  const spec = a.slice('--arm='.length);
  const colon = spec.indexOf(':');
  if (colon < 0) {
    console.error(`arm-pairing: --arm must be <label>:<file>, got ${spec}`);
    process.exit(2);
  }
  const label = spec.slice(0, colon);
  const file = spec.slice(colon + 1);
  const abs = resolve(process.cwd(), file);
  if (!existsSync(abs)) {
    console.error(`arm-pairing: missing arm fixture ${file}`);
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(abs, 'utf8'));
  arms.push({ label, rows: raw.results ?? [] });
}

if (!arms.length) {
  console.error('arm-pairing: no --arm= fixtures given');
  process.exit(2);
}

const plan = planPairing(specs, arms);

if (args.includes('--plan')) {
  for (const id of plan.missing) console.log(id);
  process.exit(0);
}

if (args.includes('--paired')) {
  for (const id of plan.paired) console.log(id);
  process.exit(0);
}

// The pairwise view: which pair of arms may be compared on which span.
if (args.includes('--pairs')) {
  const labels = arms.map((a) => a.label);
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const c = compareArms(specs, arms, labels[i], labels[j]);
      console.log(
        `${c.a} vs ${c.b}: common ${c.common.length}, common PREFIX ${c.commonPrefix.length}` +
          ` (${c.aCount} vs ${c.bCount} measured; only ${c.a}: ${c.onlyA}, only ${c.b}: ${c.onlyB})`,
      );
    }
  }
  process.exit(0);
}

console.log('prompt ids:      ' + plan.order.length);
console.log('paired prefix:   ' + plan.pairedLength);
for (const [label, n] of Object.entries(plan.counts)) {
  console.log(`  ${label.padEnd(6)} measured ${n}`);
}
console.log('still to measure: ' + plan.missing.length);
