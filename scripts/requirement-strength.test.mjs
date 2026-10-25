#!/usr/bin/env node
/**
 * requirement-strength.test.mjs — can the requirement metric FAIL?
 *
 * THE CONTRACT.
 *
 * The requirement metric is the correctness metric. A metric that cannot
 * fail measures nothing: every tree would pass and the number would be a
 * constant. The reviewer's objection — "it also fits 'the requirements are
 * easy'" — is therefore not answered by quoting the pass rate; it is
 * answered by showing that every requirement CAN be made to fail, and by
 * measuring how much of a spec an empty shell satisfies.
 *
 * TWO CHECKS, both offline and free (no provider call, no budget):
 *
 *   1. DISCRIMINATION — for every requirement in every prompt set, build
 *      a tree that violates exactly that requirement and check the scorer
 *      reports it as FAILED. A requirement no tree can break is vacuous.
 *
 *   2. SKELETON — build a tree with the right component NAMES and no
 *      content at all, and report the share of requirements it satisfies.
 *      This is the honest measure of how much of a spec is component
 *      names versus real content. It is printed, not gated: a spec that
 *      asks only for components is a legitimate spec, and the number
 *      belongs in the report rather than in a pass/fail.
 *
 * The gold tree must satisfy every one of its own requirements (that is
 * the verifier's job — see verify-requirements.mjs). Here it is checked
 * again, because a requirement the GOLD tree fails would make the
 * discrimination result meaningless.
 *
 * Usage:
 *   node packages/genui/scripts/requirement-strength.test.mjs
 *   node packages/genui/scripts/requirement-strength.test.mjs --json
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { probeRequirementStrength } from '../src/rescore.ts';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SETS = [
  'fixtures/live-prompts.json',
  'fixtures/heldout-prompts.json',
  'fixtures/sealed-heldout-prompts.json',
];

const specs = [];
for (const s of SETS) {
  const abs = resolve(PKG, s);
  if (!existsSync(abs)) {
    console.error(`requirement-strength: missing prompt set ${s}`);
    process.exit(2);
  }
  specs.push(...JSON.parse(readFileSync(abs, 'utf8')));
}

const report = probeRequirementStrength(specs);
const JSON_OUT = process.argv.includes('--json');

const goldFails = report.specs.flatMap((s) =>
  s.probes.filter((p) => !p.goldPasses).map((p) => `${p.specId} ${p.requirementId} ${p.assert}`),
);
const notCaught = report.specs.flatMap((s) =>
  s.probes.filter((p) => p.violatorBuilt && !p.caught).map((p) => `${p.specId} ${p.requirementId} ${p.assert}`),
);
const noViolator = report.specs.flatMap((s) =>
  s.probes.filter((p) => !p.violatorBuilt).map((p) => `${p.specId} ${p.requirementId} ${p.assert}`),
);

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('=== REQUIREMENT STRENGTH (offline, no budget) ===');
  console.log('');
  console.log(`  prompt sets: ${SETS.length} · specs: ${report.specs.length} · requirements: ${report.totalRequirements}`);
  console.log('');
  console.log('  DISCRIMINATION — every requirement must be breakable:');
  console.log(`    caught by the scorer: ${report.discriminable}/${report.totalRequirements}`);
  console.log(`    vacuous (no violating tree could be built): ${report.vacuous}`);
  console.log(`    built but NOT caught by the scorer: ${notCaught.length}`);
  if (goldFails.length) {
    console.log('');
    console.log('  THE GOLD TREE FAILS ITS OWN REQUIREMENT:');
    for (const g of goldFails) console.log(`    ${g}`);
  }
  if (notCaught.length) {
    console.log('');
    console.log('  NOT CAUGHT:');
    for (const g of notCaught) console.log(`    ${g}`);
  }
  if (noViolator.length) {
    console.log('');
    console.log('  NO VIOLATOR COULD BE BUILT (the gold tree does not contain the component):');
    for (const g of noViolator) console.log(`    ${g}`);
  }
  console.log('');
  console.log('  SKELETON — a tree with the right component NAMES and no content:');
  console.log(`    satisfies ${(report.skeletonPassRate * 100).toFixed(1)}% of the requirements`);
  const weak = report.specs
    .filter((s) => s.requirements > 0 && s.skeletonPassed / s.requirements > 0.6)
    .map((s) => `${s.specId} ${s.skeletonPassed}/${s.requirements}`);
  console.log(`    specs an empty shell satisfies >60% of (${weak.length}):`);
  console.log(`      ${weak.join('  ')}`);
  console.log('');
  console.log('  Reading: 0 vacuous requirements means the metric CAN fail, so a');
  console.log('  passing requirement is a real pass. The skeleton rate says how');
  console.log('  much of a spec is component names versus real content.');
  console.log('');
}

const failed = goldFails.length > 0 || notCaught.length > 0 || report.vacuous > 0;
if (failed) {
  console.error('requirement-strength: FAIL');
  process.exit(1);
}
console.log('requirement-strength: PASS');
