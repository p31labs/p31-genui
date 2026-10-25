/**
 * @p31ca/genui — OFFLINE RE-SCORING (no provider, no budget).
 *
 * WHY THIS EXISTS.
 *
 * A metric change is only PROVEN by re-scoring the SAME outputs under both
 * metrics. The 2026-10-21 write-up compared 34.8% wrong-valid (a tree-F1
 * arm) against 2.9% (a requirement arm) and called the difference "the
 * metric". That comparison was across two different runs, two different
 * modes and two different prompt sets, so it could not separate the metric
 * from the run. This module is the tool that CAN separate them.
 *
 * WHAT THE ARCHIVE ACTUALLY HOLDS (measured, not assumed).
 *
 * The 2026-10-21 fixtures hold SUMMARY METRICS ONLY — componentF1,
 * propAccuracy, semanticallyWrong — and no generated tree. The trees were
 * consumed by the scorer and thrown away, so those outputs cannot be
 * re-scored, now or ever. That is a fact about the evidence, and it is
 * reported as such by `reScoreArchive` rather than papered over.
 *
 * The isolation the review asked for is nevertheless available, for free,
 * because the CURRENT arms record BOTH metrics per row on the SAME tree:
 * `componentF1` (the legacy metric) and `requirementsPassed/Total` (the
 * requirement metric), computed in the same run on the same output. The
 * comparison is therefore PAIRED — same tree, same prompt, same model,
 * same run — and it separates the metric from everything else.
 *
 * WHAT THIS MODULE CANNOT DO.
 *
 * It cannot retro-fit a requirement score onto a 2026-10-21 tree, because
 * that tree does not exist. From now on the harness archives the tree in
 * every result row (see scripts/eval-live.mjs), so every future arm IS
 * re-scorable offline under a changed scorer.
 *
 * The other half of the review's objection — "it also fits 'the requirements
 * are easy'" — is answered by `probeRequirementStrength`, which measures
 * whether the requirement set can distinguish a correct tree from a wrong
 * one: a skeleton tree with the right component names and no content at
 * all, and a mutation per requirement that must break it.
 */

import {
  evalParsed,
  evalRequirement,
  evalRequirements,
  parseAssert,
  type Requirement,
  type RequirementTally,
} from './requirements.ts';

// ---------------------------------------------------------------------------
// The end-to-end rate — the headline, not the conditional one.
// ---------------------------------------------------------------------------

export interface EndToEnd {
  /** Prompts that reached the model. */
  reached: number;
  /** Prompts that never reached the model (the budget was spent, or the
   *  provider was down). These are not pipeline results. */
  notMeasured: number;
  /** Compiled AND satisfied every requirement. */
  succeeded: number;
  /** Compiled, but a requirement failed. */
  compiledWrong: number;
  /** Never compiled. */
  didNotCompile: number;
  /** succeeded / reached — the headline rate. */
  rate: number;
  /** succeeded / ALL prompts, with the budget failures in the denominator. */
  rateOfAllPrompts: number;
  /** Does this arm record the requirement metric at all? */
  hasRequirementMetric: boolean;
}

/**
 * End-to-end success: the prompt produced a tree that COMPILED and that
 * satisfied EVERY requirement.
 *
 * "Requirement pass rate" is conditional on compiling, so it hides the
 * compile failures inside it. A reader who sees 97.1% and stops there has
 * read a rate whose denominator is the subset that already worked. The
 * end-to-end rate has the honest denominator: the prompts that reached the
 * model.
 */
export function endToEndSuccess(rows: any[]): EndToEnd {
  const out: EndToEnd = {
    reached: 0,
    notMeasured: 0,
    succeeded: 0,
    compiledWrong: 0,
    didNotCompile: 0,
    rate: 0,
    rateOfAllPrompts: 0,
    hasRequirementMetric: false,
  };
  for (const r of rows) {
    if (r.providerError) {
      out.notMeasured++;
      continue;
    }
    out.reached++;
    if (!r.compiled) {
      out.didNotCompile++;
      continue;
    }
    if (typeof r.requirementsMet !== 'boolean') continue;
    out.hasRequirementMetric = true;
    if (r.requirementsMet) out.succeeded++;
    else out.compiledWrong++;
  }
  out.rate = out.reached ? out.succeeded / out.reached : 0;
  out.rateOfAllPrompts = rows.length ? out.succeeded / rows.length : 0;
  return out;
}

