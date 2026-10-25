/**
 * @p31ca/genui — PAIRING: the same prompts, measured by every arm.
 *
 * WHY THIS EXISTS.
 *
 * The arms are scheduled PROMPT-MAJOR: each prompt goes through every arm
 * in turn, so a budget cut leaves the arms measured on the SAME prompts.
 * The 2026-10-21 comparison broke that: one arm had 40 prompts, another
 * had 20, and the two numbers were read side by side anyway — so the
 * difference could have been the prompts rather than the arm.
 *
 * The rule this module makes checkable: **only the paired prefix is
 * comparable.** An arm may have measured more prompts than another, but
 * the extra prompts are not evidence about the arm; they are evidence
 * about the schedule.
 *
 * THE JOIN is by prompt TEXT, not by id: the rows of a fixture carry the
 * prompt, and a row written before the id field existed carries nothing
 * else. The id is used for reporting, never for the join.
 */

export interface PromptSpec {
  id?: string;
  prompt: string;
}

export interface ArmRows {
  /** The arm's name, for reporting. */
  label: string;
  /** The rows of the arm's result fixture. */
  rows: any[];
}

/** The prompts an arm has actually MEASURED (a provider error is not a
 *  measurement — the prompt was never answered, so the next window must
 *  try it again). */
export function measuredPrompts(arm: ArmRows): Set<string> {
  const out = new Set<string>();
  for (const r of arm.rows ?? []) {
    if (r?.providerError) continue;
    if (typeof r?.prompt === 'string') out.add(r.prompt);
  }
  return out;
}

export interface PairingPlan {
  /** Every prompt id, in the prompt set's order. */
  order: string[];
  /** The prompts EVERY arm has measured — the comparable prefix. */
  paired: string[];
  /** The prompts at least one arm has NOT measured — the work to do. */
  missing: string[];
  /** How many prompts each arm has measured. */
  counts: Record<string, number>;
  /** The length of the comparable prefix. */
  pairedLength: number;
}

/**
 * Work out which prompts are comparable and which still have to be
 * measured.
 *
 * `missing` is the scheduler's worklist: the prompts that are not yet in
 * EVERY arm. A prompt measured in one arm but not another is still
 * missing, because the arms have to be paired for the comparison to mean
 * anything.
 */
export function planPairing(specs: PromptSpec[], arms: ArmRows[]): PairingPlan {
  const measured = arms.map((a) => measuredPrompts(a));
  const order: string[] = [];
  const paired: string[] = [];
  const missing: string[] = [];
  const counts: Record<string, number> = {};

  for (const a of arms) counts[a.label] = measuredPrompts(a).size;

  for (const spec of specs) {
    const id = spec.id ?? spec.prompt.slice(0, 12);
    order.push(id);
    const inEvery = arms.every((_, i) => measured[i].has(spec.prompt));
    if (inEvery) paired.push(id);
    else missing.push(id);
  }

  return { order, paired, missing, counts, pairedLength: paired.length };
}

/**
 * The rows of ONE arm, restricted to a set of prompt ids.
 *
 * The ids are resolved to prompt TEXT through the prompt set (the join
 * key), so the same helper serves fixtures written with ids and fixtures
 * written without them.
 */
export function rowsForIds(
  arm: ArmRows,
  specs: PromptSpec[],
  ids: string[],
): any[] {
  const want = new Set(ids);
  const textById = new Map<string, string>();
  for (const s of specs) {
    const id = s.id ?? s.prompt.slice(0, 12);
    textById.set(id, s.prompt);
  }
  const wantedText = new Set(ids.map((id) => textById.get(id)).filter(Boolean));
  return (arm.rows ?? []).filter((r) => typeof r?.prompt === 'string' && wantedText.has(r.prompt));
}

