#!/usr/bin/env node
/**
 * probe-system-role.mjs — does this route DELIVER a system message to the
 * model, and which role wins when they conflict?
 *
 * WHY THIS PROBE EXISTS.
 *
 * The contract-placement A/B measured (packages/genui/scripts/
 * smoke-contract-role.sh) put the same contract in the user role and in the
 * system role, on the same six prompts, on the same route and model. The
 * system role was much WORSE: 0/6 first-pass against 6/6 for the user role,
 * and an error profile dominated by `missing_required_prop` — the model
 * reaching for prop names the catalog does not have.
 *
 * That error profile is what a run with NO CONTRACT AT ALL looks like. So
 * before the result is written up as "the model ignores the system role",
 * the cheaper explanation has to be ruled out: THE GATEWAY DROPS THE SYSTEM
 * MESSAGE. A dropped system message and an ignored system message produce
 * the same numbers, and they mean opposite things — one is about the
 * route, the other is about the model.
 *
 * THE TEST.
 *
 * Three calls, each with a checkable answer:
 *
 *   1. SYSTEM-ONLY  — the system message says "reply with exactly the word
 *      ALPHA", the user message says "reply with exactly the word BETA".
 *      * "ALPHA"  -> the system message reached the model, and the system
 *                    role WINS.
 *      * "BETA"   -> the system message did NOT reach the model (or lost).
 *   2. SYSTEM-ONLY, no conflict — the system message says "reply with
 *      exactly the word ALPHA", the user message says "say hello".
 *      * "ALPHA"  -> the system message reached the model.
 *      * "hello"  -> the system message did not reach the model.
 *   3. USER-ONLY (the control) — no system message at all, the user message
 *      says "reply with exactly the word BETA". This is the baseline the
 *      route must be able to do, and it proves the probe can see a
 *      difference when there is one.
 *
 * The verdict is about the ROUTE, not about models in general: a gateway
 * that drops the system role makes the placement A/B meaningless on that
 * route (it measures "no contract" against "contract"), and a gateway that
 * delivers it makes the result a statement about the model's attention.
 *
 * Usage:
 *   node packages/genui/scripts/probe-system-role.mjs --provider=kilo
 *   node packages/genui/scripts/probe-system-role.mjs --provider=groq \
 *     --model=openai/gpt-oss-20b
 *
 * Exit code: 0 when the system message is DELIVERED, 1 when it is dropped
 * or loses to the user role, 2 when the route cannot be reached.
 */
import { getProvider } from '../src/providers.ts';
import { createProvider } from '../src/provider.ts';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};

const PROVIDER_ID = getArg('provider', 'kilo');
const provider = getProvider(PROVIDER_ID);
const MODEL = getArg('model', provider.defaultModel ?? 'poolside/laguna-s-2.1:free');
const BASE_URL = getArg('base-url', provider.baseUrl);
const OUT = getArg(
  'out',
  resolve(import.meta.dirname, '../fixtures/system-role-probe/probe.current.md'),
);

function resolveKey() {
  const keyEnv = getArg('key-env', provider.keyEnv);
  if (process.env[keyEnv]) return { key: process.env[keyEnv], from: `env:${keyEnv}` };
  const keyJson = getArg('key-json', '');
  const spec = keyJson
    ? { file: keyJson.split('#')[0], field: keyJson.split('#')[1] ?? 'key' }
    : provider.keyJson;
  if (spec?.file) {
    try {
      const raw = JSON.parse(readFileSync(spec.file, 'utf8'));
      const value = spec.field.split('.').reduce((acc, part) => acc?.[part], raw);
      if (typeof value === 'string' && value.length > 0) {
        return { key: value, from: `file:${spec.file}#${spec.field}` };
      }
    } catch (e) {
      console.error(`could not read the key file ${spec.file}: ${e?.message ?? e}`);
    }
  }
  return null;
}

const resolvedKey = resolveKey();
if (!resolvedKey) {
  console.error(`no API key for provider "${PROVIDER_ID}"`);
  process.exit(2);
}