// ---------------------------------------------------------------------------
// Joining an arm's rows to the specs they were measured against.
// ---------------------------------------------------------------------------

export interface Spec {
  id?: string;
  prompt: string;
  goldTree?: any;
  requirements?: Requirement[];
}

export interface SpecIndex {
  byId: Map<string, Spec>;
  byPrompt: Map<string, Spec>;
}

/**
 * Index the prompt sets.
 *
 * Arms measured before the id field was written carry only the prompt TEXT,
 * so the prompt is the join key for them; the id is the join key for
 * everything newer. Both are indexed, and the caller is told which key
 * matched, so a join can never quietly match nothing.
 */
export function indexSpecs(specs: Spec[]): SpecIndex {
  const byId = new Map<string, Spec>();
  const byPrompt = new Map<string, Spec>();
  for (const s of specs) {
    if (s.id) byId.set(s.id, s);
    if (typeof s.prompt === 'string') byPrompt.set(s.prompt, s);
  }
  return { byId, byPrompt };
}

export interface SpecMatch {
  spec: Spec | null;
  key: 'id' | 'prompt' | 'none';
}

/** Find the spec a result row was measured against. */
export function matchSpec(row: any, index: SpecIndex): SpecMatch {
  if (row?.id && index.byId.has(row.id)) return { spec: index.byId.get(row.id)!, key: 'id' };
  if (typeof row?.prompt === 'string' && index.byPrompt.has(row.prompt)) {
    return { spec: index.byPrompt.get(row.prompt)!, key: 'prompt' };
  }
  return { spec: null, key: 'none' };
}

// ---------------------------------------------------------------------------
// The paired comparison: both metrics on the SAME outputs.
// ---------------------------------------------------------------------------

/** The legacy wrong-valid rule: compiled, and the tree-F1 was below 0.5. */
export const LEGACY_F1_THRESHOLD = 0.5;

export interface MetricEffect {
  /** Rows that compiled — the denominator for both metrics. */
  compiled: number;
  /** Rows that never reached the model. */
  notMeasured: number;
  /** Does this arm record the requirement metric at all? An arm measured
   *  before the requirement metric existed has NO answer to that question,
   *  and must not be shown a number that reads like one. */
  hasRequirementMetric: boolean;
  /** The legacy metric called these wrong (F1 < 0.5). */
  legacyWrong: number;
  /** The requirement metric called these wrong (a requirement failed). */
  requirementWrong: number;
  /** Both metrics called it wrong. */
  bothWrong: number;
  /** ONLY the legacy metric called it wrong — the legacy metric's false
   *  positives: trees the old metric punished that the spec says are fine. */
  legacyOnlyWrong: number;
  /** ONLY the requirement metric called it wrong — the legacy metric's false
   *  negatives: trees the old metric approved that the spec says are wrong. */
  requirementOnlyWrong: number;
  /** Neither metric called it wrong. */
  bothRight: number;
  legacyWrongValidRate: number;
  requirementWrongValidRate: number;
  /** True when the row carries a tree and can be re-scored offline. */
  rescorable: boolean;
  /** True when the row records BOTH metrics, so a paired comparison is
   *  possible at all. */
  paired: boolean;
}

/**
 * Compare the legacy and the requirement metric on the SAME compiled rows.
 *
 * This is the isolation. Everything that could differ between two runs
 * (model, mode, prompts, day, budget) is held fixed, because both numbers
 * come from one row of one run.
 */
