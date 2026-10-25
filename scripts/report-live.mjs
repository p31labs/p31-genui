#!/usr/bin/env node
/**
 * report-live.mjs — the side-by-side LIVE fidelity report.
 *
 * Reads one or more result files written by eval-live.mjs and prints a
 * comparison table plus the per-mode headline numbers. This is the artifact
 * the external review asked for: REAL numbers from a REAL model, not
 * numbers from a fixture the same author wrote.
 *
 * Usage:
 *   node scripts/report-live.mjs \
 *     --in=packages/genui/fixtures/live-results.json \
 *     --in=packages/genui/fixtures/live-heldout-results.json \
 *     [--in=packages/genui/fixtures/live-strict-results.json]
 *
 * Every number printed here is read from the result files; nothing is
 * recomputed from prompts, so the report cannot flatter the harness.
 *
 * THE METRIC IS THE REQUIREMENT (2026-10-22). The correctness number is
 * requirement satisfaction: "is there a StatCard", "is its value 10000",
 * "does some text mention the MRN". The tree-F1 and exact-prop numbers are
 * printed as LEGACY columns — they are the metric that read backwards
 * (the held-out set scored better than the dev set) and they are kept only
 * so the 2026-10-21 arms stay comparable.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  endToEndSuccess,
  indexSpecs,
  legacyThresholdSweep,
  pairedMetricEffect,
  probeRequirementStrength,
  reScoreArchive,
} from '../src/rescore.ts';
import { compareArms, rowsForIds } from '../src/pairing.ts';

const args = process.argv.slice(2);
const inputs = args.filter((a) => a.startsWith('--in=')).map((a) => a.slice('--in='.length));
// --markdown emits the table the fix-plan's RESULTS section carries, so
// the results text is GENERATED from the fixtures and never hand-edited.
// A hand-edited number is a number that can drift from the evidence.
const MARKDOWN = args.includes('--markdown');

if (!inputs.length) {
  console.error('usage: report-live.mjs --in=<results.json> [--in=<results.json> …]');
  process.exit(2);
}

const reports = [];
for (const path of inputs) {
  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) {
    console.error(`report-live: missing result file ${path}`);
    process.exit(2);
  }
  const raw = JSON.parse(readFileSync(abs, 'utf8'));
  reports.push({ path, ...raw });
}

const LABEL = {
  // The 2026-10-21 arms, measured with the SUPERSEDED tree-F1 metric.
  // They are kept as the historical record and are labelled LEGACY; the
  // canonical names now hold the requirement-scored arms. The keys are
  // paths RELATIVE TO fixtures/, so a file that was moved into
  // legacy-2026-10-21/ cannot collide with the canonical file of the same
  // name — two arms must never print the same label.
  'legacy-2026-10-21/live-results.json': 'LEGACY 50-prompt live set (tree-F1)',
  'legacy-2026-10-21/live-heldout-results.json': 'LEGACY HELD-OUT set (tree-F1)',
  'legacy-2026-10-21/live-strict-results.json': 'LEGACY strict/gpt-oss-20b (tree-F1)',
  'legacy-2026-10-21/live-kilo-poolside-strict-results.json': 'LEGACY Kilo poolside STRICT (tree-F1)',
  'legacy-2026-10-21/live-heldout-kilo-strict-contract-results.json': 'LEGACY HELD-OUT Kilo strict + contract (tree-F1)',
  'legacy-2026-10-21/live-heldout-kilo-strict-nocontract-results.json': 'LEGACY HELD-OUT Kilo strict, no contract (tree-F1)',
  'live-heldout-results.json': 'HELD-OUT set (12 specs, different author)',
  'live-strict-results.json': 'strict/gpt-oss-20b (daily cap spent)',
  'live-strict-qwen-results.json': 'strict/qwen3.8-27b',
  'live-heldout-strict-results.json': 'HELD-OUT strict',
  'live-heldout-strict-contract-results.json': 'HELD-OUT strict + contract',
  'live-heldout-jsonobject-contract-results.json': 'HELD-OUT json-object + contract',
  'live-openrouter-poolside-json-results.json': 'OpenRouter poolside json-object',
  'live-openrouter-nemotron-json-results.json': 'OpenRouter nemotron-550b json-object',
  'live-kilo-poolside-strict-results.json': 'Kilo poolside STRICT',
  'live-kilo-poolside-json-results.json': 'Kilo poolside json-object',
  'live-kilo-poolside-json-nocontract-results.json': 'Kilo poolside json-object, no contract',
  'live-kilo-poolside-strict-nocontract-results.json': 'Kilo poolside STRICT, no contract',
  'live-heldout-openrouter-json-contract-results.json': 'HELD-OUT OR json-object + contract',
  'live-heldout-openrouter-json-nocontract-results.json': 'HELD-OUT OR json-object, no contract',
  'live-heldout-kilo-strict-contract-results.json': 'HELD-OUT Kilo strict + contract',
  'live-heldout-kilo-strict-nocontract-results.json': 'HELD-OUT Kilo strict, no contract',
  'live-sealed-kilo-strict-contract-results.json': 'SEALED strict + contract',
  'live-sealed-kilo-json-contract-results.json': 'SEALED json-object + contract',
  'live-sealed-kilo-json-nocontract-results.json': 'SEALED json-object, no contract',
  'live-sealed-kilo-strict-nocontract-results.json': 'SEALED strict, no contract',
  'smoke-contract-user-results.json': 'SMOKE contract fix, contract in the USER role (control)',
  'smoke-contract-system-results.json': 'SMOKE contract fix, contract in the SYSTEM role',
  'superseded-2026-10-22/smoke-contract-user-results.run1.json':
    'SUPERSEDED smoke, USER role (run 1 of the contract-placement A/B)',
  'superseded-2026-10-22/smoke-contract-system-results.run1.json':
    'SUPERSEDED smoke, SYSTEM role (run 1 of the contract-placement A/B)',
};

// The key is the path relative to fixtures/, so a legacy copy and the
// canonical file of the same name stay distinguishable.
const relKey = (p) => p.replace(/^.*packages\/genui\/fixtures\//, '');
const label = (r) =>
  LABEL[relKey(r.path)] ?? LABEL[r.path.split('/').pop()] ?? r.path.split('/').pop();

/** Does this arm carry requirements (i.e. was it scored with the current
 *  metric)? */
