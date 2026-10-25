/**
 * @p31ca/genui — Requirement assertions (the R1..Rn form).
 *
 * WHY THIS EXISTS. The fidelity harness used to score a generated tree
 * against ONE hand-written gold tree: component multiset F1, plus an
 * exact-match prop accuracy over the whole tree. That metric punishes a
 * VALID ALTERNATIVE — a different title, a different label wording, a
 * different nesting order — as hard as it punishes a missing component.
 * The measured symptom (2026-10-22): the 12-spec HELD-OUT set scored
 * BETTER than the 50-spec dev set (F1 0.797 vs 0.630, wrong-valid 0% vs
 * 34.8%), which is backwards for a harder set, and the dev set's
 * tree-wide prop accuracy (0.17) was low enough to explain the gap.
 *
 * The fix is to score the REQUIREMENT, not the tree. A spec says what the
 * UI must CONTAIN — "a card", "three stat cards", "a button labelled
 * Submit", "the number 42" — and the tree is correct if it satisfies those
 * requirements, however else it is arranged.
 *
 * THE GRAMMAR (the same shape the APR harness already used):
 *
 *   hasComponent:<Name>            a node of that component exists
 *   hasComponents:<Name>>=<N>      at least N nodes of that component exist
 *   hasProp:<Comp>:<prop>=<value>  a node of that component has that prop
 *                                  with that EXACT value
 *   hasProp:<Comp>:<prop>~<value>  ...with that value CONTAINED in it
 *   hasProp:<Comp>:<prop>          ...with that prop present (any value)
 *   hasText:<substring>            some string prop value contains it
 *                                  (case-insensitive)
 *
 * Component names are matched case-insensitively, so the APR form
 * (`hasComponent:STATCARD`) and the catalog form (`hasComponent:StatCard`)
 * are the same requirement.
 *
 * `=` is for short distinctive tokens the PROMPT states (42, "error",
 * "up"); `~` is for phrases (a patient's name inside a longer content
 * string). Asserting a value the prompt never mentioned is how the old
 * metric punished valid alternatives — the authoring rule is in
 * `docs/fix-plans/genui-fidelity-2026-10-21.md`.
 *
 * A requirement that cannot be parsed is a HARD FAIL, not a pass. A
 * scorer that silently ignores what it does not understand is a scorer
 * that cannot fail.
 */

export interface Requirement {
  id: string;
  assert: string;
}

/**
 * The scorer's version.
 *
 * It goes into every run manifest: a number measured by scorer v1 is not
 * the same number as one measured by v2, and a manifest that cannot say
 * which scorer produced it is not evidence.
 */
export const SCORER_VERSION = 'requirements-2.0.0';

export type ParsedAssert =
  | { kind: 'hasComponent'; component: string }
  | { kind: 'hasComponents'; component: string; min: number }
  | { kind: 'hasProp'; component: string; prop: string; op?: '=' | '~'; value?: string }
  | { kind: 'hasText'; text: string }
  | { kind: 'unknown'; raw: string };

export interface RequirementOutcome {
  id: string;
  assert: string;
  passed: boolean;
  /** Why it failed, in one line (for the per-prompt report). */
  detail: string;
}

/** Every node in the tree, in document order. */
export function flattenNodes(tree: any): any[] {
  const out: any[] = [];
  (function walk(node: any) {
    if (!node || typeof node !== 'object') return;
    out.push(node);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  })(tree);
  return out;
}

/** The node's component name, if it has one. */
function componentOf(node: any): string {
  return typeof node?.component === 'string' ? node.component : '';
}

function norm(s: unknown): string {
  return String(s ?? '').trim().toLowerCase();
}

/**
 * The first number in a string, or null.
 *
 * A requirement that says `value=10000` must not fail because the model
 * wrote "10,000" or "$10000" or "10000 units" — those are the SAME value
 * written differently, and a scorer that punishes formatting is the same
 * scorer that punished a valid alternative. Units are ignored, so
 * "112 bpm" satisfies `value=112`.
 */
function numericOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const m = /-?\d+(?:\.\d+)?/.exec(value.replace(/,/g, ''));
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Numeric-aware equality: exact string match, or the same number. */
function valuesEqual(actual: unknown, expected: string): boolean {
  if (typeof actual === 'string' && actual === expected) return true;
  const a = numericOf(actual);
  const b = numericOf(expected);
  if (a === null || b === null) return false;
  // Compare at 6 significant digits so "3.40" and "3.4" are the same value
  // but "112" and "112.5" are not.
  const round = (n: number) => Number(n.toPrecision(6));
  return round(a) === round(b);
}

/**
 * Parse one assertion string into a structured predicate.
 * An unrecognised assertion parses to `kind: 'unknown'` and FAILS.
 */
