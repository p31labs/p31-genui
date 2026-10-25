#!/usr/bin/env node
/**
 * probe-strict-enforcement.mjs — is the SCHEMA actually enforced on this
 * route, or is it only in the prompt?
 *
 * WHY THIS PROBE EXISTS.
 *
 * The strict arm's heal causes are `fence=2, trailingProse=5`. A
 * CONSTRAINED decoder cannot emit a code fence and cannot emit trailing
 * prose — those are exactly the two things a structured-output decoder
 * removes. So those heals are evidence AGAINST the schema being enforced
 * on that route. The 2026-10-21 write-up read them the other way ("the
 * model wrapped its JSON, not the decoder failing"); that reading is
 * withdrawn, and this probe is the test that settles it.
 *
 * THE TEST.
 *
 * Send a strict schema whose property has a SINGLE-VALUE enum, together
 * with a prompt that invites a DIFFERENT value:
 *
 *     schema:  { component: enum ["Badge"], variant: enum ["danger"] }
 *     prompt:  'Emit a Badge with variant "success" and label "Active".'
 *
 * Then run the SAME prompt with NO schema at all, as the control:
 *
 *   * the control says "success" and the strict run says "success"  ->
 *     the schema did NOT constrain the output. NOT ENFORCED.
 *   * the control says "success" and the strict run says "danger"   ->
 *     the output was coerced to the enum. ENFORCED.
 *   * the strict run is REJECTED by the provider -> the route does not
 *     accept a strict schema at all (a different, also-useful finding).
 *
 * The control is what makes the verdict a measurement instead of an
 * inference: without it, "the output matched the enum" could just mean
 * the model complied with the schema text it was shown.
 *
 * Two further checks ride along, both free and both about the DECODER
 * rather than the model: a constrained emission carries no code fence
 * and no trailing prose.
 *
 * Usage:
 *   node packages/genui/scripts/probe-strict-enforcement.mjs --provider=kilo
 *   node packages/genui/scripts/probe-strict-enforcement.mjs --provider=groq \
 *     --model=openai/gpt-oss-20b
 *
 * Exit code: 0 when the route enforces the schema (or rejects it
 * outright, which is also a definite answer), 1 when the route does NOT
 * enforce it.
 */
import { getProvider } from '../src/providers.ts';
import { createProvider } from '../src/provider.ts';
import { readFileSync } from 'fs';
import { getCatalog } from '../src/catalog.ts';
import { catalogToStrictJsonSchema } from '../src/schema.ts';

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};

const PROVIDER_ID = getArg('provider', 'kilo');
const provider = getProvider(PROVIDER_ID);
const MODEL = getArg('model', 'poolside/laguna-s-2.1:free');
const BASE_URL = getArg('base-url', provider.baseUrl);

function resolveKey() {
  const keyEnv = getArg('key-env', provider.keyEnv);
  if (process.env[keyEnv]) return { key: process.env[keyEnv], from: `env:${keyEnv}` };
  // The provider spec's keyJson is {file, field}; a --key-json= override may
  // be given as "path#field".
  const override = getArg('key-json', null);
  const spec = override
    ? { file: override.split('#')[0], field: override.split('#')[1] ?? 'key' }
    : provider.keyJson;
  if (spec?.file) {
    try {
      const raw = JSON.parse(readFileSync(spec.file, 'utf8'));
      // The field is a DOTTED PATH ('kilo.key'), not a flat key — the same
      // resolution eval-live.mjs uses. A flat lookup finds nothing here.
      const value = spec.field.split('.').reduce((acc, part) => acc?.[part], raw);
      if (typeof value === 'string' && value.length > 0) {
        return { key: value, from: `file:${spec.file}#${spec.field}` };
      }
    } catch (e) {
      console.error(`could not read the key file ${spec.file}: ${e?.message ?? e}`);
    }
  }
  throw new Error(`no key resolved for provider ${PROVIDER_ID}`);
}

const resolved = resolveKey();

/**
 * A minimal, HAND-WRITTEN strict schema — deliberately not produced by
 * our own schema generator, because the question is about the ROUTE, not
 * about whether our generator emits something the route accepts.
 */
const STRICT_SCHEMA = {
  type: 'object',
  properties: {
    component: { type: 'string', enum: ['Badge'] },
    variant: { type: 'string', enum: ['danger'] },
    label: { type: 'string' },
  },
  required: ['component', 'variant', 'label'],
  additionalProperties: false,
};

const PROMPT =
  'Emit a Badge with variant "success" and label "Active". Reply with JSON only.';

/** Pull the first JSON object out of a response, if there is one. */
function parseJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Find a property ANYWHERE in the object.
 *
 * The control run nests its answer ("badge": { variant: … }) because
 * json_object mode gives the model no shape at all, while the strict run
 * answers flat. A top-level-only lookup would read the control as "no
 * variant", which would make the verdict UNDECIDED when the control had
 * actually answered the question.
 */