export function pairedMetricEffect(rows: any[]): MetricEffect {
  const compiled = rows.filter((r) => r.compiled);
  const out: MetricEffect = {
    compiled: compiled.length,
    notMeasured: rows.length - compiled.length,
    hasRequirementMetric: false,
    legacyWrong: 0,
    requirementWrong: 0,
    bothWrong: 0,
    legacyOnlyWrong: 0,
    requirementOnlyWrong: 0,
    bothRight: 0,
    legacyWrongValidRate: 0,
    requirementWrongValidRate: 0,
    rescorable: false,
    paired: false,
  };
  if (!compiled.length) return out;

  out.rescorable = compiled.some((r) => r.tree !== undefined && r.tree !== null);
  // The arm records the requirement metric only if its rows say so.
  out.hasRequirementMetric = compiled.some(
    (r) => typeof r.requirementsMet === 'boolean' || (r.requirementsTotal ?? 0) > 0,
  );

  for (const r of compiled) {
    const legacyWrong = typeof r.componentF1 === 'number' && r.componentF1 < LEGACY_F1_THRESHOLD;
    const reqKnown = typeof r.requirementsMet === 'boolean';
    const reqWrong = reqKnown && !r.requirementsMet;
    if (legacyWrong) out.legacyWrong++;
    if (reqWrong) out.requirementWrong++;
    // The confusion cells need BOTH verdicts on the SAME row. Without the
    // requirement metric there is no second verdict, so the cell is left
    // at zero and the caller prints '—' rather than a false agreement.
    if (!out.hasRequirementMetric) continue;
    out.paired = true;
    if (legacyWrong && reqWrong) out.bothWrong++;
    else if (legacyWrong) out.legacyOnlyWrong++;
    else if (reqWrong) out.requirementOnlyWrong++;
    else out.bothRight++;
  }
  out.legacyWrongValidRate = out.legacyWrong / compiled.length;
  out.requirementWrongValidRate = out.requirementWrong / compiled.length;
  return out;
}

/**
 * The legacy wrong-valid rate as a function of the F1 threshold.
 *
 * The old headline number ("34.8% wrong-valid") was F1 < 0.5 on a
 * CONTINUOUS score. This table shows how much the number moves when the
 * cut moves — which is the whole problem with thresholding a continuous
 * score at all.
 */
