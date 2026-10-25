#!/usr/bin/env node
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { checkRetention, applyPatch, applyPatches } from '../src/patch.ts';
import { compile } from '../src/compile.ts';
import { getCatalog } from '../src/catalog.ts';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = getCatalog();

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const episodes = JSON.parse(readFileSync(resolve(PKG, 'fixtures/apr-episodes.json'), 'utf8'));
check('episodes file non-empty', Array.isArray(episodes) && episodes.length >= 5, `count=${episodes?.length}`);

const report = checkRetention(episodes);
check('retention checker runs', !!report && Array.isArray(report.episodes));
check('all episodes retained', report.ok, JSON.stringify(report.episodes.map(e => ({ id: e.episodeId, ok: e.ok }))));

let goldOk = true;
for (const ep of episodes) {
  for (const t of ep.turns) {
    const r = compile(t.goldTree, catalog);
    if (!r.ok) { goldOk = false; console.log('  compile fail', ep.id, r.errors.map(e=>e.code).join(',')); }
  }
}
check('all gold trees compile', goldOk);

let patchedCompileOk = true;
for (const ep of episodes) {
  let cur = ep.initialTree;
  for (const t of ep.turns) {
    try {
      const p = t.expectedPatch;
      const out = Array.isArray(p) ? applyPatches(cur, p) : (p == null ? t.goldTree : applyPatch(cur, p));
      const r = compile(out, catalog);
      if (!r.ok) { patchedCompileOk = false; console.log('  patched compile fail', ep.id, r.errors.map(e=>e.code).join(',')); }
      cur = out;
    } catch (e) {
      patchedCompileOk = false;
      console.log('  apply fail', ep.id, String(e?.message || e));
    }
  }
}
check('all patched trees compile', patchedCompileOk);

const { evalRequirements } = await import('../src/requirements.ts');
const sampleTree = episodes[0].turns[0].goldTree;
const tally = evalRequirements(sampleTree, episodes[0].turns[0].requirements);
check('gold satisfies its requirements', tally.allPassed, `failed=${tally.failedIds.join(',')}`);

console.log('');
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);