/**
 * The contract text an arm measured a prompt under.
 *
 * 'unknown' means the row predates the contract-text hash — it was
 * measured before the harness hashed the prompt's words. 'unknown' is NOT
 * a text: it is the absence of one, and two arms can only be compared on a
 * prompt if BOTH of their rows name the SAME text, or both are unknown.
 *
 * Two rows with different texts are not comparable even when they are the
 * same prompt: the contract IS what is being measured, so a prompt measured
 * under the old contract and the same prompt measured under the new one are
 * two different measurements.
 */
export function contractTextOf(arm: ArmRows, prompt: string): string {
  for (const r of arm.rows ?? []) {
    if (r?.prompt === prompt && !r?.providerError) return r.contractTextHash ?? 'unknown';
  }
  return 'unknown';
}

export interface PairComparison {
  a: string;
  b: string;
  /** The prompts BOTH arms have measured, in prompt-set order. A prompt
   *  measured under DIFFERENT contract texts by the two arms is NOT in
   *  here: it is counted in `textMismatch` instead. */
  common: string[];
  /** The length of the COMMON PREFIX: the first k prompts, in prompt-set
   *  order, that both arms have measured AND measured under the same
   *  contract text. This is the strictest reading of "the same first N
   *  prompts", and it is the only span on which two arms may be compared. */
  commonPrefix: string[];
  /** How many prompts A measured in total. */
  aCount: number;
  /** How many prompts B measured in total. */
  bCount: number;
  /** The prompts only A has — evidence about the schedule, not the arm. */
  onlyA: number;
  /** The prompts only B has. */
  onlyB: number;
  /** The prompts both arms measured but under DIFFERENT contract texts.
   *  These are not comparable, and they stop the common prefix. */
  textMismatch: number;
  /** The contract text of the paired span, when the two arms agree on it. */
  pairedText: string;
}

/**
 * Compare TWO arms on the prompts they share.
 *
 * "Compare A1 (n=40) and A3 (n=20) only on the same first 20 prompts" is
 * a rule about the SPAN, not about the totals: A1's extra 20 prompts say
 * nothing about A1 versus A3, because A3 never saw them. This returns
 * the shared span, so the comparison can be made on it — and so a report
 * that shows both totals cannot quietly imply the comparison covers them.
 */
export function compareArms(
  specs: PromptSpec[],
  arms: ArmRows[],
  labelA: string,
  labelB: string,
): PairComparison {
  const a = arms.find((x) => x.label === labelA);
  const b = arms.find((x) => x.label === labelB);
  const aSet = measuredPrompts(a ?? { label: labelA, rows: [] });
  const bSet = measuredPrompts(b ?? { label: labelB, rows: [] });
  const common: string[] = [];
  const commonPrefix: string[] = [];
  let onlyA = 0;
  let onlyB = 0;
  let textMismatch = 0;
  const pairedTexts = new Set<string>();
  for (const s of specs) {
    const id = s.id ?? s.prompt.slice(0, 12);
    const inA = aSet.has(s.prompt);
    const inB = bSet.has(s.prompt);
    if (inA && inB) {
      // The same prompt measured under DIFFERENT contract texts is two
      // different measurements: the contract is what the arm is measuring,
      // so the pair is not comparable and the prefix stops here. The
      // contract-text hash is what makes this visible; the fingerprint
      // cannot (it never covered the prompt's words).
      const textA = contractTextOf(a ?? { label: labelA, rows: [] }, s.prompt);
      const textB = contractTextOf(b ?? { label: labelB, rows: [] }, s.prompt);
      if (textA !== textB) {
        textMismatch++;
        continue;
      }
      pairedTexts.add(textA);
      common.push(id);
      // The prefix stops at the first prompt either arm is missing, so
      // it is always a genuine contiguous run from the start.
      if (commonPrefix.length === common.length - 1) commonPrefix.push(id);
    } else if (inA) onlyA++;
    else if (inB) onlyB++;
  }
  return {
    a: labelA,
    b: labelB,
    common,
    commonPrefix,
    aCount: aSet.size,
    bCount: bSet.size,
    onlyA,
    onlyB,
    textMismatch,
    pairedText: pairedTexts.size === 1 ? [...pairedTexts][0] : 'mixed',
  };
}
