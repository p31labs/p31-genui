#!/usr/bin/env node
// @p31ca/genui — compiler-level scorer for the stateful UI benchmark.
//
// The first version of this harness scored the model's raw text with string
// containment. That over-counted: any JSON that merely mentioned "Acknowledge"
// passed, even if the compiler would reject the tree outright. This scorer
// runs every output through the real compile() and evaluates the per-turn
// requirements against the *compiled* tree.
//
// State is checked cumulatively, not just once:
//   T1  StatCard == value1
//   T2  StatCard == value2
//   T3  Button label present AND StatCard still == value2
//   T4  heading == heading2 AND Button still present
//   T5  no StatCard AND heading still == heading2 AND Button still present
//
// T5 used to pass on the absence of a StatCard alone, so dropping the heading
// and the button also passed. That is fixed.
//
// Input: JSONL, one record per turn:
//   {"episode":0,"turn":1,"raw":"...","tree":{...}|null,
//    "expect":{"value1":"10,000","value2":"15,000","label":"Acknowledge",
//              "heading1":"Revenue","heading2":"Usage Overview"}}
// Produced by eval-stateful-ui.py --out outputs.jsonl
//
// Usage:
//   tsx score-stateful-ui.mjs --in outputs.jsonl
//   tsx score-stateful-ui.mjs --self-test

import { readFileSync } from 'node:fs';
import { compile } from '../src/compile.ts';
import { P31_CATALOG } from '../src/catalog.ts';

const DEFAULTS = {
  value1: '42,000',
  value2: '50,000',
  label: 'Acknowledge',
  heading1: 'Revenue',
  heading2: 'Operations Overview',
};

const TURN_DESC = {
  1: 'StatCard shows value1',
  2: 'StatCard updated to value2',
  3: "Button labelled, StatCard retained",
  4: 'heading changed, Button retained',
  5: 'StatCard removed, heading and Button retained',
};

function digits(v) {
  return String(v ?? '').replace(/[^0-9]/g, '');
}

function norm(v) {
  return String(v ?? '').trim().toLowerCase();
}

function has(node, pred) {
  if (!node || typeof node !== 'object') return false;
  if (pred(node)) return true;
  for (const c of node.children ?? []) if (has(c, pred)) return true;
  return false;
}

function requirements(rec, tree) {
  const e = { ...DEFAULTS, ...(rec.expect ?? {}) };
  const card = (v) => has(tree, (n) => n.component === 'StatCard' && digits(n.props?.value) === digits(v));
  const button = has(tree, (n) => n.component === 'Button' && norm(n.props?.label) === norm(e.label));
  const heading = has(tree, (n) =>
    Object.values(n.props ?? {}).some((v) => typeof v === 'string' && norm(v) === norm(e.heading2)),
  );

  switch (rec.turn) {
    case 1:
      return [['StatCard == value1', card(e.value1)]];
    case 2:
      return [['StatCard == value2', card(e.value2)]];
    case 3:
      return [['Button label present', button], ['StatCard retained at value2', card(e.value2)]];
    case 4:
      return [['heading == heading2', heading], ['Button retained', button]];
    case 5:
      return [
        ['StatCard removed', !has(tree, (n) => n.component === 'StatCard')],
        ['heading retained', heading],
        ['Button retained', button],
      ];
    default:
      return [['unknown turn', false]];
  }
}

function scoreRecord(rec) {
  const result = rec.tree
    ? compile(rec.tree, P31_CATALOG)
    : { ok: false, errors: [{ code: 'unparseable' }] };
  const tree = result.ok ? result.tree : null;
  const reqs = requirements(rec, tree ?? {});
  return {
    episode: rec.episode,
    turn: rec.turn,
    parsed: rec.tree !== null && rec.tree !== undefined,
    compiled: result.ok,
    errorCodes: result.ok ? [] : [...new Set(result.errors.map((e) => e.code))],
    failed: reqs.filter(([, ok]) => !ok).map(([name]) => name),
    pass: !!tree && reqs.every(([, ok]) => ok),
  };
}

