#!/usr/bin/env node
/**
 * probe-schema-dialect.mjs — does a provider's strict decoder accept this
 * schema dialect?
 *
 * The provider rules were established by FAILING PROBES, not by reading
 * documentation, so the per-component (adjacency) dialect is probed the
 * same way. The hypothesis: a flat node list with an `anyOf` over
 * per-component prop shapes at the ARRAY-ITEM level avoids the two things
 * the probed providers rejected (recursion, and a top-level `anyOf`).
 *
 * The probe sends a MINIMAL schema (one component, one prop) and reports
 * what the provider did with it:
 *
 *   ACCEPTED  the request went through (the decoder took the schema)
 *   REJECTED  the provider refused the schema — with the message it
 *             refused with, which is the rule that failed
 *   TIMEOUT   the provider did not answer
 *
 * The dialects probed:
 *   union-nullable           the proven one (a flat props bag, recursion
 *                             inlined to a bounded depth)
 *   adjacency                the per-component hypothesis, nullable props
 *   adjacency-nullable-free  the same, without the nullable typing (one
 *                             route rejected `type: ['string','null']`
 *                             outright)
 *
 * A dialect that a route REJECTS is not a bug in the pipeline: it is a
 * fact about the route, and the capability cache demotes the combination.
 *
 * Usage:
 *   node packages/genui/scripts/probe-schema-dialect.mjs --provider=kilo
 *   node packages/genui/scripts/probe-schema-dialect.mjs --provider=groq \
 *     --model=openai/gpt-oss-20b
 */
import { getCatalog } from '../src/catalog.ts';
import { catalogToStrictJsonSchema } from '../src/schema.ts';
import { catalogToAdjacencyStrictJsonSchema } from '../src/adjacency-schema.ts';
import { createProvider } from '../src/provider.ts';
import { getProvider } from '../src/providers.ts';
import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};

const PROVIDER_ID = getArg('provider', 'groq');
const provider = getProvider(PROVIDER_ID);
const MODEL = getArg('model', 'qwen/qwen3.8-27b');
const BASE_URL = getArg('base-url', provider.baseUrl);

function resolveKey() {
  const keyEnv = getArg('key-env', provider.keyEnv);
  if (process.env[keyEnv]) return { key: process.env[keyEnv], from: `env:${keyEnv}` };
  const keyJson = getArg('key-json', provider.keyJson);
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

const resolved = resolveKey();
if (!resolved?.key) {
  console.error(`no API key for provider "${PROVIDER_ID}" (${provider.keyEnv})`);
  process.exit(2);
}

const catalog = getCatalog();

const DIALECTS = [
  {
    name: 'union-nullable',
    schema: () => catalogToStrictJsonSchema(catalog),
    sample: {
      component: 'Badge',
      props: { label: 'Active', variant: 'success' },
      children: [],
      id: 'n1',
    },
  },
  {
    name: 'adjacency',
    schema: () => catalogToAdjacencyStrictJsonSchema(catalog, { nullable: true }),
    sample: { nodes: [{ id: 'n1', component: 'Badge', props: { label: 'Active', variant: 'success' }, childIds: [] }] },
  },
  {
    name: 'adjacency-nullable-free',
    schema: () => catalogToAdjacencyStrictJsonSchema(catalog, { nullable: false }),
    sample: { nodes: [{ id: 'n1', component: 'Badge', props: { label: 'Active', variant: 'success' }, childIds: [] }] },
  },
];

const call = createProvider({
  model: MODEL,
  apiKey: resolved.key,
  baseUrl: BASE_URL,
  headers: provider.headers,
  attemptTimeoutMs: 60_000,
  maxAttempts: 1,
  body: { temperature: 0, max_tokens: 256 },
});

console.log(`provider=${PROVIDER_ID} model=${MODEL} key=${resolved.from}`);
console.log('');

let accepted = 0;
for (const dialect of DIALECTS) {
  const schema = dialect.schema();
  const format = {
    type: 'json_schema',
    json_schema: { name: 'uitree', strict: true, schema },
  };
  const started = Date.now();
  try {
    const res = await call(
      'Emit a single Badge node with label "Active" and variant "success".',
      { format },
    );
    accepted++;
    console.log(
      `  ✓ ${dialect.name}: ACCEPTED (${Date.now() - started}ms, ${res.tokens} tokens)` +
        (res.servedModel ? ` served=${res.servedModel}` : ''),
    );
    console.log(`      output: ${String(res.text).slice(0, 160).replace(/\n/g, ' ')}`);
  } catch (e) {
    const msg = String(e?.message ?? e);
    console.log(`  ✗ ${dialect.name}: REJECTED — ${msg.slice(0, 300)}`);
  }
}

console.log('');
console.log(`${accepted}/${DIALECTS.length} dialects accepted by ${PROVIDER_ID}/${MODEL}`);
process.exit(accepted > 0 ? 0 : 1);
