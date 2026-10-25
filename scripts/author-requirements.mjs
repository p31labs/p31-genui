#!/usr/bin/env node
/**
 * One-off authoring pass: inject the R1..Rn REQUIREMENTS into the two prompt
 * sets. Kept in the repo because the AUTHORING RULE is the thing that makes
 * the number interpretable, and a rule nobody can read is a rule nobody can
 * check.
 *
 * THE AUTHORING RULE (2026-10-22)
 *
 *   1. A COMPONENT requirement is written when the PROMPT asks for that
 *      component ("3 stat cards and an alert" -> StatCard>=3, Alert). The
 *      prompt's own nouns decide, not the gold tree's layout: a container
 *      (Stack vs Card) is a free structural choice and is NOT asserted
 *      unless the prompt names it.
 *   2. A COUNT requirement is written when the prompt states a number of
 *      things ("4 items", "two stat cards", "3 stats").
 *   3. A PROP-VALUE requirement is written ONLY when the PROMPT states that
 *      value, or names the level it implies ("warning" -> severity=warning,
 *      "trending up" -> trend=up, "revenue 10000" -> value=10000). A value
 *      the prompt never mentioned (a title, a label, a stat number the user
 *      did not supply) is NOT asserted: the old metric demanded it and
 *      punished a valid alternative for not guessing it.
 *   4. A hasText requirement is written when the prompt names a string that
 *      must appear somewhere in the tree (a patient name, an MRN, a route).
 *
 * Every requirement must PASS against its own gold tree. The verifier
 * (packages/genui/scripts/verify-requirements.mjs) proves that, and a
 * requirement the reference answer fails is a requirement that is wrong.
 */
import { readFileSync, writeFileSync } from 'fs';

