/**
 * The pairing rule, and the contract-text rule inside it.
 *
 * PAIRING: only the prompts BOTH arms have measured, and only the first k
 * of those in prompt-set order, are comparable. That is what stopped the
 * 2026-10-21 arms from being read side by side on different spans.
 *
 * CONTRACT TEXT: a prompt the two arms measured under DIFFERENT contract
 * texts is not comparable at all — the contract is what the arm is
 * measuring, so the same prompt under two contracts is two measurements.
 * The arm fingerprint cannot see this (it never covered the prompt's
 * words), which is why the contract text is hashed and why the hash is
 * what this module compares.
 *
 * These four cases are the whole rule:
 *
 *   1. same text on both sides          -> comparable, the prefix grows
 *   2. both unknown (rows predate the hash) -> comparable, the prefix grows
 *   3. different texts                   -> NOT comparable, the prefix stops
 *   4. unknown vs a known text          -> NOT comparable (unknown is not a text)
 *
 * Run: node packages/genui/scripts/pairing-contract-text.test.mjs
 */
import { compareArms, contractTextOf, planPairing } from '../src/pairing.ts';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const SPECS = [
  { id: 'L1', prompt: 'p1' },
  { id: 'L2', prompt: 'p2' },
  { id: 'L3', prompt: 'p3' },
];

const row = (prompt, hash, extra = {}) => ({
  prompt,
  contractTextHash: hash,
  compiled: true,
  ...extra,
});

const arm = (label, rows) => ({ label, rows });

console.log('pairing — the contract text is part of comparability');

const TEXT_A = 'aaaa1111';
const TEXT_B = 'bbbb2222';

// 1. The same text on both sides: comparable.
{
  const a = arm('A', [row('p1', TEXT_A), row('p2', TEXT_A)]);
  const b = arm('B', [row('p1', TEXT_A), row('p2', TEXT_A)]);
  const c = compareArms(SPECS, [a, b], 'A', 'B');
  check('the same contract text pairs', c.commonPrefix.length === 2, `prefix=${c.commonPrefix.length}`);
  check('the paired text is reported', c.pairedText === TEXT_A, c.pairedText);
  check('no mismatch is counted', c.textMismatch === 0);
}

// 2. Both unknown (the rows predate the hash): comparable — this is what
//    every arm measured before 2026-10-22 looks like.
{
  const a = arm('A', [{ prompt: 'p1' }, { prompt: 'p2' }]);
  const b = arm('B', [{ prompt: 'p1' }, { prompt: 'p2' }]);
  const c = compareArms(SPECS, [a, b], 'A', 'B');
  check('two unknown texts pair', c.commonPrefix.length === 2, `prefix=${c.commonPrefix.length}`);
  check('the paired text reads "unknown"', c.pairedText === 'unknown', c.pairedText);
  check('no mismatch is counted', c.textMismatch === 0);
}

// 3. Different texts: NOT comparable, and the prefix stops there.
{
  const a = arm('A', [row('p1', TEXT_A), row('p2', TEXT_A), row('p3', TEXT_A)]);
  const b = arm('B', [row('p1', TEXT_A), row('p2', TEXT_B), row('p3', TEXT_B)]);
  const c = compareArms(SPECS, [a, b], 'A', 'B');
  check('a differing text stops the prefix at the first difference', c.commonPrefix.length === 1, `prefix=${c.commonPrefix.length}`);
  check('the differing prompt is not in the common set', c.common.length === 1, `common=${c.common.length}`);
  check('the mismatch is counted', c.textMismatch === 2, `mismatch=${c.textMismatch}`);
  check(
    'the paired text describes the COMPARABLE span (p1), not the mismatched prompts',
    c.pairedText === TEXT_A,
    c.pairedText,
  );
  check('the paired text is never "mixed" when the span is single-text', c.pairedText !== 'mixed');
}

// 4. Unknown vs a known text: NOT comparable. Unknown is the ABSENCE of a
//    text, not a text that happens to match.
{
  const a = arm('A', [{ prompt: 'p1' }, { prompt: 'p2' }]);
  const b = arm('B', [row('p1', TEXT_A), row('p2', TEXT_A)]);
  const c = compareArms(SPECS, [a, b], 'A', 'B');
  check('unknown vs a known text stops the prefix', c.commonPrefix.length === 0, `prefix=${c.commonPrefix.length}`);
  check('the mismatch is counted', c.textMismatch === 2, `mismatch=${c.textMismatch}`);
}

// The helper itself.
check(
  'contractTextOf reads the row\'s hash',
  contractTextOf(arm('A', [row('p1', TEXT_A)]), 'p1') === TEXT_A,
);
check(
  'contractTextOf reads "unknown" for a row without a hash',
  contractTextOf(arm('A', [{ prompt: 'p1' }]), 'p1') === 'unknown',
);
check(
  'contractTextOf ignores a provider-error row (it was never measured)',
  contractTextOf(arm('A', [row('p1', TEXT_A, { providerError: 'boom' })]), 'p1') === 'unknown',
);

// The scheduler's worklist is unchanged by the contract text: a prompt
// measured by every arm is not "missing" just because the texts differ —
// what differs is the COMPARISON, and the arms have to be re-measured under
// one text to be compared.
{
  const a = arm('A', [row('p1', TEXT_A)]);
  const b = arm('B', [row('p1', TEXT_B)]);
  const plan = planPairing(SPECS, [a, b]);
  check('the worklist still asks for the unmeasured prompts', plan.missing.length === 2, JSON.stringify(plan.missing));
  check('the measured prompt is still paired for the worklist', plan.paired.length === 1, JSON.stringify(plan.paired));
}

console.log(failures === 0 ? '\npairing contract text: OK' : `\npairing contract text: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