const call = createProvider({
  model: MODEL,
  apiKey: resolvedKey.key,
  baseUrl: BASE_URL,
  headers: provider.headers,
  body: { ...(provider.body ?? {}), temperature: 0, max_tokens: 32 },
  attemptTimeoutMs: 60_000,
  maxAttempts: 3,
});

/** One probe: ask for a word, and see which word comes back. */
async function ask(system, user) {
  try {
    const res = await call(user, system ? { system } : {});
    return { ok: true, text: (res.text ?? '').trim(), servedModel: res.servedModel };
  } catch (e) {
    return { ok: false, text: '', error: String(e?.message ?? e).slice(0, 200) };
  }
}

const SYST = 'Reply with EXACTLY the word ALPHA. Nothing else.';
const USER_ALPHA = 'Reply with EXACTLY the word ALPHA. Nothing else.';
const USER_BETA = 'Reply with EXACTLY the word BETA. Nothing else.';
const USER_HELLO = 'Say hello.';

const probes = [
  {
    id: 'conflict',
    question: 'system says ALPHA, user says BETA',
    system: SYST,
    user: USER_BETA,
  },
  {
    id: 'system-only',
    question: 'system says ALPHA, user says hello',
    system: SYST,
    user: USER_HELLO,
  },
  {
    id: 'control',
    question: 'no system message, user says BETA',
    system: null,
    user: USER_BETA,
  },
];

const results = [];
for (const p of probes) {
  const r = await ask(p.system, p.user);
  const said = r.ok ? r.text.toUpperCase() : '';
  const verdict = !r.ok
    ? 'ROUTE ERROR'
    : said.includes('ALPHA')
      ? 'ALPHA'
      : said.includes('BETA')
        ? 'BETA'
        : `OTHER (${JSON.stringify(r.text.slice(0, 40))})`;
  results.push({ ...p, ...r, verdict });
  console.log(`${p.id.padEnd(12)} ${verdict.padEnd(30)} ${r.ok ? r.text.slice(0, 60) : r.error}`);
}

const delivered = results.filter((r) => r.verdict === 'ALPHA').length;
const systemOnly = results.find((r) => r.id === 'system-only');
const control = results.find((r) => r.id === 'control');
const conflict = results.find((r) => r.id === 'conflict');

let verdict;
if (systemOnly?.verdict === 'ALPHA') {
  verdict =
    conflict?.verdict === 'ALPHA'
      ? 'DELIVERED — the system message reaches the model, and the system role wins the conflict.'
      : 'DELIVERED, but the user role wins the conflict.';
} else if (control?.verdict === 'BETA') {
  verdict =
    'DROPPED — the user message is honoured and the system message is not. ' +
    'On this route the contract-placement A/B measured "no contract" against "contract", ' +
    'not "system role" against "user role".';
} else {
  verdict = 'INCONCLUSIVE — the route did not answer the control either.';
}

const md = `# System-role probe — ${PROVIDER_ID}/${MODEL}

Probed: ${new Date().toISOString()}
Route: ${BASE_URL}
Key source: ${resolvedKey.from}

## Verdict

**${verdict}**

## The probes

| probe | system message | user message | answer | verdict |
|---|---|---|---|---|
${results
  .map(
    (r) =>
      `| ${r.id} | ${r.system ? JSON.stringify(r.system.slice(0, 40)) : '(none)'} | ${JSON.stringify(
        r.user.slice(0, 40),
      )} | ${r.ok ? JSON.stringify(r.text.slice(0, 40)) : 'ERROR: ' + r.error} | ${r.verdict} |`,
  )
  .join('\n')}

## Why it matters

The contract-placement A/B (packages/genui/fixtures/smoke-contract-user-results.json
and smoke-contract-system-results.json) put the same contract words in the
user role and the system role. The system role was much worse. This probe
separates the two explanations for that: the ROUTE dropped the system
message, or the MODEL gave it less weight. The former makes the A/B a
statement about the route; the latter makes it a statement about attention.
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, md);
console.log(`\nverdict: ${verdict}`);
console.log(`written: ${OUT}`);
process.exit(verdict.startsWith('DELIVERED') ? 0 : 1);