function findProp(obj, name) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[name] !== undefined) return obj[name];
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const hit = findProp(v, name);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** The top-level keys of an object — used to compare SHAPE to the schema. */
const topKeys = (obj) => (obj && typeof obj === 'object' ? Object.keys(obj) : []);

const call = createProvider({
  model: MODEL,
  apiKey: resolved.key,
  baseUrl: BASE_URL,
  headers: provider.headers,
  attemptTimeoutMs: 60_000,
  maxAttempts: 1,
  body: { temperature: 0, max_tokens: 256 },
});

console.log(`=== STRICT-ENFORCEMENT PROBE ===`);
console.log(`provider=${PROVIDER_ID} model=${MODEL} key=${resolved.from}`);
console.log('');
console.log('  schema: variant is a SINGLE-VALUE enum ["danger"]');
console.log(`  prompt: ${PROMPT}`);
console.log('');

const results = {};

// ---- the strict run -------------------------------------------------------
let strictText = null;
let rejected = null;
try {
  const res = await call(PROMPT, {
    format: { type: 'json_schema', json_schema: { name: 'uitree', strict: true, schema: STRICT_SCHEMA } },
  });
  strictText = String(res.text);
  results.servedModel = res.servedModel;
} catch (e) {
  rejected = String(e?.message ?? e);
}

if (rejected !== null) {
  console.log(`  STRICT: REJECTED by the provider — ${rejected.slice(0, 300)}`);
  console.log('');
  console.log('  VERDICT: the route does not accept a strict schema at all.');
  console.log('  That is a definite answer, and it is not "enforced".');
  console.log('');
  process.exit(0);
}

console.log('  STRICT output (raw):');
console.log(`    ${strictText.replace(/\n/g, '\\n').slice(0, 400)}`);
const strictJson = parseJson(strictText);
console.log(`  parsed: ${strictJson ? JSON.stringify(strictJson) : 'NOT JSON'}`);
console.log('');

// ---- the control run (no schema) -----------------------------------------
let controlText = null;
try {
  const res = await call(PROMPT, { format: { type: 'json_object' } });
  controlText = String(res.text);
} catch (e) {
  console.log(`  CONTROL: provider error — ${String(e?.message ?? e).slice(0, 200)}`);
}
const controlJson = controlText ? parseJson(controlText) : null;
console.log('  CONTROL (json_object, same prompt):');
console.log(`    ${controlText === null ? '(none)' : controlText.replace(/\n/g, '\\n').slice(0, 300)}`);
console.log(`  parsed: ${controlJson ? JSON.stringify(controlJson) : 'NOT JSON'}`);
console.log('');

// ---- the ARM'S OWN SCHEMA -------------------------------------------------
// The minimal schema above proves what the ROUTE does with a hand-written
// strict schema. What the arms actually send is the CATALOG's strict
// schema, whose enums are the ones the compiler enforces. So the same
// test is run against THAT schema, with a value the catalog forbids
// ("chartreuse" is not one of Badge's variant values). If the route does
// not enforce it here either, the strict arm's schema is decorative and
// the compile failures it produces are the route's fault, not the
// catalog's.
let catalogText = null;
let catalogRejected = null;
try {
  const catalog = getCatalog();
  const armSchema = catalogToStrictJsonSchema(catalog, { maxDepth: 4 });
  const res = await call(
    'Emit a Badge node with id "b1", props label "Active" and variant "chartreuse", and no children. Reply with JSON only.',
    {
      format: { type: 'json_schema', json_schema: { name: 'uitree', strict: true, schema: armSchema } },
    },
  );
  catalogText = String(res.text);
} catch (e) {
  catalogRejected = String(e?.message ?? e);
}
const catalogJson = catalogText ? parseJson(catalogText) : null;
const catalogVariant = findProp(catalogJson, 'variant') ?? null;
console.log('  ARM SCHEMA (the catalog strict schema the strict arm sends):');
if (catalogRejected !== null) {
  console.log(`    REJECTED by the provider — ${catalogRejected.slice(0, 300)}`);
} else {
  console.log(`    ${catalogText.replace(/\n/g, '\\n').slice(0, 300)}`);
  console.log(`    parsed: ${catalogJson ? JSON.stringify(catalogJson).slice(0, 300) : 'NOT JSON'}`);
}
console.log(`  variant the model chose: ${catalogVariant} (the catalog allows only default|success|warning|error)`);
console.log('');

