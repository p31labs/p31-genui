#!/usr/bin/env node
/**
 * Requirement-set verifier — the contract test for the fidelity metric.
 *
 * A scorer that cannot fail is worse than no scorer (that is the whole
 * point of the fix-plan this belongs to). Three properties are checked:
 *
 *   1. EVERY requirement parses. An unparseable assertion is a HARD FAIL
 *      at scoring time, so a typo in a fixture would silently fail every
 *      spec that carries it.
 *   2. EVERY requirement PASSES against its own gold tree. A requirement
 *      the reference answer fails is a requirement that is wrong — it
 *      would measure the pipeline against a spec that no tree can satisfy.
 *   3. Every spec has at least one requirement. A spec with no
 *      requirements is a spec that can only be scored on compile, which is
 *      the vacuous metric this replaced.
 *
 * Usage:
 *   node packages/genui/scripts/verify-requirements.mjs \
 *     --in=packages/genui/fixtures/live-prompts.json \
 *     --in=packages/genui/fixtures/heldout-prompts.json
 *
 * Exit 0 = all three properties hold. Exit 1 = at least one does not.
 */
import { readFileSync } from 'fs';
import { parseAssert, evalRequirements } from '../src/requirements.ts';

const args = process.argv.slice(2);
const inputs = args
  .filter((a) => a.startsWith('--in='))
  .map((a) => a.slice('--in='.length));

if (inputs.length === 0) {
  console.error('usage: node verify-requirements.mjs --in=<prompt-set.json> [...]');
  process.exit(2);
}

let failures = 0;
let specCount = 0;
let requirementCount = 0;

for (const file of inputs) {
  const specs = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`\n=== ${file} (${specs.length} specs) ===`);
  for (const spec of specs) {
    specCount++;
    const reqs = spec.requirements ?? [];
    if (reqs.length === 0) {
      console.error(`  ✗ ${spec.id}: NO REQUIREMENTS — the spec can only be scored on compile`);
      failures++;
      continue;
    }
    requirementCount += reqs.length;

    for (const r of reqs) {
      const parsed = parseAssert(r.assert);
      if (parsed.kind === 'unknown') {
        console.error(`  ✗ ${spec.id} ${r.id}: UNPARSEABLE assertion "${r.assert}"`);
        failures++;
      }
    }

    const tally = evalRequirements(spec.goldTree, reqs);
    if (!tally.allPassed) {
      for (const o of tally.outcomes.filter((x) => !x.passed)) {
        console.error(
          `  ✗ ${spec.id} ${o.id}: "${o.assert}" FAILS on its own gold tree (${o.detail})`,
        );
      }
      failures++;
    } else {
      console.log(
        `  ✓ ${spec.id}: ${reqs.length} requirements, all satisfied by the gold tree`,
      );
    }
  }
}

console.log(
  `\n${specCount} specs · ${requirementCount} requirements · ${failures} failure(s)`,
);
if (failures > 0) {
  console.error('❌ requirement set is NOT sound');
  process.exit(1);
}
console.log('✅ requirement set is sound: every assertion parses and every gold tree satisfies it');

// --- negative controls ----------------------------------------------------
// A checker that cannot fail is the thing this whole work exists to stop.
// So the checker is checked: each of its three rules must REJECT a
// deliberately broken input. If a control passes, the rule is dead and
// this row would go green over a broken requirement set.
console.log('\n=== NEGATIVE CONTROLS (each must be REJECTED) ===');
const controlFailures = [];

const control = (label, spec, expectFailure) => {
  const reqs = spec.requirements ?? [];
  let failed = false;
  if (reqs.length === 0) failed = true;
  for (const r of reqs) {
    if (parseAssert(r.assert).kind === 'unknown') failed = true;
  }
  if (!failed) {
    const tally = evalRequirements(spec.goldTree, reqs);
    if (!tally.allPassed) failed = true;
  }
  const ok = failed === expectFailure;
  if (!ok) controlFailures.push(label);
  console.log(
    `${ok ? '  ✓' : '  ✗'} ${label} — ${failed ? 'rejected' : 'accepted'}` +
      (ok ? '' : ' (the control did not behave as expected)'),
  );
};

const goodTree = { component: 'Badge', props: { label: 'Active' }, children: [] };
control(
  'a spec with NO requirements is rejected',
  { id: 'CTRL1', prompt: 'x', goldTree: goodTree, requirements: [] },
  true,
);
control(
  'an UNPARSEABLE assertion is rejected',
  {
    id: 'CTRL2',
    prompt: 'x',
    goldTree: goodTree,
    requirements: [{ id: 'R1', assert: 'hasSomething:whatever' }],
  },
  true,
);
control(
  'a requirement the gold tree does NOT satisfy is rejected',
  {
    id: 'CTRL3',
    prompt: 'x',
    goldTree: goodTree,
    requirements: [{ id: 'R1', assert: 'hasComponent:StatCard' }],
  },
  true,
);
control(
  'a sound spec is accepted (the rule still works)',
  {
    id: 'CTRL4',
    prompt: 'x',
    goldTree: goodTree,
    requirements: [{ id: 'R1', assert: 'hasComponent:Badge' }],
  },
  false,
);

if (controlFailures.length > 0) {
  console.error(
    `\n❌ the checker's own controls failed: ${controlFailures.join('; ')} — ` +
      'this row could not have caught a broken requirement set',
  );
  process.exit(1);
}
console.log('\n✅ the checker rejects what it must, and accepts what it must');