export function legacyThresholdSweep(
  f1Values: number[],
  thresholds: number[] = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
): { threshold: number; wrong: number; total: number; rate: number }[] {
  return thresholds.map((t) => {
    const wrong = f1Values.filter((v) => v < t).length;
    return {
      threshold: t,
      wrong,
      total: f1Values.length,
      rate: f1Values.length ? wrong / f1Values.length : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Re-scoring archived trees under the CURRENT scorer.
// ---------------------------------------------------------------------------

export interface RowRescore {
  id: string | null;
  prompt: string;
  /** The tree was archived, so this row CAN be re-scored. */
  rescorable: boolean;
  /** Why not, when it cannot. */
  reason: string;
  /** The tally recomputed from the archived tree, right now. */
  recomputed: RequirementTally | null;
  /** The tally the arm recorded when it ran. */
  stored: { passed: number; total: number } | null;
  /** Do the two agree? A mismatch means the stored number is not
   *  reproducible from the archived tree. */
  agrees: boolean | null;
}

export interface ArchiveRescore {
  rows: number;
  rescorable: number;
  /** Rows whose tree was never archived — they can never be re-scored. */
  unrescorable: number;
  /** Rows re-scored whose recomputed tally matched the recorded one. */
  agree: number;
  /** Rows re-scored whose recomputed tally DIFFERED from the recorded one. */
  disagree: number;
  perRow: RowRescore[];
}

/**
 * Re-score an arm's archived trees under the current scorer.
 *
 * For every row that archived its tree, the requirement tally is recomputed
 * here and now, and compared with the tally the arm recorded when it ran.
 * A row whose tree was never archived is reported as UNRESCORABLE, with the
 * count — it is not silently dropped, because an unrescorable row is the
 * reason a cross-run comparison was ever necessary in the first place.
 */
export function reScoreArchive(rows: any[], index: SpecIndex): ArchiveRescore {
  const out: ArchiveRescore = {
    rows: rows.length,
    rescorable: 0,
    unrescorable: 0,
    agree: 0,
    disagree: 0,
    perRow: [],
  };
  for (const row of rows) {
    const { spec, key } = matchSpec(row, index);
    const hasTree = row.tree !== undefined && row.tree !== null;
    if (!hasTree) {
      out.unrescorable++;
      out.perRow.push({
        id: row.id ?? null,
        prompt: row.prompt ?? '',
        rescorable: false,
        reason: 'no tree archived',
        recomputed: null,
        stored: null,
        agrees: null,
      });
      continue;
    }
    if (!spec) {
      out.unrescorable++;
      out.perRow.push({
        id: row.id ?? null,
        prompt: row.prompt ?? '',
        rescorable: false,
        reason: `tree archived but no spec matched (join key: ${key})`,
        recomputed: null,
        stored: null,
        agrees: null,
      });
      continue;
    }
    out.rescorable++;
    const recomputed = evalRequirements(row.tree, spec.requirements);
    const stored =
      typeof row.requirementsPassed === 'number' && typeof row.requirementsTotal === 'number'
        ? { passed: row.requirementsPassed, total: row.requirementsTotal }
        : null;
    const agrees = stored
      ? stored.passed === recomputed.passed && stored.total === recomputed.total
      : null;
    if (agrees === true) out.agree++;
    if (agrees === false) out.disagree++;
    out.perRow.push({
      id: row.id ?? null,
      prompt: row.prompt ?? '',
      rescorable: true,
      reason: 're-scored from the archived tree',
      recomputed,
      stored,
      agrees,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Are the requirements easy? (the other half of the review's objection)
// ---------------------------------------------------------------------------

// --- tree surgery, used to build mutants -----------------------------------

function cloneTree(node: any): any {
  if (Array.isArray(node)) return node.map(cloneTree);
  if (!node || typeof node !== 'object') return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) out[k] = cloneTree(v);
  return out;
}

const POISON = '__violated__';

function walk(tree: any, fn: (node: any) => void) {
  if (!tree || typeof tree !== 'object') return;
  fn(tree);
  if (Array.isArray(tree.children)) for (const c of tree.children) walk(c, fn);
}

/** Rename every node of a component. */
function renameComponent(tree: any, component: string, to: string): any {
  const t = cloneTree(tree);
  const want = component.trim().toLowerCase();
  walk(t, (n) => {
    if (typeof n.component === 'string' && n.component.trim().toLowerCase() === want) {
      n.component = to;
    }
  });
  return t;
}

/** Delete a prop from every node of a component. */
function dropProp(tree: any, component: string, prop: string): any {
  const t = cloneTree(tree);
  const want = component.trim().toLowerCase();
  walk(t, (n) => {
    if (
      typeof n.component === 'string' &&
      n.component.trim().toLowerCase() === want &&
      n.props &&
      typeof n.props === 'object'
    ) {
      delete n.props[prop];
    }
  });
  return t;
}

/** Set a prop on every node of a component. */
function setProp(tree: any, component: string, prop: string, value: unknown): any {
  const t = cloneTree(tree);
  const want = component.trim().toLowerCase();
  walk(t, (n) => {
    if (
      typeof n.component === 'string' &&
      n.component.trim().toLowerCase() === want &&
      n.props &&
      typeof n.props === 'object'
    ) {
      n.props[prop] = value;
    }
  });
  return t;
}

/**
 * Remove a substring from every string prop value in the tree.
 *
 * A `hasText` requirement passes if ANY string prop ANYWHERE contains the
 * needle, so the only way to break it is to make sure no string prop
 * contains it any more.
 */
function poisonText(tree: any, needle: string): any {
  const t = cloneTree(tree);
  const want = needle.trim().toLowerCase();
  if (!want) return t;
  walk(t, (n) => {
    if (!n.props || typeof n.props !== 'object') return;
    for (const [k, v] of Object.entries(n.props)) {
      if (typeof v === 'string' && v.toLowerCase().includes(want)) {
        // A poison that cannot itself contain the needle.
        n.props[k] = want.length <= 1 ? 0 : POISON;
      }
    }
  });
  return t;
}

/**
 * Build a tree that violates ONE requirement, leaving the rest of the tree
 * alone. Returns null when no violation can be constructed (e.g. the gold
 * tree does not contain the component at all).
 */
export function buildViolator(tree: any, req: Requirement): any | null {
  const parsed = parseAssert(req.assert);
  switch (parsed.kind) {
    case 'hasComponent':
      return renameComponent(tree, parsed.component, POISON);
    case 'hasComponents':
      return renameComponent(tree, parsed.component, POISON);
    case 'hasProp': {
      // A single node with the prop satisfies the requirement, so the prop
      // has to be broken on EVERY candidate node.
      if (parsed.op === undefined) return dropProp(tree, parsed.component, parsed.prop);
      const values: unknown[] = [POISON, '', 0, 1];
      if (parsed.op === '~') values.unshift('__no_needle__');
      for (const v of values) {
        const candidate = setProp(tree, parsed.component, parsed.prop, v);
        if (!evalParsed(candidate, parsed)) return candidate;
      }
      return dropProp(tree, parsed.component, parsed.prop);
    }
    case 'hasText':
      return poisonText(tree, parsed.text);
    default:
      return null;
  }
}

export interface RequirementProbe {
  specId: string;
  prompt: string;
  requirementId: string;
  assert: string;
  kind: string;
  /** The gold tree itself satisfies this requirement (the verifier's job). */
  goldPasses: boolean;
  /** A tree that violates it could be built. */
  violatorBuilt: boolean;
  /** The scorer CAUGHT the violation — this requirement can fail. */
  caught: boolean;
  /** How many OTHER requirements the violation also broke (collateral). */
  collateral: number;
}

export interface SpecStrength {
  specId: string;
  prompt: string;
  requirements: number;
  /** How many requirements a content-free tree with the right component
   *  NAMES still satisfies. 0 means the spec demands real content. */
  skeletonPassed: number;
  /** The requirement kinds, for a read of what the spec actually asks for. */
  kinds: Record<string, number>;
  /** The probes, one per requirement. */
  probes: RequirementProbe[];
}

export interface StrengthReport {
  specs: SpecStrength[];
  totalRequirements: number;
  /** Requirements the scorer could be shown to FAIL on a violating tree. */
  discriminable: number;
  /** Requirements no constructed violation could break. */
  vacuous: number;
  /** The share of requirements a content-free skeleton tree satisfies. */
  skeletonPassRate: number;
}

/**
 * Measure whether the requirement set can tell a correct tree from a wrong
 * one.
 *
 * Two independent measurements, both free:
 *
 * 1. SKELETON — build a tree that has one node per component the spec
 *    names, with NO props and NO content. If that satisfies most of the
 *    spec, the spec is easy: a model that emits empty shells passes it.
 *
 * 2. VIOLATION — for every requirement, build a tree that violates exactly
 *    it and check the scorer reports it as failed. A requirement the scorer
 *    cannot fail is a requirement that cannot measure anything.
 */
export function probeRequirementStrength(specs: Spec[]): StrengthReport {
  const out: StrengthReport = {
    specs: [],
    totalRequirements: 0,
    discriminable: 0,
    vacuous: 0,
    skeletonPassRate: 0,
  };
  let skeletonPassed = 0;
  let skeletonTotal = 0;

  for (const spec of specs) {
    const reqs = spec.requirements ?? [];
    if (!reqs.length || !spec.goldTree) continue;
    out.totalRequirements += reqs.length;

    const kinds: Record<string, number> = {};
    const components = new Set<string>();
    for (const r of reqs) {
      const p = parseAssert(r.assert);
      kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
      if (p.kind === 'hasComponent' || p.kind === 'hasComponents') components.add(p.component);
      if (p.kind === 'hasProp') components.add(p.component);
    }

    // --- 1. the skeleton: right component names, no content at all ---
    const skeleton = {
      component: POISON,
      props: {},
      children: [...components].map((c) => ({ component: c, props: {} })),
    };
    const skeletonTally = evalRequirements(skeleton, reqs);
    skeletonPassed += skeletonTally.passed;
    skeletonTotal += skeletonTally.total;

    // --- 2. one violation per requirement ---
    const probes: RequirementProbe[] = [];
    for (const r of reqs) {
      const parsed = parseAssert(r.assert);
      const goldPasses = evalRequirement(spec.goldTree, r).passed;
      const violator = buildViolator(spec.goldTree, r);
      let caught = false;
      let collateral = 0;
      let violatorBuilt = false;
      if (violator) {
        violatorBuilt = true;
        const tally = evalRequirements(violator, reqs);
        const target = tally.outcomes.find((o) => o.id === r.id);
        caught = target ? !target.passed : false;
        collateral = tally.failedIds.filter((id) => id !== r.id).length;
      }
      if (caught) out.discriminable++;
      else out.vacuous++;
      probes.push({
        specId: spec.id ?? '',
        prompt: spec.prompt ?? '',
        requirementId: r.id,
        assert: r.assert,
        kind: parsed.kind,
        goldPasses,
        violatorBuilt,
        caught,
        collateral,
      });
    }

    out.specs.push({
      specId: spec.id ?? '',
      prompt: spec.prompt ?? '',
      requirements: reqs.length,
      skeletonPassed: skeletonTally.passed,
      kinds,
      probes,
    });
  }

  out.skeletonPassRate = skeletonTotal ? skeletonPassed / skeletonTotal : 0;
  return out;
}