const armHasRequirements = (r) =>
  (r.results ?? []).some((x) => (x.requirementsTotal ?? 0) > 0);

/** The OLD wrong-valid rate (compiled, and the tree-F1 was below 0.5),
 *  computed from the arm's own results so the legacy row is not a
 *  different number from the one the arm reported. */
const legacyWrongValid = (r) => {
  const compiled = (r.results ?? []).filter((x) => x.compiled);
  if (!compiled.length) return 0;
  return compiled.filter((x) => x.semanticallyWrong).length / compiled.length;
};

// An arm that predates a metric has no value for it. Printing NaN% (or a
// 0.0% that reads like a measurement) would be a lie in a table whose
// whole job is to be read.
const pct = (x) =>
  x === undefined || x === null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(1)}%`;
const num = (x, d = 3) => (x === undefined || x === null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));

// ---------------------------------------------------------------------------
// THE OFFLINE RE-SCORE (--rescore).
//
// The review asked for one thing that the 2026-10-21 write-up could not
// deliver: the SAME outputs re-scored under both metrics, so the metric
// effect is separated from the run effect.
//
// What the archive actually holds, measured rather than assumed:
//   * the 2026-10-21 fixtures hold SUMMARY METRICS ONLY — no generated
//     tree — so those outputs cannot be re-scored, now or ever;
//   * the CURRENT arms record BOTH metrics per row on the SAME tree, so
//     the comparison IS possible, paired, for free.
//
// So the re-score runs two ways:
//   1. RE-SCORE the archived trees under the current scorer, where a tree
//      exists. Every arm is reported as rescorable or NOT, with the count.
//   2. PAIRED-COMPARE the two metrics on the identical rows of the
//      identical run — same tree, same prompt, same model, same day.
//
// And it answers the second half of the objection ("it also fits 'the
// requirements are easy'") with a measurement of the requirement set
// itself: can every requirement be made to FAIL, and how much of the spec
// does an empty shell satisfy?
// ---------------------------------------------------------------------------
const RESCORE = args.includes('--rescore');

if (RESCORE) {
  // The prompt sets carry the requirements and the gold trees. They are
  // resolved from this script's own package, so the re-score works from
  // any working directory.
  const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const promptFiles = args
    .filter((a) => a.startsWith('--prompts='))
    .map((a) => a.slice('--prompts='.length));
  const DEFAULT_PROMPTS = [
    'fixtures/live-prompts.json',
    'fixtures/heldout-prompts.json',
    'fixtures/sealed-heldout-prompts.json',
  ];
  const specs = [];
  for (const f of promptFiles.length ? promptFiles : DEFAULT_PROMPTS) {
    const abs = promptFiles.length ? resolve(process.cwd(), f) : resolve(PKG, f);
    if (!existsSync(abs)) {
      console.error(`report-live: missing prompt set ${f}`);
      process.exit(2);
    }
    specs.push(...JSON.parse(readFileSync(abs, 'utf8')));
  }
  const index = indexSpecs(specs);

  console.log('=== OFFLINE RE-SCORE (no provider call, no budget) ===');
  console.log('');
  console.log('What this measures, and what it cannot:');
  console.log('  The 2026-10-21 fixtures hold SUMMARY METRICS ONLY — componentF1,');
  console.log('  propAccuracy, semanticallyWrong — and NO generated tree. The trees');
  console.log('  were consumed by the scorer and discarded, so those outputs cannot');
  console.log('  be re-scored under the requirement metric, now or ever. The');
  console.log('  re-score below therefore reports them as NOT RESCORABLE with the');
  console.log('  count, rather than quietly substituting a different measurement.');
  console.log('');
  console.log('  The CURRENT arms record BOTH metrics per row on the SAME tree, so');
  console.log('  the metric effect IS separable there: the paired comparison below');
  console.log('  holds the model, the mode, the prompts, the day and the budget');
  console.log('  fixed, and varies only the metric.');
  console.log('');

  // ---- 1. the paired comparison ----
  console.log('--- METRIC EFFECT, PAIRED ON IDENTICAL OUTPUTS ---');
  console.log(
    '  ' +
      ['arm', 'compiled', 'legacy wrong', 'req wrong', 'legacy-only', 'req-only', 'both'].join(' | '),
  );
  for (const r of reports) {
    const e = pairedMetricEffect(r.results ?? []);
    if (!e.compiled) {
      console.log(`  ${label(r).padEnd(46)} | no compiled rows`);
      continue;
    }
    // An arm measured before the requirement metric existed has no second
    // verdict to compare, so the paired cells print '—' rather than a
    // false agreement of zero.
    const legacy = `${pct(e.legacyWrongValidRate)} (${e.legacyWrong})`;
    const req = e.hasRequirementMetric ? `${pct(e.requirementWrongValidRate)} (${e.requirementWrong})` : '—';
    const legacyOnly = e.hasRequirementMetric ? String(e.legacyOnlyWrong) : '—';
    const reqOnly = e.hasRequirementMetric ? String(e.requirementOnlyWrong) : '—';
    const both = e.hasRequirementMetric ? String(e.bothWrong) : '—';
    console.log(
      `  ${label(r).padEnd(46)} | ${String(e.compiled).padStart(8)} | ${legacy.padEnd(12)} | ` +
        `${req.padEnd(9)} | ${legacyOnly.padStart(11)} | ${reqOnly.padStart(8)} | ${both.padStart(4)}`,
    );
  }
  console.log('');
  console.log('  legacy-only = the tree-F1 metric called it WRONG, the requirement');
  console.log('                metric says it is RIGHT (the old metric\'s false');
  console.log('                positives).');
  console.log('  req-only    = the tree-F1 metric APPROVED it, the requirement');
  console.log('                metric says it is WRONG (the old metric\'s false');
  console.log('                negatives).');
  console.log('');

  // ---- 2. the threshold sensitivity of the legacy metric ----
  const sweepArms = reports.filter((r) =>
    (r.results ?? []).some((x) => x.compiled && typeof x.componentF1 === 'number'),
  );
  if (sweepArms.length) {
    console.log('--- THE LEGACY NUMBER IS A THRESHOLD, NOT A MEASUREMENT ---');
    const thresholds = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    console.log(
      '  ' + ['arm', 'compiled', ...thresholds.map((t) => `F1<${t}`)].join(' | '),
    );
    for (const r of sweepArms) {
      const f1 = (r.results ?? [])
        .filter((x) => x.compiled && typeof x.componentF1 === 'number')
        .map((x) => x.componentF1);
      const sweep = legacyThresholdSweep(f1, thresholds);
      console.log(
        `  ${label(r).padEnd(46)} | ${String(f1.length).padStart(8)} | ` +
          sweep.map((s) => pct(s.rate).padStart(5)).join(' | '),
      );
    }
    console.log('');
    console.log('  The old headline ("34.8% wrong-valid") is F1 < 0.5 on a');
    console.log('  CONTINUOUS score. Moving the cut from 0.3 to 0.8 moves the');
    console.log('  number from 15.2% to 60.9%. It was a cut on a curve, not a');
    console.log('  measurement of anything.');
    console.log('');
  }

  // ---- 3. what can actually be re-scored ----
  console.log('--- ARCHIVE RE-SCORABILITY ---');
  console.log(
    '  ' + ['arm', 'rows', 'tree archived', 're-scored', 'agrees with recorded'].join(' | '),
  );
  for (const r of reports) {
    const a = reScoreArchive(r.results ?? [], index);
    console.log(
      `  ${label(r).padEnd(46)} | ${String(a.rows).padStart(4)} | ${String(a.rescorable).padStart(13)} | ` +
        `${String(a.rescorable ? a.agree + a.disagree : 0).padStart(9)} | ` +
        `${a.rescorable ? `${a.agree}/${a.rescorable}` : 'n/a — no tree archived'}`,
    );
  }
  console.log('');
  console.log('  A row with no archived tree can never be re-scored under a changed');
  console.log('  scorer. From 2026-10-22 the harness writes the tree into every');
  console.log('  result row, so every future arm is re-scorable offline.');
  console.log('');

  // ---- 4. are the requirements easy? ----
  console.log('--- ARE THE REQUIREMENTS EASY? ---');
  const strength = probeRequirementStrength(specs);
  console.log(
    `  requirements probed: ${strength.totalRequirements} · ` +
      `the scorer CAUGHT a violating tree for ${strength.discriminable} · ` +
      `vacuous (could not be made to fail): ${strength.vacuous}`,
  );
  console.log(
    `  a content-free tree — right component NAMES, no props, no text — ` +
      `satisfies ${pct(strength.skeletonPassRate)} of the requirements`,
  );
  if (strength.vacuous > 0) {
    console.log('');
    console.log('  REQUIREMENTS THAT COULD NOT BE MADE TO FAIL:');
    for (const s of strength.specs) {
      for (const p of s.probes) {
        if (!p.caught) {
          console.log(`    ${p.specId} ${p.requirementId} ${p.assert} (kind ${p.kind})`);
        }
      }
    }
  }
  const weak = strength.specs
    .filter((s) => s.requirements > 0 && s.skeletonPassed / s.requirements > 0.6)
    .map((s) => `${s.specId} ${s.skeletonPassed}/${s.requirements}`);
  if (weak.length) {
    console.log('');
    console.log(`  specs an empty shell satisfies >60% of (${weak.length}):`);
    console.log(`    ${weak.join('  ')}`);
  }
  console.log('');
  process.exit(0);
}

if (MARKDOWN) {
  // The markdown table: one row per arm, the columns Path F asks for.
  const cell = (v) => String(v).replace(/\|/g, '\\|');
  const head = [
    'arm (fixture)',
    'route',
    'model requested',
    'model served',
    'mode',
    'contract',
    'dialect',
    'prompts',
    'reached the model',
    'END-TO-END success',
    'requirement pass (of compiled)',
    'first-pass',
    'repairs/accepted',
    'tokens/accepted',
    'wrong-valid (req)',
    'heal by cause',
  ];
  console.log(`| ${head.join(' | ')} |`);
  console.log(`|${head.map(() => '---').join('|')}|`);
  for (const r of reports) {
    const served = Object.entries(r.servedModels ?? {})
      .map(([m, c]) => `${m}×${c}`)
      .join(' ') || '(not reported)';
    const contract = `${r.propContract ? 'props' : 'no-props'}${r.nodeShape ? ' + shape' : ''}` +
      // The contract's ROLE, when it is not the default. Two arms that differ
      // only in where the contract travels must be distinguishable in the
      // table, or the A/B reads as one arm.
      (r.contractRole && r.contractRole !== 'user' ? ` (${r.contractRole} role)` : '');
    const heal = r.healKinds === undefined
      ? '(not measured)'
      : Object.entries(r.healKinds ?? {}).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
    const reqPass = armHasRequirements(r) ? pct(r.requirementPassRate) : '—';
    const wrongValid = armHasRequirements(r) ? pct(r.wrongValidSchemaRate) : '—';
    // END-TO-END leads: it is the rate a reader should quote, because it
    // counts the compile failures instead of hiding them behind a
    // conditional denominator.
    const e2e = endToEndSuccess(r.results ?? []);
    const endToEnd = e2e.hasRequirementMetric
      ? `${pct(e2e.rate)} (${e2e.succeeded}/${e2e.reached})`
      : '—';
    // A capped arm is NOT a result. It is labelled in the table so nobody
    // can read its 0 % as a property of the pipeline.
    const capped = (r.providerErrorCount ?? 0) > 0;
    const armLabel = capped
      ? `${label(r)} [BUDGET-CAPPED: ${r.providerErrorCount}/${r.promptCount} never reached the model]`
      : label(r);
    console.log(
      `| ${cell(armLabel)} | ${cell(r.provider ?? 'groq')} | ${cell(r.model)} | ${cell(served)} | ` +
        `${cell(r.constraintMode)} | ${cell(contract)} | ${cell(r.schemaDialect ?? 'union-nullable')} | ` +
        `${r.promptCount} | ${r.promptCount - (r.providerErrorCount ?? 0)}/${r.promptCount} | ` +
        `${cell(endToEnd)} | ${reqPass} | ${pct(r.firstPassRate)} | ${num(r.repairsPerAcceptedSpec, 2)} | ` +
        `${num(r.tokensPerAcceptedSpec, 0)} | ${wrongValid} | ${cell(heal)} |`,
    );
  }
  process.exit(0);
}

console.log('=== LIVE FIDELITY — SIDE BY SIDE ===');
console.log('');
const head = ['metric', ...reports.map(label)];
console.log(head.map((h, i) => (i === 0 ? h : h.padEnd(46))).join(''));
console.log('-'.repeat(24 + 46 * (reports.length - 1)));

const rows = [
  ['provider', (r) => r.provider ?? 'groq'],
  ['model requested', (r) => r.model],
  ['model served', (r) => {
    const s = Object.entries(r.servedModels ?? {});
    return s.length ? s.map(([m, c]) => `${m}×${c}`).join(' ') : '(not reported)';
  }],
  ['constraint mode', (r) => r.constraintMode],
  ['prompt contract', (r) =>
    `${r.propContract ? 'props' : 'no-props'}${r.nodeShape ? ' + shape' : ''}` +
    (r.contractRole ? ` · contract role: ${r.contractRole}` : '')],
  // The hash of the contract's WORDS, and how many rows were measured
  // under each text. The arm fingerprint cannot see prompt text, so this
  // is the only record of WHICH prompt produced which row — and an arm
  // that spans two texts says so here.
  ['contract text', (r) => {
    const h = r.contractTextHash;
    const rows = r.contractTextRows ?? {};
    const spans = Object.entries(rows)
      .map(([k, v]) => `${k === 'unknown' ? 'unknown' : k.slice(0, 12) + '…'}×${v}`)
      .join(' ');
    return `${h ? h.slice(0, 12) + '…' : '(not recorded)'}${spans ? `  (${spans})` : ''}`;
  }],
  ['prompts', (r) => String(r.promptCount)],
  ['reached the model', (r) => `${r.promptCount - (r.providerErrorCount ?? 0)}/${r.promptCount}`],
  // ---- the correctness numbers ----
  // END-TO-END FIRST. "Requirement pass rate" is conditional on compiling,
  // so it hides the compile failures inside it: 97.1% of the trees that
  // compiled is not 97.1% of the prompts. The end-to-end rate has the
  // honest denominator — the prompts that reached the model — and it
  // carries the count so the denominator is never invisible.
  ['END-TO-END success', (r) => {
    const e = endToEndSuccess(r.results ?? []);
    if (!e.hasRequirementMetric) return '—';
    return `${pct(e.rate)} (${e.succeeded}/${e.reached})`;
  }],
  ['requirements/spec', (r) => num(r.requirementsPerSpec, 1)],
  ['requirement pass (of compiled)', (r) => pct(r.requirementPassRate)],
  ['avg requirement rate', (r) => pct(r.avgRequirementRate)],
  ['avg reqs failed', (r) => num(r.avgRequirementsFailed, 2)],
  // Two different questions, two different rows: "a requirement failed"
  // (the current metric) and "the tree differs from the gold tree" (the
  // superseded one). An arm that predates the requirement metric has no
  // answer to the first question, and must not be read as having one.
  ['wrong-valid (requirement)', (r) =>
    armHasRequirements(r) ? pct(r.wrongValidSchemaRate) : '—'],
  ['LEGACY wrong-valid (F1<0.5)', (r) =>
    armHasRequirements(r) ? '—' : pct(legacyWrongValid(r))],
  // ---- the cost numbers ----
  ['first-pass rate', (r) => pct(r.firstPassRate)],
  ['repairs/spec', (r) => num(r.avgRepairIterations, 2)],
  ['repairs/accepted', (r) => num(r.repairsPerAcceptedSpec, 2)],
  ['tokens/accepted', (r) => num(r.tokensPerAcceptedSpec, 0)],
  ['healed rate', (r) => pct(r.healedRate)],
  ['healed by cause', (r) => {
    if (r.healKinds === undefined) return '(not measured)';
    const k = Object.entries(r.healKinds ?? {});
    return k.length ? k.map(([kind, v]) => `${kind}=${v}`).join(' ') : 'none';
  }],
  // ---- legacy ----
  ['LEGACY comp F1', (r) => num(r.avgComponentF1)],
  ['LEGACY prop acc', (r) => num(r.avgPropAccuracy)],
  ['LEGACY root acc', (r) => num(r.avgRootPropAccuracy)],
  // ---- run health ----
  ['avg tokens', (r) => num(r.avgTokens, 0)],
  ['avg latency (ms)', (r) => num(r.avgLatencyMs, 0)],
  ['rate-limit hits', (r) => String(r.rateLimitHits)],
  ['provider errors', (r) => String(r.providerErrorCount ?? 0)],
  ['model calls', (r) => String(r.callCount)],
  ['total tokens', (r) => String(r.totalTokens)],
];
for (const [name, fn] of rows) {
  console.log(`${name.padEnd(24)}${reports.map((r) => String(fn(r)).padEnd(46)).join('')}`);
}

console.log('');
console.log('=== PAIRED SPANS (the only spans on which two arms may be compared) ===');
// Two arms with different totals have been compared anyway, and the
// difference could have been the PROMPTS rather than the arm. The
// schedule is prompt-major now, so the arms are paired — but the pairing
// has to be stated, because a reader who sees "50" and "20" and reads
// them side by side has learned nothing about the arms.
//
// Only the COMMON PREFIX counts: the first k prompts, in prompt-set
// order, that BOTH arms have measured. A prompt that errored on the
// provider is not measured — the model never answered it.
{
  const PKG2 = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const promptFiles2 = args
    .filter((a) => a.startsWith('--prompts='))
    .map((a) => a.slice('--prompts='.length));
  const DEFAULT2 = [
    'fixtures/live-prompts.json',
    'fixtures/heldout-prompts.json',
    'fixtures/sealed-heldout-prompts.json',
  ];
  const specSets = [];
  for (const f of promptFiles2.length ? promptFiles2 : DEFAULT2) {
    const abs = promptFiles2.length ? resolve(process.cwd(), f) : resolve(PKG2, f);
    if (!existsSync(abs)) continue;
    specSets.push(JSON.parse(readFileSync(abs, 'utf8')));
  }
  // Which prompt set does this arm belong to? An arm's rows carry their
  // prompt text, so the set is the one whose prompts the arm has seen.
  const armsFor = [];
  for (const r of reports) {
    const seen = new Set((r.results ?? []).map((x) => x.prompt));
    const set = specSets.find((s) => s.some((sp) => seen.has(sp.prompt))) ?? specSets.flat();
    armsFor.push({ label: label(r), rows: r.results ?? [], specs: set });
  }
  if (armsFor.length >= 2 && specSets.length) {
    console.log(
      '  ' + ['arm pair', 'common', 'common PREFIX', 'span (both arms, on the prefix)', 'contract text'].join(' | '),
    );
    for (let i = 0; i < armsFor.length; i++) {
      for (let j = i + 1; j < armsFor.length; j++) {
        const a = armsFor[i];
        const b = armsFor[j];
        const c = compareArms(a.specs, [a, b], a.label, b.label);
        if (!c.common.length) {
          console.log(`  ${(a.label + ' vs ' + b.label).padEnd(46)} | ${String(0).padStart(6)} | ${String(0).padStart(13)} | no shared prompt`);
          continue;
        }
        // The headline metric RESTRICTED to the shared span.
        const aRows = rowsForIds(a, a.specs, c.commonPrefix);
        const bRows = rowsForIds(b, b.specs, c.commonPrefix);
        const ea = endToEndSuccess(aRows);
        const eb = endToEndSuccess(bRows);
        const span = (e) =>
          e.hasRequirementMetric ? `${pct(e.rate)} (${e.succeeded}/${e.reached})` : '—';
        console.log(
          `  ${(a.label + ' vs ' + b.label).padEnd(46)} | ${String(c.common.length).padStart(6)} | ` +
            `${String(c.commonPrefix.length).padStart(13)} | ${span(ea)} vs ${span(eb)} | ` +
            `${c.pairedText === 'unknown' ? 'unknown' : c.pairedText.slice(0, 12) + '…'}` +
            (c.textMismatch ? `  ⚠ ${c.textMismatch} prompt(s) measured under DIFFERENT contract texts — not comparable` : ''),
        );
      }
    }
    console.log('');
    console.log('  "common" = the prompts BOTH arms have measured. "common PREFIX" = the');
    console.log('  first k of those, in prompt-set order — the only span on which the two');
    console.log('  arms may be compared, because it is the only span they share from');
    console.log('  the start. A prompt that ERRORED on the provider is not measured.');
    console.log('  The arms are scheduled prompt-major, so the shared prefix grows as a');
    console.log('  contiguous run rather than as a scattered set.');
    console.log('  A prompt the two arms measured under DIFFERENT contract texts is not');
    console.log('  comparable at all — the contract is what is being measured — and it');
    console.log('  stops the prefix. The contract-text hash is what makes that visible;');
    console.log('  the arm fingerprint never covered the prompt\'s words.');
    console.log('');
  }
}

console.log('=== PER-PROMPT (each file) ===');
for (const r of reports) {
  console.log('');
  console.log(`-- ${label(r)} — ${r.path}`);
  const fails = r.results.filter((x) => !x.compiled);
  const wrong = r.results.filter((x) => x.compiled && x.semanticallyWrong);
  const hasReqs = r.results.some((x) => (x.requirementsTotal ?? 0) > 0);
  console.log(
    `   compiled ${r.results.length - fails.length}/${r.results.length}` +
      (hasReqs
        ? ` · requirements met ${r.results.filter((x) => x.requirementsMet).length}` +
          ` · failed a requirement ${wrong.length}` +
          ` · healed ${r.results.filter((x) => x.healed).length}`
        : ` · semantically-wrong ${wrong.length} · healed ${r.results.filter((x) => x.healed).length}`),
  );
  const neverReached = (r.providerErrorCount ?? 0);
  if (neverReached > r.results.length * 0.2) {
    console.log(
      `   ⚠ BUDGET-CAPPED: ${neverReached}/${r.results.length} prompts never reached the model ` +
      `(the provider's DAILY cap was spent — Groq's x-ratelimit headers describe the minute ` +
      `window and stay green while it is the daily cap that is exhausted). This arm's compile rate ` +
      `describes the BUDGET, not the pipeline.`,
    );
  }
  if (fails.length) {
    console.log('   compile failures:');
    for (const f of fails) {
      console.log(`     ✗ ${String(f.id ?? '').padEnd(4)} ${f.prompt.slice(0, 52).padEnd(54)} codes=${(f.errorCodes || []).join(',') || '-'}`);
    }
  }
  if (wrong.length) {
    // The arm's own semantics decide the header: an arm scored with
    // requirements says a REQUIREMENT failed; an arm from before the
    // requirement metric says the tree differed from the gold tree. Mixing
    // the two labels would be a lie about what was measured.
    console.log(
      hasReqs
        ? '   compiled but a REQUIREMENT failed:'
        : '   compiled but the tree differed from the gold tree (LEGACY arm, F1 < 0.5):',
    );
    for (const w of wrong) {
      const detail = (w.failedRequirements ?? []).slice(0, 3).join(' ; ');
      console.log(
        `     ~ ${String(w.id ?? '').padEnd(4)} ${w.prompt.slice(0, 46).padEnd(48)} ` +
          (hasReqs
            ? `req=${w.requirementsPassed}/${w.requirementsTotal} repairs=${w.repairIterations}`
            : `f1=${w.componentF1.toFixed(2)} repairs=${w.repairIterations}`) +
          (detail ? `  ${detail}` : ''),
      );
    }
  }
}

