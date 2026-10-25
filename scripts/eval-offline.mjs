/**
 * Offline evaluation harness — runs compiler + APR checks against
 * gold specs without any API call or model.
 *
 * The gold spec sets are the FLOOR under every live fidelity number: if
 * the reference trees stop compiling, the live numbers describe a broken
 * compiler, not the pipeline. The two prompt sets the live harness runs
 * (dev, held-out) and the sealed held-out set are included for that
 * reason.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { getCatalog } from '../src/catalog.ts';
import { compile } from '../src/compile.ts';

const catalog = getCatalog();
const HERE = import.meta.dirname;

const SETS = [
  { file: resolve(HERE, '../fixtures/gold-specs.json'), label: 'gold specs' },
  { file: resolve(HERE, '../fixtures/live-prompts.json'), label: 'dev prompt set' },
  { file: resolve(HERE, '../fixtures/heldout-prompts.json'), label: 'held-out prompt set' },
  {
    file: resolve(HERE, '../fixtures/sealed-heldout-prompts.json'),
    label: 'sealed held-out prompt set',
  },
];

let passed = 0;
let total = 0;
let failed = 0;

for (const { file, label } of SETS) {
  let specs;
  try {
    specs = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`⏭ ${label}: not present (${e?.message ?? e})`);
    continue;
  }
  console.log(`\n=== ${label} (${specs.length} specs) ===`);
  for (const spec of specs) {
    total++;
    // A spec with NO requirements can only be scored on compile — the
    // vacuous metric the requirement scorer replaced. It must not pass
    // the gate: a spec that cannot be scored on its requirements would
    // score 0/0 and read like a perfect or a failed arm, depending on
    // who is reading.
    const reqCount = (spec.requirements ?? []).length;
    if (reqCount === 0) {
      failed++;
      console.log(
        `❌ ${spec.id}: ${spec.prompt.slice(0, 60)} — NO REQUIREMENTS ` +
          `(a spec with no requirements can only be scored on compile)`,
      );
      continue;
    }
    const result = compile(spec.goldTree, catalog);
    if (result.ok) {
      passed++;
      console.log(`✅ ${spec.id}: ${spec.prompt.slice(0, 70)} — compiles`);
    } else {
      failed++;
      console.log(
        `❌ ${spec.id}: ${spec.prompt.slice(0, 70)} — ${result.errors.map(e => e.code).join(', ')}`,
      );
    }
  }
}

console.log(
  `\nOffline compile pass rate: ${passed}/${total} (${((passed / Math.max(total, 1)) * 100).toFixed(1)}%)`,
);
process.exit(failed === 0 && total > 0 ? 0 : 1);