export function parseAssert(assert: string): ParsedAssert {
  const raw = String(assert ?? '').trim();
  if (!raw) return { kind: 'unknown', raw };

  const sep = raw.indexOf(':');
  if (sep < 0) return { kind: 'unknown', raw };
  const head = raw.slice(0, sep);
  const rest = raw.slice(sep + 1);

  if (head === 'hasComponent') {
    return { kind: 'hasComponent', component: rest.trim() };
  }

  if (head === 'hasComponents') {
    // hasComponents:Name>=N
    const m = /^([^>]+)>=\s*(\d+)$/.exec(rest.trim());
    if (!m) return { kind: 'unknown', raw };
    return { kind: 'hasComponents', component: m[1].trim(), min: Number(m[2]) };
  }

  if (head === 'hasProp') {
    // hasProp:Comp:prop=value | hasProp:Comp:prop~value | hasProp:Comp:prop
    const cSep = rest.indexOf(':');
    if (cSep < 0) return { kind: 'unknown', raw };
    const component = rest.slice(0, cSep).trim();
    const tail = rest.slice(cSep + 1);
    const eq = tail.indexOf('=');
    const tilde = tail.indexOf('~');
    // '=' and '~' can both appear in a value ("a=b"); the FIRST operator wins.
    let opAt = -1;
    let op: '=' | '~' = '=';
    if (eq >= 0 && (tilde < 0 || eq < tilde)) {
      opAt = eq;
      op = '=';
    } else if (tilde >= 0) {
      opAt = tilde;
      op = '~';
    }
    if (opAt < 0) return { kind: 'hasProp', component, prop: tail.trim() };
    return {
      kind: 'hasProp',
      component,
      prop: tail.slice(0, opAt).trim(),
      op,
      value: tail.slice(opAt + 1).trim(),
    };
  }

  if (head === 'hasText') {
    return { kind: 'hasText', text: rest };
  }

  return { kind: 'unknown', raw };
}

/** Does the tree satisfy this parsed assertion? */
export function evalParsed(tree: any, parsed: ParsedAssert): boolean {
  const nodes = flattenNodes(tree);
  switch (parsed.kind) {
    case 'hasComponent':
      return nodes.some((n) => norm(componentOf(n)) === norm(parsed.component));
    case 'hasComponents': {
      const count = nodes.filter((n) => norm(componentOf(n)) === norm(parsed.component)).length;
      return count >= parsed.min;
    }
    case 'hasProp': {
      const candidates = nodes.filter((n) => norm(componentOf(n)) === norm(parsed.component));
      return candidates.some((n) => {
        const props = n?.props;
        if (!props || typeof props !== 'object') return false;
        if (!(parsed.prop in props)) return false;
        if (parsed.op === undefined) return true;
        const actual = props[parsed.prop];
        const expected = parsed.value ?? '';
        if (parsed.op === '~') {
          if (norm(actual).includes(norm(expected))) return true;
          return valuesEqual(actual, expected);
        }
        // Exact first, then the numeric-aware comparison: "3.4%" and "3.4"
        // are the same value written two ways, and a scorer that punishes
        // formatting punishes a valid alternative.
        if (typeof actual === 'string' && actual === expected) return true;
        if (JSON.stringify(actual) === JSON.stringify(expected)) return true;
        return valuesEqual(actual, expected);
      });
    }
    case 'hasText': {
      const needle = norm(parsed.text);
      if (!needle) return false;
      return nodes.some((n) => {
        const props = n?.props;
        if (!props || typeof props !== 'object') return false;
        return Object.values(props).some(
          (v) => typeof v === 'string' && norm(v).includes(needle),
        );
      });
    }
    case 'unknown':
      // A scorer that does not understand a requirement must not pass it.
      return false;
    default:
      return false;
  }
}

/** Evaluate one requirement against a tree. */
export function evalRequirement(tree: any, req: Requirement): RequirementOutcome {
  const parsed = parseAssert(req.assert);
  const passed = evalParsed(tree, parsed);
  return {
    id: req.id,
    assert: req.assert,
    passed,
    detail: passed ? '' : describeFailure(tree, parsed),
  };
}

function describeFailure(tree: any, parsed: ParsedAssert): string {
  const nodes = flattenNodes(tree);
  switch (parsed.kind) {
    case 'hasComponent':
      return `no ${parsed.component} node`;
    case 'hasComponents': {
      const count = nodes.filter((n) => norm(componentOf(n)) === norm(parsed.component)).length;
      return `only ${count} ${parsed.component} node(s), need ${parsed.min}`;
    }
    case 'hasProp':
      return `no ${parsed.component} with ${parsed.prop}${
        parsed.value !== undefined ? ` = ${parsed.value}` : ''
      }`;
    case 'hasText':
      return `no prop value contains "${parsed.text}"`;
    default:
      return `unparseable assertion "${parsed.raw}"`;
  }
}

export interface RequirementTally {
  total: number;
  passed: number;
  failed: number;
  /** 0..1 — passed / total. 1 when there are no requirements. */
  rate: number;
  /** A tree that satisfies every requirement. */
  allPassed: boolean;
  failedIds: string[];
  outcomes: RequirementOutcome[];
}

/** Evaluate a whole requirement list against a tree. */
export function evalRequirements(tree: any, reqs: Requirement[] | undefined): RequirementTally {
  const list = Array.isArray(reqs) ? reqs : [];
  if (list.length === 0) {
    return { total: 0, passed: 0, failed: 0, rate: 1, allPassed: true, failedIds: [], outcomes: [] };
  }
  const outcomes = list.map((r) => evalRequirement(tree, r));
  const passed = outcomes.filter((o) => o.passed).length;
  return {
    total: list.length,
    passed,
    failed: list.length - passed,
    rate: passed / list.length,
    allPassed: passed === list.length,
    failedIds: outcomes.filter((o) => !o.passed).map((o) => o.id),
    outcomes,
  };
}
