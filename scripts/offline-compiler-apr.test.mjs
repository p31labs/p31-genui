#!/usr/bin/env node
/**
 * Offline compiler + APR harness test.
 * Runs with zero API keys. Verifies:
 *   1. All gold trees in apr-tasks.json compile against P31_CATALOG.
 *   2. The APR harness runs end-to-end with a fixture model (no network).
 *   3. Requirements are evaluated correctly.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCatalog } from '../src/catalog.ts';
import { compile } from '../src/compile.ts';
import { runAPRHarness } from '../src/apr.ts';
import { createFixtureModelFn, aprTasksFromFixture } from '../src/offline.ts';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = getCatalog();

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// 1. Load fixture tasks
const rawTasks = JSON.parse(readFileSync(resolve(PKG, 'fixtures/apr-tasks.json'), 'utf8'));
check('apr-tasks.json loads', Array.isArray(rawTasks) && rawTasks.length > 0, `count=${rawTasks?.length}`);

// 2. All gold trees compile
let goldOk = true;
for (const task of rawTasks) {
  for (const turn of task.turns) {
    const r = compile(turn.goldTree, catalog);
    if (!r.ok) {
      goldOk = false;
      console.log('  compile fail', task.id, r.errors.map(e => e.code).join(','));
    }
  }
}
check('all gold trees compile', goldOk);

// 3. Build fixture model
const fixtures = [];
for (const task of rawTasks) {
  for (const turn of task.turns) {
    fixtures.push({ prompt: turn.prompt, goldTree: turn.goldTree });
  }
}
const model = createFixtureModelFn(fixtures);

// 4. Convert tasks with string assertions → assert functions
const tasks = aprTasksFromFixture(rawTasks);

// 5. Run APR harness offline
let report;
try {
  report = await runAPRHarness(tasks, catalog, model, 'offline', 'fixture');
  check('APR harness runs offline', !!report && Array.isArray(report.results), `tasks=${report?.taskCount}`);
} catch (e) {
  check('APR harness runs offline', false, String(e?.message || e));
}

if (report) {
  check('APR task count matches', report.taskCount === rawTasks.length, `${report.taskCount} vs ${rawTasks.length}`);
  check('avg turn pass > 0', report.avgTurnPass > 0, `avgTurnPass=${report.avgTurnPass}`);
  console.log(`\n  avgTurnPass=${(report.avgTurnPass * 100).toFixed(1)}%`);
  console.log(`  episodeCompletionRate=${(report.episodeCompletionRate * 100).toFixed(1)}%`);
  console.log(`  avgAPR=${(report.avgAPR * 100).toFixed(1)}%`);
  for (const r of report.results) {
    console.log(`  ${r.taskId}: turnPass=${(r.turnPass * 100).toFixed(0)}% apr=${(r.apr * 100).toFixed(0)}% dropped=${r.dropped.length}`);
  }
}

console.log('');
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