// ---- the verdict ----------------------------------------------------------
const strictVariant = findProp(strictJson, 'variant') ?? null;
const controlVariant = findProp(controlJson, 'variant') ?? null;
// `required` is a CONSTRAINT too, and the route may enforce the shape
// without enforcing the constraints. The two are separate questions.
const strictHasRequired = STRICT_SCHEMA.required.every((k) => topKeys(strictJson).includes(k));
const strictShape = topKeys(strictJson).sort().join(',');
const controlShape = topKeys(controlJson).sort().join(',');

const violatedEnum = strictVariant !== null && strictVariant !== 'danger';
const violatedRequired = !strictHasRequired;

const hasFence = /```/.test(strictText);
const trailingProse = (() => {
  const s = strictText.trim();
  const end = s.lastIndexOf('}');
  return end >= 0 && s.slice(end + 1).trim().length > 0;
})();

console.log('--- CHECKS ---');
console.log(`  enum violated by the strict output : ${violatedEnum ? 'YES' : 'no'} (variant=${strictVariant})`);
console.log(`  "required" honoured by the output   : ${strictHasRequired ? 'yes' : 'NO — missing ' + STRICT_SCHEMA.required.filter((k) => !topKeys(strictJson).includes(k)).join(', ')}`);
console.log(`  code fence in the strict output     : ${hasFence ? 'YES' : 'no'}`);
console.log(`  trailing prose after the JSON       : ${trailingProse ? 'YES' : 'no'}`);
console.log(`  control (no schema) chose          : variant=${controlVariant}`);
console.log(`  shape (informational)             : strict=${strictShape || '(none)'} · control=${controlShape || '(none)'}`);
const catalogUnenforced = catalogVariant !== null && catalogVariant !== null && !['default', 'success', 'warning', 'error'].includes(catalogVariant);
console.log(`  ARM schema's enum honoured          : ${catalogRejected !== null ? 'n/a — REJECTED' : catalogUnenforced ? 'NO — the model emitted variant="' + catalogVariant + '", which the catalog forbids' : 'yes (the output carried a catalog-legal value)'}`);
console.log('');

let verdict;
let enforced;
if (controlVariant === 'success' && violatedEnum) {
  enforced = false;
  verdict =
    'NOT ENFORCED. Without a schema the model answers "success"; with the strict schema it ' +
    'still answers "success" — a value the schema forbids. The schema was in the request and ' +
    'the output ignored it, so this route is NOT constraining the decoder.';
} else if (controlVariant === 'success' && !violatedEnum) {
  enforced = true;
  verdict =
    'ENFORCED. Without a schema the model answers "success"; with the strict schema it answers ' +
    '"danger" — the enum value it did not ask for. The output was coerced to the schema.';
} else if (controlVariant === null) {
  enforced = null;
  verdict =
    'UNDECIDED — the control run did not return a usable variant, so there is nothing to compare ' +
    'the strict run against. Re-run when the route has budget.';
} else {
  enforced = null;
  verdict =
    'UNDECIDED — the control did not choose the invited value, so the strict run cannot be ' +
    'attributed to the schema. Re-run with a prompt the model answers differently.';
}

console.log('--- VERDICT ---');
console.log(`  ${verdict}`);
console.log('');

if (enforced === false) {
  console.log('  WHAT THIS MEANS FOR THE ARMS:');
  console.log('  The schema was sent with strict:true and the route returned an output');
  console.log('  that VIOLATES it. Nothing was coerced, and nothing was rejected:');
  if (violatedEnum) {
    console.log(`  - the enum was violated: variant="${strictVariant}", the schema allows only "danger"`);
  }
  if (violatedRequired) {
    console.log(
      `  - "required" was violated: the output is missing ` +
        `${STRICT_SCHEMA.required.filter((k) => !topKeys(strictJson).includes(k)).join(', ')}`,
    );
  }
  console.log('  So json-object vs strict compares two PROMPTS, not two decoders: the');
  console.log('  strict arm\'s numbers describe a route whose schema was never enforced.');
  console.log('  The requirement metric is unaffected — it scores the tree against the');
  console.log('  spec, not against the schema.');
  console.log('');
}

if (catalogUnenforced) {
  console.log('  AND THE ARM\'S OWN SCHEMA: the model emitted a variant the catalog');
  console.log('  forbids, so the catalog\'s enum constraints are unenforced on this route');
  console.log('  too. The strict arm\'s schema is DECORATIVE here: the compile failures');
  console.log('  it produces (slot_mismatch, invalid_structure) are the ROUTE failing to');
  console.log('  enforce the enum, not the catalog being too loose.');
  console.log('');
}

if (hasFence || trailingProse) {
  console.log('  NOTE: the strict output carries text a constrained decoder should have removed');
  console.log('  (a code fence and/or trailing prose). That is independent evidence that this');
  console.log('  route is not running a constrained decoder, and it corroborates the heal');
  console.log('  causes the strict arm recorded (fence=2, trailingProse=5).');
  console.log('');
}

process.exit(enforced === false ? 1 : 0);