function report(rows) {
  const n = rows.length;
  const parsed = rows.filter((r) => r.parsed).length;
  const compiled = rows.filter((r) => r.compiled).length;
  const passed = rows.filter((r) => r.pass).length;

  console.log('\n=== Compiler-level scoring ===');
  console.log(`records:            ${n}`);
  console.log(`episodes:           ${new Set(rows.map((r) => r.episode)).size}`);
  console.log(`parseable JSON:     ${parsed}/${n} (${pct(parsed, n)})`);
  console.log(`catalog-valid:      ${compiled}/${n} (${pct(compiled, n)})`);
  console.log(`all requirements:   ${passed}/${n} (${pct(passed, n)})`);

  console.log('\nper-turn pass vector (episodes passing / episodes run):');
  for (const t of [1, 2, 3, 4, 5]) {
    const turnRows = rows.filter((r) => r.turn === t);
    const ok = turnRows.filter((r) => r.pass).length;
    console.log(
      `  T${t}  ${String(ok).padStart(3)}/${String(turnRows.length).padEnd(3)}  ${TURN_DESC[t]}`,
    );
  }

  const misses = {};
  for (const r of rows) for (const f of r.failed) misses[f] = (misses[f] ?? 0) + 1;
  if (Object.keys(misses).length) {
    console.log('\nfailed requirements:');
    for (const [k, v] of Object.entries(misses).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(3)}x  ${k}`);
    }
  }

  const codes = {};
  for (const r of rows) for (const c of r.errorCodes) codes[c] = (codes[c] ?? 0) + 1;
  if (Object.keys(codes).length) {
    console.log(
      '\ncompile error codes:',
      Object.entries(codes)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
    );
  }
}

function pct(a, b) {
  return b === 0 ? '0.0%' : `${((100 * a) / b).toFixed(1)}%`;
}

function selfTest() {
  const E = { ...DEFAULTS };
  const stack = (children) => ({ component: 'Stack', props: {}, children });
  const card = (v) => ({ component: 'StatCard', props: { label: 'x', value: v } });
  const button = () => ({ component: 'Button', props: { label: E.label } });
  const heading = () => ({ component: 'Text', props: { content: E.heading2 } });

  const cases = [
    ['T1 correct', { episode: 0, turn: 1, tree: stack([card(E.value1)]) }, true],
    ['T1 numeric rejected', { episode: 0, turn: 1, tree: stack([card(42000)]) }, false],
    ['T1 off-schema rejected', { episode: 0, turn: 1, tree: { heading: 'x' } }, false],
    ['T2 correct', { episode: 0, turn: 2, tree: stack([card(E.value2)]) }, true],
    ['T3 button only (no card) fails', { episode: 0, turn: 3, tree: stack([button()]) }, false],
    ['T3 button + card passes', { episode: 0, turn: 3, tree: stack([card(E.value2), button()]) }, true],
    ['T4 heading only (button dropped) fails', { episode: 0, turn: 4, tree: stack([heading()]) }, false],
    ['T4 heading + button passes', { episode: 0, turn: 4, tree: stack([card(E.value2), heading(), button()]) }, true],
    ['T5 empty tree fails (heading+button dropped)', { episode: 0, turn: 5, tree: stack([card(E.value2)]) }, false],
    ['T5 keeps heading+button, no card passes', { episode: 0, turn: 5, tree: stack([heading(), button()]) }, true],
    ['T5 heading+button+card fails (card not removed)', { episode: 0, turn: 5, tree: stack([card(E.value2), heading(), button()]) }, false],
  ];

  let bad = 0;
  for (const [name, rec, want] of cases) {
    const got = scoreRecord(rec);
    const ok = got.pass === want;
    console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : ` (want pass=${want}, got ${got.pass})`}`);
    if (!ok) bad++;
  }
  console.log(`\n${cases.length - bad}/${cases.length} assertions pass`);
  process.exit(bad ? 1 : 0);
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  selfTest();
} else {
  const i = args.indexOf('--in');
  if (i === -1 || !args[i + 1]) {
    console.error('usage: score-stateful-ui.mjs --in outputs.jsonl | --self-test');
    process.exit(2);
  }
  const rows = readFileSync(args[i + 1], 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .map(scoreRecord);
  report(rows);
}
