/**
 * The contract-placement contract.
 *
 * Two things must hold, or the role A/B measures nothing:
 *
 *   1. The 'user' placement is BYTE-IDENTICAL to the prompt every arm
 *      measured before the flag existed. The golden hash below was taken
 *      from the pipeline on 2026-10-22, BEFORE any of this work. If the
 *      prompt bytes move, every arm measured so far becomes incomparable
 *      with every arm measured after — and the change would be silent.
 *
 *   2. The 'system' placement moves the SAME WORDS into a different role.
 *      If the two placements differed in CONTENT as well as in role, the
 *      A/B would be measuring the content, not the placement.
 *
 * The third check is the provider's message builder: a system message must
 * be prepended, and absent when there is no contract to move.
 *
 * The fourth group is the CONTRACT TEXT HASH. The arm fingerprint covers
 * the route, the model, the mode and the flags — but NOT the words of the
 * contract, so a change to the prompt text is invisible to it. The hash is
 * what makes that change visible. It must therefore: be deterministic, be
 * the same text the pipeline sends, and DIFFER when the contract differs.
 *
 * Run: node packages/genui/scripts/contract-role.test.mjs
 */
import { createHash } from 'crypto';
import { getCatalog } from '../src/catalog.ts';
import { buildConstrainedPrompt, buildConstrainedMessages, buildContractText } from '../src/plan.ts';
import { buildMessages } from '../src/provider.ts';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const catalog = getCatalog();
const names = Object.keys(catalog.components);
const PLAN = 'PLAN TEXT HERE';
const OPTS = { propContract: true, nodeShape: true, strict: false, catalog };

// The golden bytes, captured from the pipeline BEFORE this change.
const GOLDEN_SHA =
  '8a636bc5253e76cb5e8cb8190ac5516a0ff277f3d85f52262965aa3ff7fd5f53';
const GOLDEN_LEN = 2614;

const sha = (s) => createHash('sha256').update(s).digest('hex');

console.log('contract role — the prompt bytes must not move');

const userPrompt = buildConstrainedPrompt(PLAN, names, OPTS);
check(
  'the user-role prompt is byte-identical to the pre-change golden',
  sha(userPrompt) === GOLDEN_SHA && userPrompt.length === GOLDEN_LEN,
  `sha=${sha(userPrompt)} len=${userPrompt.length}`,
);

// The split form must produce the SAME user message in the 'user' placement.
const splitUser = buildConstrainedMessages(PLAN, names, { ...OPTS, contractRole: 'user' });
check(
  "the 'user' placement's user message equals the historical prompt",
  splitUser.user === userPrompt,
);
check("the 'user' placement sends no system message", splitUser.system === undefined);

// The 'system' placement: the contract in the system message, the task in
// the user message.
const splitSystem = buildConstrainedMessages(PLAN, names, { ...OPTS, contractRole: 'system' });
check('the system placement sends a system message', typeof splitSystem.system === 'string');
check(
  'the system message is not empty',
  (splitSystem.system ?? '').trim().length > 0,
);

// The contract's WORDS are the same in both placements. The user-role
// prompt contains the contract between the components line and the RULES
// block; the system message must contain exactly that text.
const marker = `AVAILABLE COMPONENTS: ${names.join(', ')}`;
const start = userPrompt.indexOf(marker) + marker.length;
const end = userPrompt.indexOf('RULES:');
const contractInUserPrompt = userPrompt.slice(start, end).replace(/^\n+/, '').replace(/\n+$/, '');
check(
  'the contract text is IDENTICAL in both placements (only the role changes)',
  contractInUserPrompt === (splitSystem.system ?? '').replace(/\n+$/, ''),
  `user=${contractInUserPrompt.length}ch system=${(splitSystem.system ?? '').length}ch`,
);

// The task must survive the split: the plan, the components and the rules.
check(
  'the user message keeps the plan',
  splitSystem.user.includes(PLAN),
);
check(
  'the user message keeps the component list',
  splitSystem.user.includes(marker),
);
check(
  'the user message keeps the rules',
  splitSystem.user.includes('RULES:') && splitSystem.user.includes('JSON spec:'),
);
check(
  'the user message does NOT carry the contract',
  !splitSystem.user.includes(contractInUserPrompt),
);
check(
  'the contract text is not shorter in the system placement (nothing dropped)',
  (splitSystem.system ?? '').length >= contractInUserPrompt.length,
);

// The provider's message builder.
const msgs = buildMessages('hello', 'contract');
check(
  'a system message is prepended to the user message',
  msgs.length === 2 && msgs[0].role === 'system' && msgs[0].content === 'contract' && msgs[1].role === 'user' && msgs[1].content === 'hello',
  JSON.stringify(msgs),
);
const noSystem = buildMessages('hello');
check(
  'no system message means one user message',
  noSystem.length === 1 && noSystem[0].role === 'user',
);
const blankSystem = buildMessages('hello', '   ');
check(
  'a blank system message is not sent',
  blankSystem.length === 1 && blankSystem[0].role === 'user',
);

// --- the contract text hash ------------------------------------------------
// The fingerprint cannot see the prompt's WORDS. The hash can, and it is
// the only thing standing between "the contract changed" and "the arm
// quietly measures two different prompts under one name".
console.log('\ncontract text hash — the thing the fingerprint cannot see');

const text = buildContractText(OPTS);
const textHash = sha(text);
check(
  'the contract text hash is deterministic',
  textHash === sha(buildContractText(OPTS)),
);
check(
  'the hash is of the contract the pipeline actually sends',
  text === contractInUserPrompt,
  `hashed=${text.length}ch sent=${contractInUserPrompt.length}ch`,
);
check(
  'the contract text is non-empty for a contract-on arm',
  text.length > 0,
);
check(
  'a contract-OFF arm hashes an empty contract',
  buildContractText({ ...OPTS, propContract: false, nodeShape: false }).length === 0,
);
check(
  'the strict variant hashes DIFFERENTLY from the loose one',
  sha(buildContractText({ ...OPTS, strict: true })) !== textHash,
);
check(
  'the adjacency variant hashes DIFFERENTLY from the tree one',
  sha(buildContractText({ ...OPTS, adjacency: true })) !== textHash,
);

console.log(failures === 0 ? '\ncontract role: OK' : `\ncontract role: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