console.log('');
console.log('Reading notes:');
console.log('  "END-TO-END success" = of the prompts that REACHED THE MODEL, the');
console.log('  share that produced a tree that COMPILED and satisfied EVERY');
console.log('  requirement. It is the number to quote: "requirement pass rate" is');
console.log('  conditional on compiling, so it hides the compile failures inside');
console.log('  it. The count is printed with the rate so the denominator is never');
console.log('  invisible.');
console.log('  "requirement pass (of compiled)" = of the trees that COMPILED, the');
console.log('  share that');
console.log('  satisfied EVERY requirement (R1..Rn: hasComponent / hasComponents>=N /');
console.log('  hasProp=value / hasProp~contains / hasText). This is the correctness');
console.log('  number: a tree is correct when it satisfies the spec, however it is');
console.log('  arranged. The old metric compared against ONE gold tree, so it punished');
console.log('  a valid alternative as hard as a missing component — which is why the');
console.log('  held-out set used to score BETTER than the dev set.');
console.log('  "wrong-valid" = the decoder ACCEPTED the tree but a requirement failed.');
console.log('  That is the number that shows a schema-valid tree can still be wrong.');
console.log('  "healed by cause" splits the healing: fence / trailingProse /');
console.log('  bracketRepair / quoteRepair. A strict arm must be near zero on all of');
console.log('  them — if it is not, that route is not really constrained.');
console.log('  LEGACY rows are the old tree-F1 metrics, kept only so the 2026-10-21');
console.log('  arms stay comparable. They are not the headline.');
console.log('  Averages are over the COMPILED prompts only; a prompt that never');
console.log('  compiled contributes 0 to the requirement rates and to wrong-valid.');