const REQ = {
  // ---------------------------------------------------------------- dev set
  L1: ['hasComponent:StatCard', 'hasComponents:StatCard>=3', 'hasComponent:Alert'],
  L2: ['hasComponent:Text', 'hasComponent:Button', 'hasText:email', 'hasText:password', 'hasText:submit'],
  L3: ['hasComponent:Card', 'hasComponents:Card>=4'],
  L4: ['hasComponent:Alert', 'hasProp:Alert:severity=warning', 'hasText:balance'],
  L5: ['hasComponent:Badge', 'hasText:active'],
  L6: ['hasComponent:Text', 'hasText:welcome'],
  L7: ['hasComponent:Button', 'hasText:submit'],
  L8: ['hasComponent:StatCard', 'hasProp:StatCard:value=10000', 'hasProp:StatCard:trend=up', 'hasText:revenue'],
  L9: ['hasComponent:Alert', 'hasProp:Alert:severity=error', 'hasText:connection'],
  L10: ['hasComponent:Card', 'hasComponents:Card>=2', 'hasProp:Stack:direction=horizontal'],
  L11: ['hasComponent:Card', 'hasComponent:Text'],
  L12: ['hasComponent:Alert', 'hasProp:Alert:severity=success', 'hasText:payment'],
  L13: ['hasComponent:Text', 'hasText:description'],
  L14: ['hasComponent:Badge', 'hasText:pending'],
  L15: ['hasComponent:Card', 'hasComponent:StatCard', 'hasComponent:Button'],
  L16: ['hasComponent:Button', 'hasText:cancel'],
  L17: ['hasComponent:StatCard', 'hasComponents:StatCard>=2', 'hasProp:Stack:direction=vertical'],
  L18: ['hasComponent:Alert', 'hasProp:Alert:severity=info', 'hasText:update'],
  L19: ['hasComponent:Badge', 'hasProp:Badge:variant=error', 'hasText:error'],
  L20: ['hasComponent:Badge', 'hasProp:Badge:variant=success', 'hasText:success'],
  L21: ['hasComponent:StatCard', 'hasProp:StatCard:value=742', 'hasProp:StatCard:trend=down', 'hasText:users'],
  L22: ['hasComponent:Card', 'hasComponent:Alert'],
  L23: ['hasComponent:Card', 'hasComponent:Button'],
  L24: ['hasComponent:Text', 'hasProp:Text:weight=bold'],
  L25: ['hasComponent:Badge', 'hasComponents:Badge>=3'],
  L26: ['hasComponent:Card', 'hasComponents:StatCard>=2'],
  L27: ['hasComponent:Text', 'hasComponent:Button', 'hasText:settings', 'hasText:save'],
  L28: ['hasComponent:Card', 'hasComponent:Text'],
  L29: ['hasComponent:StatCard', 'hasComponent:Alert', 'hasProp:Stack:direction=horizontal'],
  L30: ['hasComponent:Card', 'hasComponent:Badge', 'hasText:profile'],
  L31: ['hasComponent:StatCard', 'hasProp:StatCard:value=3.4', 'hasText:conversion'],
  L32: ['hasComponent:Card', 'hasComponents:Card>=3'],
  L33: ['hasComponent:Alert', 'hasComponent:Button', 'hasProp:Alert:severity=error'],
  L34: ['hasComponent:Text', 'hasProp:Text:size=sm'],
  L35: ['hasComponent:Badge', 'hasComponent:Text', 'hasProp:Badge:variant=success'],
  L36: ['hasComponent:StatCard', 'hasComponents:StatCard>=4'],
  L37: ['hasComponent:Card', 'hasComponent:Badge', 'hasComponent:Button'],
  L38: ['hasComponent:Card', 'hasComponent:Text', 'hasText:load'],
  L39: ['hasComponent:Badge', 'hasComponent:Text', 'hasText:notification'],
  L40: ['hasComponent:Text', 'hasComponents:StatCard>=2', 'hasText:summary'],
  L41: ['hasComponent:Alert', 'hasComponent:Button', 'hasProp:Alert:severity=warning', 'hasText:delete'],
  L42: ['hasComponent:Badge', 'hasComponents:Badge>=2'],
  L43: ['hasComponent:StatCard', 'hasComponents:StatCard>=3', 'hasProp:Stack:direction=horizontal'],
  L44: ['hasComponent:Card', 'hasComponent:Text', 'hasComponent:Button', 'hasText:step'],
  L45: ['hasComponent:Badge', 'hasComponent:Text'],
  L46: ['hasComponent:Card', 'hasComponents:Card>=2', 'hasProp:Stack:direction=horizontal'],
  L47: ['hasComponent:Button', 'hasText:cancel'],
  L48: ['hasComponent:Card', 'hasComponents:StatCard>=2', 'hasText:financial'],
  L49: ['hasComponent:Alert', 'hasComponents:Alert>=2'],
  L50: ['hasComponent:Card', 'hasComponent:Text', 'hasComponent:Button', 'hasText:welcome'],

  // ----------------------------------------------------------- held-out set
  H1: [
    'hasComponent:Card',
    'hasText:Amara Osei',
    'hasText:884213',
    'hasText:12B',
    'hasComponents:StatCard>=2',
    'hasComponent:Alert',
    'hasProp:Alert:severity=error',
  ],
  H2: [
    'hasComponent:Card',
    'hasText:TRK-55219',
    'hasComponent:Badge',
    'hasComponent:StatCard',
    'hasText:ETA',
    'hasComponent:Alert',
    'hasComponent:Button',
    'hasText:track',
  ],
  H3: [
    'hasComponent:Card',
    'hasComponents:StatCard>=2',
    'hasText:travel',
    'hasComponent:Alert',
    'hasProp:Alert:severity=warning',
    'hasComponent:Button',
    'hasText:approve',
    'hasText:5,000',
  ],
  H4: [
    'hasComponent:Card',
    'hasComponent:Badge',
    'hasText:marking',
    'hasComponent:StatCard',
    'hasText:average',
    'hasComponent:Text',
    'hasComponent:Button',
    'hasText:rubric',
  ],
  H5: [
    'hasComponent:Card',
    'hasComponent:Badge',
    'hasText:degraded',
    'hasComponents:StatCard>=2',
    'hasComponent:Alert',
    'hasProp:Alert:severity=warning',
    'hasComponent:Button',
    'hasText:acknowledge',
  ],
  H6: [
    // The HARD case: the prompt asks for a table (rank, player, score, win
    // rate) and the catalog has no table, no header row and no cell. The
    // closest thing the component set allows is text rows + a badge chip,
    // so the requirements ask for the CONTENT, not for a table.
    'hasComponent:Text',
    'hasComponent:Badge',
    'hasText:player',
    'hasText:score',
    'hasText:win rate',
  ],
  H7: [
    'hasComponent:Card',
    'hasText:AP-20451',
    'hasComponent:Badge',
    'hasText:inspection',
    'hasComponent:StatCard',
    'hasComponent:Alert',
    'hasComponent:Button',
    'hasText:upload',
  ],
  H8: [
    'hasComponent:Card',
    'hasText:season',
    'hasComponent:Badge',
    'hasComponent:StatCard',
    'hasComponent:Button',
    'hasText:watch',
  ],
  H9: [
    'hasComponent:Card',
    'hasComponent:Badge',
    'hasText:pass',
    'hasComponents:StatCard>=2',
    'hasComponent:Alert',
    'hasText:pending',
  ],
  H10: [
    'hasComponent:Card',
    'hasComponent:StatCard',
    'hasComponent:Badge',
    'hasText:critical',
    'hasText:SKU',
    'hasComponent:Alert',
    'hasProp:Alert:severity=warning',
    'hasComponent:Button',
    'hasText:reorder',
  ],
  H11: [
    'hasComponent:Card',
    'hasComponent:Badge',
    'hasComponent:Text',
    'hasComponent:Alert',
    'hasProp:Alert:severity=warning',
    'hasComponents:Button>=2',
  ],
  H12: [
    'hasComponent:Card',
    'hasComponent:Badge',
    'hasText:degraded',
    'hasComponent:StatCard',
    'hasComponent:Button',
    'hasText:inspection',
  ],
};

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node author-requirements.mjs <prompt-set.json> [...]');
  process.exit(2);
}

for (const file of files) {
  const specs = JSON.parse(readFileSync(file, 'utf8'));
  let missing = 0;
  for (const spec of specs) {
    const asserts = REQ[spec.id];
    if (!asserts) {
      console.error(`NO REQUIREMENTS AUTHORED for ${spec.id} (${spec.prompt.slice(0, 40)})`);
      missing++;
      continue;
    }
    spec.requirements = asserts.map((assert, i) => ({ id: `R${i + 1}`, assert }));
  }
  if (missing > 0) {
    console.error(`${file}: ${missing} spec(s) without requirements — refusing to write.`);
    process.exit(1);
  }
  writeFileSync(file, JSON.stringify(specs, null, 2) + '\n');
  console.log(`${file}: ${specs.length} specs, requirements written`);
}
