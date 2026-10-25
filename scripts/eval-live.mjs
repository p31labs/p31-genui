/**
 * Live fidelity harness — the missing OQE.
 *
 * Runs the FULL pipeline against a real model and reports the numbers the
 * offline harness cannot produce:
 *   - compile pass rate (first-pass AND after repair)
 *   - REQUIREMENT satisfaction (the correctness number — see below)
 *   - first-pass rate, repairs per spec, tokens per accepted spec
 *   - wrong-valid rate (compiled, but a requirement failed)
 *   - healed rate, split BY CAUSE (fence / trailing prose / bracket repair)
 *   - APR across multi-turn tasks
 *
 * THE METRIC IS THE REQUIREMENT, NOT THE TREE (2026-10-22).
 *
 * The old correctness number compared the generated tree with ONE gold
 * tree: a component multiset F1 plus an exact-match prop accuracy. That
 * punishes a VALID ALTERNATIVE — a different title, a different label
 * wording, a different nesting — as hard as a missing component, and it
 * produced a number that read BACKWARDS: the 12-spec held-out set scored
 * BETTER than the 50-spec dev set (F1 0.797 vs 0.630). That inversion was
 * a metric artifact, not a model property.
 *
 * Each spec now carries REQUIREMENTS (R1..Rn — the form the APR harness
 * already used): "there is a StatCard", "there are at least 3 of them",
 * "the StatCard's value is 10000", "some text mentions the patient's MRN".
 * A tree is correct when it satisfies the requirements, however else it is
 * arranged. The tree-F1 and exact-prop numbers are STILL REPORTED, but as
 * LEGACY columns: they are the metric that was wrong, kept for continuity
 * with the 2026-10-21 arms, not as the headline.
 *
 * Modes:
 *   --mode=json-object   (default)  the provider's json_object format
 *   --mode=strict                 the provider's strict JSON schema
 *
 * Credentials come from the scoped env, never the command line:
 *   node scripts/with-env.mjs node scripts/eval-live.mjs --mode=json-object
 *
 * The script NEVER prints a key. It reads process.env.GROQ_API_KEY which
 * the loader injected.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { getCatalog } from '../src/catalog.ts';
import { buildContractText } from '../src/plan.ts';
import { compile } from '../src/compile.ts';
import { runAPRHarness } from '../src/apr.ts';
import { generateUI } from '../src/orchestrate.ts';
import { resolveConstraintMode, buildResponseFormat, schemaForMode } from '../src/capability.ts';
import { catalogToJsonSchema, catalogToStrictJsonSchema } from '../src/schema.ts';
import { catalogToAdjacencyStrictJsonSchema } from '../src/adjacency-schema.ts';
import { createProvider } from '../src/provider.ts';
import { getProvider } from '../src/providers.ts';
import { evalRequirements, SCORER_VERSION } from '../src/requirements.ts';
import { fileHash, promptSetHash, requirementSetHash, sha256Hex } from '../src/hashing.ts';
import {
  readCache,
  writeCache,
  recordSuccess,
  recordFailure,
  isDemoted,
  demotionReason,
  defaultCachePath,
} from '../src/capability-cache.ts';

const HERE = dirname(new URL(import.meta.url).pathname);
const catalog = getCatalog();

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};

const MODE = getArg('mode', 'json-object');
// The provider is a CHOICE, not a constant. Groq's daily per-model token cap
// decides how big an arm can be, and OpenRouter and Kilo serve the same
// OpenAI-compatible surface (src/providers.ts records what each one's limits
// are). --base-url / --key-env / --key-json override the registry per run.
const PROVIDER_ID = getArg('provider', 'groq');
const provider = getProvider(PROVIDER_ID);
const MODEL = getArg('model', provider.defaultModel ?? 'qwen/qwen3.8-27b');
const BASE_URL = getArg('base-url', provider.baseUrl);
const PROMPT_FILE = getArg('prompts', resolve(HERE, '../fixtures/live-prompts.json'));
const OUT = getArg('out', resolve(HERE, '../fixtures/live-results.json'));
const LIMIT = parseInt(getArg('limit', '0'), 10);
// The prop-contract arm: the constrained prompt also carries the per-component
// prop table (and, in strict mode, the "emit every key, null the rest" rule).
// The strict decoder's flat props bag cannot express which keys belong to
// which component, so the contract has to travel in the prompt.
// The prompt contract the arm runs.
//
// The contract and the node shape are DEFAULT ON (they are the biggest
// measured lever: held-out compile rate 25% -> 91.7%), and the pipeline
// defaults them on for production too. They stay FLAGS here because a
// measured arm must state which prompt it ran: --no-prop-contract /
// --no-node-shape measure the control, and the report records the
// effective state of every arm.
const PROP_CONTRACT = !args.includes('--no-prop-contract');
// The node shape in the prompt: without it the free-tier models put the
// props next to "component" instead of inside "props", and 100% of prompts
// fail to compile.
const NODE_SHAPE = !args.includes('--no-node-shape');
// The schema DIALECT. 'union-nullable' (the default) is the proven one;
// 'adjacency' and 'adjacency-nullable-free' are the per-component
// hypothesis (a flat node list with an anyOf over per-component prop
// shapes at the array-item level). It is opt-in because a measured arm
// must not change meaning because a file changed — and because the
// hypothesis has to be PROBED per route before it is trusted
// (packages/genui/scripts/probe-schema-dialect.mjs).
const SCHEMA_DIALECT = getArg('schema-dialect', 'union-nullable');

/**
 * --contract-role=user|system — where the CONTRACT travels.
 *
 * 'user' (default) is the historical placement: the shape, the slot table and
 * the prop table sit inside the single user message, which is what every arm
 * measured before this flag existed. 'system' moves the SAME words into their
 * own system message and leaves the task in the user message.
 *
 * The placement is measured, not assumed: a study of local models found the
 * system role materially better for first-attempt validity (1.7% vs 7.9%
 * invalid), but that is a finding about other models on other routes, and the
 * harness measures this one. The repair call is identical in both placements
 * (its prompt restates the rules inline), so the difference this flag buys is
 * confined to the FIRST emission.
 */
const CONTRACT_ROLE = getArg('contract-role', 'user');
if (!['user', 'system'].includes(CONTRACT_ROLE)) {
  console.error(`--contract-role must be 'user' or 'system' (got "${CONTRACT_ROLE}")`);
  process.exit(2);
}

// --- Path 0: the control plane -------------------------------------------
// The budget does not allow a 50-prompt arm in one sitting, so an arm is
// run in DAILY BATCHES. Three flags make that possible:
//
//   --resume            continue the arm in the OUT file: the prompts
//                       already measured are skipped, and the new results
//                       are MERGED into the same file. The file is the
//                       cursor: one source of truth, not two.
//   --max-prompts=N     this batch runs at most N prompts (the daily
//                       budget), then stops cleanly with the cursor intact.
//   --manifest=<path>   write the run manifest: git SHA, the flags, the
//                       prompt-set and requirement-set hashes, the scorer
//                       version, the route, the requested model, the served
//                       models, and what this batch covered.
//
// A resume REFUSES to append to a file whose configuration has changed
// (a different model, mode, contract, prompt set or requirement set):
// silently mixing two configurations in one fixture would make the number
// meaningless, which is the exact failure this whole work is about.
const RESUME = args.includes('--resume');
const MAX_PROMPTS = parseInt(getArg('max-prompts', '0'), 10);
const MANIFEST = getArg('manifest', '');

/**
 * --only=<id,id,…> — measure ONLY these spec ids.
 *
 * The scheduler runs PROMPT-MAJOR: each prompt goes through every arm in
 * turn, so a budget cut leaves the arms PAIRED on the same prompts. This
 * flag is how the scheduler says "this one prompt, this arm".
 */
const ONLY = getArg('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * --circuit-breaker=N — stop the batch after N CONSECUTIVE rate-limit
 * errors. Default 3.
 *
 * A 429 does not fail fast: the provider adapter sleeps and retries, and a
 * DAILY token cap frees tokens slowly (measured ~500 tokens/minute), so a
 * request that needs a couple of thousand tokens can wait minutes. A
 * budget-capped arm therefore burns its whole window sleeping on prompts
 * it was never going to get — which is why the arms ended up recording 19
 * or 20 provider errors in a row. The breaker says: if the provider has
 * refused N times in a row, stop, keep the cursor, and let the next window
 * try again. It is a circuit breaker, not a retry policy: the retries
 * inside a single request are unchanged.
 */
const CIRCUIT_BREAKER = parseInt(getArg('circuit-breaker', '3'), 10);

/**
 * --window-started=<iso> — the start of the SCHEDULER WINDOW this
 * invocation belongs to.
 *
 * The manifest records the window it belongs to, not the invocation: with
 * a prompt-major scheduler an arm is measured over many invocations in
 * one window, and a manifest whose durationMs covers only the last
 * invocation would misstate how long the window took.
 */
const WINDOW_STARTED = getArg('window-started', '');

/**
 * Resolve the API key: the environment first, then the provider's key FILE
 * (opencode keeps its own providers' keys in its auth store, and the estate
 * must not copy them into a shell). A key is never a command-line argument,
 * and its VALUE is never printed — only where it came from.
 */
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
const API_KEY = resolvedKey?.key;
if (!API_KEY) {
  console.error(
    `no API key for provider "${PROVIDER_ID}". Set ${provider.keyEnv} ` +
    '  node scripts/with-env.mjs node scripts/eval-live.mjs'
  );
  process.exit(2);
}

// The constraint mode the RUN actually uses. `--mode` wins over the model's
// allowlist, because the harness must be able to force a mode (that is the
// whole point of the A/B). resolveConstraintMode is the default when the
// flag is absent.
const constraintMode =
  MODE === 'strict' ? 'strict-schema'
  : MODE === 'json-object' ? 'json-object'
  : resolveConstraintMode(PROVIDER_ID, MODEL);

// The schema MUST match the mode. The loose catalog schema is rejected by
// Groq's strict decoder (json_validate_failed) — the strict path never
// worked until 2026-10-21; see catalogToStrictJsonSchema.
const jsonSchema =
  constraintMode === 'strict-schema'
    ? SCHEMA_DIALECT === 'union-nullable'
      ? catalogToStrictJsonSchema(catalog)
      : catalogToAdjacencyStrictJsonSchema(catalog, {
          nullable: SCHEMA_DIALECT !== 'adjacency-nullable-free',
        })
    : catalogToJsonSchema(catalog);
const responseFormat = buildResponseFormat(constraintMode, jsonSchema);

console.log(`mode=${MODE} model=${MODEL} constraintMode=${constraintMode}`);
console.log(`strict=${MODE === 'strict'}`);
console.log(`contractRole=${CONTRACT_ROLE}`);
console.log(
  `provider=${PROVIDER_ID} (${provider.label}) base=${new URL(BASE_URL).host} ` +
    `key=${resolvedKey.from} budget: ${provider.budgetNote}`,
);

// The capability cache: what did we learn about THIS (provider, model,
// schema dialect) combination, and is it demoted?
//
// The dialect is the schema the arm runs under. It is part of the key on
// purpose: a model that implements the loose json-object schema may not
// implement the strict one, and a capability learned under one dialect is
// not evidence about the other.
const DIALECT =
  constraintMode === 'strict-schema' ? `strict:${SCHEMA_DIALECT}` : 'json-object';
const capability = readCache();
const capabilityRecord = { provider: PROVIDER_ID, model: MODEL, dialect: DIALECT };
if (isDemoted(capability, capabilityRecord)) {
  console.log(
    `⚠ capability cache: ${PROVIDER_ID}/${MODEL} (${DIALECT}) is DEMOTED — ` +
      `${demotionReason(capability, capabilityRecord)}. ` +
      'The arm still runs (an eval arm must measure what it was asked to measure), ' +
      'but this run does not prove the combination works.',
  );
}

const startedAt = Date.now();
let totalTokens = 0;
let callCount = 0;
let rateLimitHits = 0;
let retryWaits = 0;

// The provider adapter owns HTTP, retries and rate-limit backoff. The
// per-HTTP-attempt bound is an AbortSignal inside the adapter; the outer
// withTimeout in orchestrate.ts is only a backstop for ModelFns that have
// no bound of their own.
const baseCall = createProvider({
  model: MODEL,
  apiKey: API_KEY,
  baseUrl: BASE_URL,
  headers: provider.headers,
  attemptTimeoutMs: 600_000,
  maxAttempts: 10,
  // Strict mode spends real tokens on the schema's null-prop padding (every
  // prop key must be present, typed nullable), so the cap is higher there.
  // The provider's own body fields (e.g. OpenRouter's
  // `provider.require_parameters: true`, which keeps the router away from
  // the upstreams that IGNORE response_format) are merged UNDER the
  // caller's, so a flag can still override them.
  body: { ...(provider.body ?? {}), temperature: 0.1, max_tokens: MODE === 'strict' ? 4096 : 2048 },
  onRetry: ({ reason, attempt, waitMs }) => {
    if (reason === 'rate_limit') {
      rateLimitHits++;
      retryWaits++;
      console.log(
        `    [429] attempt ${attempt + 1}: waiting ${(waitMs / 1000).toFixed(1)}s for budget reset`
      );
    } else {
      console.log(`    [transport] attempt ${attempt + 1}: retrying in ${(waitMs / 1000).toFixed(1)}s`);
    }
  },
});

// The model that actually SERVED each call. A router (kilo-auto/free,
// openrouter/free) picks per request, so this is the only honest record of
// what an arm ran on.
const servedModels = new Map();

/**
 * Sum two served-model counts.
 *
 * The prior batch's counts and this batch's counts are the same measure over
 * different requests, so the arm's total is their sum. (Reporting only the
 * LAST batch's counts understated the evidence: A1 read "poolside×20" for
 * 119 calls.)
 */
function mergeCounts(priorCounts, thisCounts) {
  const out = new Map();
  for (const [k, v] of Object.entries(priorCounts ?? {})) out.set(k, (out.get(k) ?? 0) + v);
  for (const [k, v] of thisCounts ?? []) out.set(k, (out.get(k) ?? 0) + v);
  return out;
}

/**
 * How many rows were measured under each contract text.
 *
 * A row measured before the harness hashed the text has no hash: it is
 * counted as 'unknown', NOT silently attributed to the current text. An
 * arm that spans two texts (the pre-fix rows and the post-fix rows of the
 * same arm) is therefore visible in the fixture instead of looking
 * uniform.
 */
function contractTextRows(rows) {
  const counts = {};
  for (const r of rows) {
    const h = r.contractTextHash ?? 'unknown';
    counts[h] = (counts[h] ?? 0) + 1;
  }
  return counts;
}

/** Wrap the provider to count tokens and surface rate-limit waits. */
async function modelFn(prompt, options = {}) {
  // The response format applies ONLY to the constrained spec step.
  // The plan step is free-form by design ("reason free, constrain late");
  // forcing json_object onto it makes Groq reject the request with
  // json_validate_failed.
  const format = options.format
    ? MODE === 'strict'
      ? {
          type: 'json_schema',
          json_schema: { name: 'uitree', strict: true, schema: jsonSchema },
        }
      : { type: 'json_object' }
    : undefined;
  // The pin (the model that served the first emission) travels through to
  // the adapter: a router picks per request, and a repair that lands on a
  // different model repairs against a different notion of the catalog.
  const res = await baseCall(prompt, { format, pin: options.pin });
  callCount++;
  totalTokens += res.tokens;
  if (res.servedModel) {
    servedModels.set(res.servedModel, (servedModels.get(res.servedModel) ?? 0) + 1);
  }
  return res;
}

// --------------------------------------------------------------- metrics
/**
 * LEGACY: component MULTISET — every node's component name, with multiplicity.
 *
 * A set-based F1 is vacuous here: a tree with 4 Buttons scored against a
 * gold tree with 1 Button scored 1.0, because both sets are {Button}. The
 * multiset fixed that, but the metric has a worse problem (it punishes a
 * valid alternative), so it is now a LEGACY column: the correctness number
 * is REQUIREMENT satisfaction.
 */
function extractComponents(tree) {
  const out = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (typeof n.component === 'string') out.push(n.component);
    if (Array.isArray(n.children)) n.children.forEach(walk);
  })(tree);
  return out;
}

function componentF1(actual, gold) {
  const a = extractComponents(actual);
  const g = extractComponents(gold);
  if (g.length === 0 && a.length === 0) return 1;
  if (g.length === 0 || a.length === 0) return 0;
  // Multiset intersection: each gold occurrence can be matched once.
  const remaining = new Map();
  for (const c of g) remaining.set(c, (remaining.get(c) || 0) + 1);
  let inter = 0;
  for (const c of a) {
    const n = remaining.get(c) || 0;
    if (n > 0) {
      inter++;
      remaining.set(c, n - 1);
    }
  }
  const p = inter / a.length;
  const r = inter / g.length;
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

/** The node at an index path (e.g. [1,0] = second child of first child). */
function nodeAt(tree, path) {
  let node = tree;
  for (const i of path) {
    if (!node || !Array.isArray(node.children)) return null;
    node = node.children[i];
  }
  return node || null;
}

/**
 * Prop accuracy over the WHOLE tree.
 *
 * Every gold node contributes its prop keys; each key is compared with the
 * prop of the node at the SAME index path in the actual tree and counts only
 * on an exact JSON match. A node the model never produced scores 0 for all
 * of its keys — the tree shape has to be right for the content to count.
 * (The root-only variant of this metric was measured first and read 0.000
 * on the held-out set, where every root happened to differ; it is kept as
 * `rootPropAccuracy` for continuity.)
 */
function propAccuracy(actual, gold) {
  if (!actual || !gold) return 0;
  const paths = [];
  (function walk(node, path) {
    paths.push(path);
    (node.children || []).forEach((c, i) => walk(c, path.concat(i)));
  })(gold, []);

  let match = 0;
  let total = 0;
  for (const path of paths) {
    const g = nodeAt(gold, path);
    const a = nodeAt(actual, path);
    const gp = (g && g.props) || {};
    const ap = (a && a.props) || {};
    for (const k of Object.keys(gp)) {
      total++;
      if (a && JSON.stringify(ap[k]) === JSON.stringify(gp[k])) match++;
    }
  }
  return total === 0 ? 0 : match / total;
}

/** The OLD root-only prop metric, kept for continuity with the first run. */
function rootPropAccuracy(actual, gold) {
  if (!actual || !gold) return 0;
  const ap = actual.props || {};
  const gp = gold.props || {};
  const keys = Object.keys(gp);
  if (keys.length === 0) return Object.keys(ap).length === 0 ? 1 : 0;
  let match = 0;
  for (const k of keys) {
    if (JSON.stringify(ap[k]) === JSON.stringify(gp[k])) match++;
  }
  return match / keys.length;
}

// ------------------------------------------------------------------ run
const prompts = JSON.parse(readFileSync(PROMPT_FILE, 'utf8'));
const specs = LIMIT > 0 ? prompts.slice(0, LIMIT) : prompts;

// A spec with no requirements can only be scored on COMPILE — which is the
// vacuous metric this harness replaced. Refuse to produce a report that
// looks like a fidelity number and is not one.
const withoutRequirements = specs.filter((s) => !(s.requirements ?? []).length);
if (withoutRequirements.length > 0) {
  console.error(
    `refusing to run: ${withoutRequirements.length} spec(s) have no requirements ` +
      `(${withoutRequirements.map((s) => s.id).join(', ')}). ` +
      'Author them (packages/genui/scripts/author-requirements.mjs) and verify with ' +
      'packages/genui/scripts/verify-requirements.mjs.',
  );
  process.exit(2);
}

// --- the arm's configuration fingerprint ----------------------------------
// A resume may only continue an arm that is the SAME arm. The fingerprint
// covers everything that changes what a number means: the route, the
// model, the mode, the prompt contract, the schema dialect, the prompt
// set, the requirement set and the scorer.
const ARM_CONFIG = {
  provider: PROVIDER_ID,
  baseUrl: BASE_URL,
  model: MODEL,
  mode: MODE,
  constraintMode,
  propContract: PROP_CONTRACT,
  nodeShape: NODE_SHAPE,
  schemaDialect: SCHEMA_DIALECT,
  // The contract's ROLE is part of what a number means — but ONLY when it
  // differs from the default. The fingerprint is a hash of this object, so
  // adding the key unconditionally would change the fingerprint of every
  // existing arm and make every in-flight fixture refuse to resume. The
  // default placement is therefore absent from the object, and the hash of
  // the default arm is exactly the hash it had before this flag existed.
  ...(CONTRACT_ROLE !== 'user' ? { contractRole: CONTRACT_ROLE } : {}),
  promptFile: PROMPT_FILE,
  promptSetHash: promptSetHash(prompts),
  // The FULL prompt set, not the sliced one: a batch that runs fewer
  // prompts is the same arm, and a fingerprint that changed with --limit
  // would make every batch look like a different arm.
  requirementSetHash: requirementSetHash(
    prompts.flatMap((s) => s.requirements ?? []),
  ),
  scorerVersion: SCORER_VERSION,
};
const ARM_FINGERPRINT = fileHashOfConfig(ARM_CONFIG);

/**
 * The hash of the CONTRACT TEXT this run sends.
 *
 * The arm fingerprint covers the route, the model, the mode, the flags and
 * the prompt/requirement sets — but NOT the words of the contract. So two
 * runs with identical flags and different contract text are the SAME ARM by
 * fingerprint, while the numbers they produce are not comparable: the
 * contract is the thing being measured. This hash is what makes a change to
 * the contract visible in the arm's provenance, and it is recorded on every
 * row, so an arm that spans two texts says so instead of looking uniform.
 */
const CONTRACT_TEXT_HASH = sha256Hex(
  buildContractText({
    propContract: PROP_CONTRACT,
    nodeShape: NODE_SHAPE,
    strict: constraintMode === 'strict-schema',
    // The adjacency dialect swaps the shape block, so the contract text
    // differs. Mirror the pipeline's own condition (orchestrate.ts:211)
    // exactly, or the hash would describe a prompt the pipeline never sent.
    adjacency: constraintMode === 'strict-schema' && SCHEMA_DIALECT !== 'union-nullable',
    catalog,
  }),
);

function fileHashOfConfig(config) {
  // A stable canonical form: the keys sorted, so the fingerprint does not
  // depend on the order the object literal was written in.
  const canonical = Object.keys(config)
    .sort()
    .map((k) => `${k}=${JSON.stringify(config[k])}`)
    .join('\n');
  return sha256Hex(canonical);
}

// --- resume ---------------------------------------------------------------
// The OUT file is the cursor: the prompts already measured live in it, and
// a new batch skips them and merges into the same file.
let prior = null;
let priorByPrompt = new Map();
if (RESUME && existsSync(OUT)) {
  try {
    prior = JSON.parse(readFileSync(OUT, 'utf8'));
    // A result file with NO fingerprint was measured before the manifest
    // existed: its provenance is UNKNOWN, so appending to it would mix
    // two scorers (and quite possibly two prompt contracts) in one
    // fixture. Refuse.
    if (!prior.armFingerprint) {
      console.error(
        `refusing to resume: ${OUT} has no arm fingerprint — it was measured ` +
          'before the manifest existed, so its provenance is unknown. ' +
          'Move it aside (the legacy arms live in fixtures/legacy-*) and start a new file.',
      );
      process.exit(2);
    }
    if (prior.armFingerprint !== ARM_FINGERPRINT) {
      console.error(
        'refusing to resume: the existing result file was measured with a DIFFERENT configuration.\n' +
          `  existing: ${JSON.stringify(prior.armConfig ?? {})}\n` +
          `  this run: ${JSON.stringify(ARM_CONFIG)}`,
      );
      process.exit(2);
    }
    // The PROMPT TEXT is not in the fingerprint, so a resumed file can
    // carry rows measured under a different contract than this run's. That
    // is legal — it is exactly how a contract fix is measured on an
    // existing arm — but it must never be invisible: the arm then spans two
    // prompt texts, and its rows are not comparable with each other unless
    // the split is read.
    if (prior.contractTextHash && prior.contractTextHash !== CONTRACT_TEXT_HASH) {
      console.log(
        `⚠ contract text CHANGED under the same arm fingerprint: the existing rows were ` +
          `measured under ${prior.contractTextHash.slice(0, 12)}… and this run sends ` +
          `${CONTRACT_TEXT_HASH.slice(0, 12)}…. The arm now spans two prompt texts; the ` +
          'fixture records the split per row (contractTextHash), and the report prints it.',
      );
    }
    // Only a prompt that was MEASURED counts as done. A prompt that died
    // on a provider error (the budget was spent, the provider was down)
    // was never measured, so the next window must try it again — otherwise
    // a budget-capped arm would carry the cap's failures forever and the
    // number would be about the budget, not the pipeline.
    priorByPrompt = new Map(
      (prior.results ?? [])
        .filter((r) => !r.providerError)
        .map((r) => [r.prompt, r]),
    );
    const retryable = (prior.results ?? []).filter((r) => r.providerError).length;
    console.log(
      `resume: ${priorByPrompt.size} prompt(s) already measured in ${OUT}` +
        (retryable > 0 ? `, ${retryable} will be retried (provider error, not measured)` : '') +
        '; this batch continues the same arm',
    );
  } catch (e) {
    console.error(`could not read the existing result file ${OUT}: ${e?.message ?? e}`);
    process.exit(2);
  }
}

const results = [];
let firstPass = 0;
let finalPass = 0;
let healed = 0;
let repairIters = 0;

let batchCount = 0;
// The circuit breaker's counter: CONSECUTIVE rate-limit errors. A single
// 429 is noise (the provider is busy); N in a row means the daily budget
// is gone and every further prompt would sleep instead of measuring.
let consecutiveRateLimits = 0;
let circuitOpened = false;
for (const spec of specs) {
  // --only: the scheduler named the prompt. Everything else is not this
  // invocation's business, and saying so is what keeps a prompt-major
  // schedule from logging every prompt it did not mean to measure.
  if (ONLY.length && !ONLY.includes(spec.id)) continue;
  // Already measured in an earlier batch of this arm: skip it. The
  // resumed file is the cursor, so a batch never re-pays for a prompt.
  if (priorByPrompt.has(spec.prompt)) {
    console.log(`= ${String(spec.id ?? '').padEnd(4)} ${spec.prompt.slice(0, 48)} (already measured — skipped)`);
    continue;
  }
  // The daily budget decides how long this batch is.
  if (MAX_PROMPTS > 0 && batchCount >= MAX_PROMPTS) {
    console.log(
      `--- batch limit reached (${MAX_PROMPTS} prompts); ` +
        'the arm continues in the next window (--resume)',
    );
    break;
  }
  batchCount++;
  const t0 = Date.now();

  // ONE prompt failing must not abort the whole evaluation. A provider
  // error (400 from a schema the model cannot satisfy, 401, a transport
  // failure) is a DATA POINT: it is recorded as a failed prompt and the run
  // continues. The old behaviour (throw → process death) meant a single
  // bad response erased every number the run had produced — which is how a
  // strict run could look "failed" while proving nothing.
  let res;
  try {
    res = await generateUI(
      spec.prompt,
      catalog,
      modelFn,
      'groq',
      MODEL,
      3,
      // The outer backstop: the provider's rate-limit backoff sleeps INSIDE
      // this call, so it has to be long enough for a few patient retries. A
      // DAILY token cap frees tokens slowly (measured ~500 tokens/minute),
      // so a request that needs a couple of thousand tokens can wait minutes.
      // Pinned, never unbounded.
      900_000,
      { propContract: PROP_CONTRACT, nodeShape: NODE_SHAPE, schemaDialect: SCHEMA_DIALECT, contractRole: CONTRACT_ROLE },
    );
  } catch (err) {
    const message = err?.message ?? String(err);
    const code = err?.code ?? err?.status ?? 'provider_error';
    // The CIRCUIT BREAKER. A 429 is the provider saying "not now, and not
    // for a while": the daily cap frees tokens slowly, and the adapter's
    // internal retries sleep for minutes. Left alone, a capped arm spends
    // its whole window asleep and records a column of provider errors
    // instead of measurements. N in a row opens the circuit: this batch
    // stops, the cursor is intact, and the next window tries again.
    //
    // The rate limit arrives in THREE shapes, and all three must trip the
    // breaker: a ProviderRequestError with status 429, a RateLimitError
    // (which carries no status at all — only its message says 429), and a
    // transport error whose message mentions the limit.
    const msg = String(message);
    const rateLimited =
      String(code) === '429' ||
      err?.name === 'RateLimitError' ||
      /\b429\b/.test(msg) ||
      /rate.?limit/i.test(msg);
    if (rateLimited) {
      consecutiveRateLimits++;
      if (CIRCUIT_BREAKER > 0 && consecutiveRateLimits >= CIRCUIT_BREAKER) {
        circuitOpened = true;
        console.log(
          `--- CIRCUIT BREAKER OPEN: ${consecutiveRateLimits} consecutive rate-limit (429) ` +
            `errors — stopping this arm for the window. The cursor is intact; the ` +
            `next window resumes it.`,
        );
      }
    } else {
      consecutiveRateLimits = 0;
    }
    results.push({
      id: spec.id ?? null,
      prompt: spec.prompt,
      compiled: false,
      firstPass: false,
      requirementsTotal: (spec.requirements ?? []).length,
      requirementsPassed: 0,
      requirementRate: 0,
      requirementsMet: false,
      failedRequirementIds: [],
      failedRequirements: [],
      // No tree: the request never reached the model.
      tree: null,
      componentF1: 0,
      propAccuracy: 0,
      rootPropAccuracy: 0,
      semanticallyWrong: false,
      errorCodes: [`provider:${code}`],
      providerError: message.slice(0, 300),
      repairIterations: 0,
      healed: false,
      healKinds: {},
      tokens: 0,
      latencyMs: Date.now() - t0,
      // The contract text this row was measured under. A row without it
      // was measured before the harness hashed the text.
      contractTextHash: CONTRACT_TEXT_HASH,
    });
    console.log(`✗ ${spec.prompt.slice(0, 48).padEnd(50)} provider error: ${message.slice(0, 120)}`);
    // The circuit is open: stop measuring. The rows measured so far in
    // this batch are kept and merged into the cursor, exactly as a
    // clean stop would.
    if (circuitOpened) break;
    continue;
  }
  const compiled = res.success;
  const tree = res.tree || null;
  if (res.metrics.firstPassSuccess) firstPass++;
  if (compiled) finalPass++;
  if (res.metrics.healedCount > 0) healed++;
  repairIters += res.metrics.repairIterations;

  const f1 = compiled ? componentF1(tree, spec.goldTree) : 0;
  const pa = compiled ? propAccuracy(tree, spec.goldTree) : 0;
  const rpa = compiled ? rootPropAccuracy(tree, spec.goldTree) : 0;

  // THE correctness number: the requirements, not the tree.
  const reqs = spec.requirements ?? [];
  const tally = compiled ? evalRequirements(tree, reqs) : null;

  results.push({
    id: spec.id ?? null,
    prompt: spec.prompt,
    compiled,
    firstPass: res.metrics.firstPassSuccess,
    requirementsTotal: reqs.length,
    requirementsPassed: tally ? tally.passed : 0,
    requirementRate: tally ? tally.rate : 0,
    requirementsMet: tally ? tally.allPassed : false,
    failedRequirementIds: tally ? tally.failedIds : [],
    failedRequirements: tally
      ? tally.outcomes
          .filter((o) => !o.passed)
          .map((o) => `${o.id} ${o.assert} (${o.detail})`)
      : [],
    // THE TREE, ARCHIVED.
    //
    // A score whose input is thrown away cannot be re-derived, and an
    // arm whose trees are gone can never be re-scored when the scorer
    // changes — which is exactly why the 2026-10-21 arms can only ever be
    // compared ACROSS runs, never re-scored. This row is the evidence:
    // the thing the number was computed from, kept with the number.
    //
    // It is the COMPILED tree — the same object evalRequirements just
    // scored — so a re-score reproduces the recorded tally exactly.
    //
    // When the tree did NOT compile, the REJECTED tree is archived
    // instead, with the compiler's detailed errors (the path, what was
    // expected, what was received). A compile failure is a diagnosis
    // waiting to happen: the error codes say what was wrong but not which
    // node or which prop value, and without the rejected tree a failure
    // can only be COUNTED, never FIXED.
    tree: compiled ? tree : (res.rejectedTree ?? null),
    // The compiler's own errors, in full — the detail the codes drop.
    compileErrors: compiled ? [] : (res.compileErrors ?? []),
    // LEGACY columns — the metric that was wrong, kept for continuity with
    // the 2026-10-21 arms. Not the headline any more.
    componentF1: f1,
    propAccuracy: pa,
    rootPropAccuracy: rpa,
    // WRONG-VALID now means what the review asked for: the tree compiled
    // (the decoder accepted it) but a REQUIREMENT failed. "The tree differs
    // from one gold tree" is not a defect.
    semanticallyWrong: compiled && tally ? !tally.allPassed : false,
    errorCodes: res.metrics.errorCodes,
    repairIterations: res.metrics.repairIterations,
    healed: res.metrics.healedCount > 0,
    healKinds: res.metrics.healKinds ?? {},
    tokens: res.metrics.totalTokens,
    latencyMs: Date.now() - t0,
    // The contract text this row was measured under. A row without it was
    // measured before the harness hashed the text.
    contractTextHash: CONTRACT_TEXT_HASH,
  });

  const mark = compiled ? (res.metrics.firstPassSuccess ? '✓' : '~') : '✗';
  // A spec that did not compile was NEVER SCORED, and `req=0/0` would
  // read like "this spec has no requirements" — which is a different (and
  // much more serious) thing. The gate refuses a spec with no
  // requirements; a dash says "not measured".
  const reqText = tally ? `${tally.passed}/${tally.total}` : '—';
  console.log(
    `${mark} ${String(spec.id ?? '').padEnd(4)} ${spec.prompt.slice(0, 38).padEnd(40)} ` +
    `req=${reqText} fp=${res.metrics.firstPassSuccess ? 'y' : 'n'} ` +
    `repairs=${res.metrics.repairIterations} ` +
    `heal=${res.metrics.healedCount > 0 ? Object.keys(res.metrics.healKinds ?? {}).join('+') || 'y' : 'n'} ` +
    `f1(legacy)=${f1.toFixed(2)} ${res.metrics.totalTokens}tok`
  );
}

// The arm's results are the MERGED set: this batch plus whatever an
// earlier batch measured. The report describes the ARM, not the batch.
// A retried prompt's old provider-error row is REPLACED by the new row:
// the old row said "we never measured this", and now we have.
const retriedPrompts = new Set(results.map((r) => r.prompt));
const priorKept = prior
  ? (prior.results ?? []).filter((r) => !(r.providerError && retriedPrompts.has(r.prompt)))
  : [];
const allResults = [...priorKept, ...results];
const n = allResults.length;const compiledResults = allResults.filter((r) => r.compiled);
const compiledTokens = compiledResults.reduce((s, r) => s + r.tokens, 0);
const healKinds = {};
for (const r of allResults) {
  for (const [kind, count] of Object.entries(r.healKinds ?? {})) {
    healKinds[kind] = (healKinds[kind] ?? 0) + count;
  }
}
const report = {
  mode: MODE,
  model: MODEL,
  provider: PROVIDER_ID,
  providerLabel: provider.label,
  routed: provider.routed ?? false,
  baseUrl: BASE_URL,
  keySource: resolvedKey.from,
  // The SERVED models, counted over EVERY batch of the arm — not just this
  // invocation. A router picks a model per request, so the served count is
  // the evidence of what the arm actually ran on; an arm measured over
  // several batches reported only the last batch's counts (A1 read
  // "poolside×20" for 119 calls), which understated the evidence.
  servedModels: Object.fromEntries(
    [...mergeCounts(prior?.servedModels, servedModels)].sort((a, b) => b[1] - a[1]),
  ),
  constraintMode,
  schemaDialect: SCHEMA_DIALECT,
  propContract: PROP_CONTRACT,
  nodeShape: NODE_SHAPE,
  // Where the contract travelled. Recorded at the top level so the report
  // can print it in the arm's row: two arms that differ only in the
  // contract's ROLE must be distinguishable in the table, or the A/B reads
  // as one arm.
  contractRole: CONTRACT_ROLE,
  // The contract TEXT's hash, and how many rows were measured under each
  // text. The arm fingerprint does not cover the prompt words, so this is
  // the only record of WHICH prompt produced which row. An arm whose rows
  // span two texts says so here instead of looking uniform.
  contractTextHash: CONTRACT_TEXT_HASH,
  contractTextRows: contractTextRows(allResults),
  promptCount: n,
  firstPassRate: allResults.filter((r) => r.firstPass).length / n,
  compilePassRate: allResults.filter((r) => r.compiled).length / n,

  // ---- THE correctness numbers (requirement-based) ----
  /**
   * END-TO-END SUCCESS — the headline.
   *
   * "requirementPassRate" below is conditional on compiling, so it hides
   * the compile failures inside it. The end-to-end rate counts them: of the
   * prompts that reached the model, the share that produced a tree that
   * compiled AND satisfied every requirement.
   */
  endToEndSuccessRate: (() => {
    const reached = allResults.filter((r) => !r.providerError);
    if (!reached.length) return 0;
    return reached.filter((r) => r.compiled && r.requirementsMet).length / reached.length;
  })(),
  /** How many prompts reached the model — the end-to-end denominator. */
  endToEndReached: allResults.filter((r) => !r.providerError).length,
  /** How many prompts produced a tree that compiled and satisfied every
   *  requirement — the end-to-end numerator. */
  endToEndSucceeded: allResults.filter((r) => r.compiled && r.requirementsMet).length,
  /** Of the trees that compiled, the share that satisfied EVERY requirement. */
  requirementPassRate: compiledResults.length
    ? compiledResults.filter((r) => r.requirementsMet).length / compiledResults.length
    : 0,
  /** Mean fraction of requirements satisfied, over the trees that compiled. */
  avgRequirementRate: compiledResults.length
    ? compiledResults.reduce((s, r) => s + r.requirementRate, 0) / compiledResults.length
    : 0,
  /** Mean number of requirements each compiled tree FAILED. */
  avgRequirementsFailed: compiledResults.length
    ? compiledResults.reduce((s, r) => s + (r.requirementsTotal - r.requirementsPassed), 0) /
      compiledResults.length
    : 0,
  /** Mean number of requirements per spec (the denominator). */
  requirementsPerSpec: results.length
    ? results.reduce((s, r) => s + r.requirementsTotal, 0) / results.length
    : 0,

  // ---- LEGACY (the metric that was wrong; kept for continuity) ----
  avgComponentF1: compiledResults.length
    ? compiledResults.reduce((s, r) => s + r.componentF1, 0) / compiledResults.length
    : 0,
  avgPropAccuracy: compiledResults.length
    ? compiledResults.reduce((s, r) => s + r.propAccuracy, 0) / compiledResults.length
    : 0,
  avgRootPropAccuracy: compiledResults.length
    ? compiledResults.reduce((s, r) => s + r.rootPropAccuracy, 0) / compiledResults.length
    : 0,

  // Compiled, but a requirement failed. "The tree differs from one gold
  // tree" is not a defect; a missing component is.
  wrongValidSchemaRate: compiledResults.length
    ? compiledResults.filter((r) => r.semanticallyWrong).length / compiledResults.length
    : 0,
  healedRate: allResults.filter((r) => r.healed).length / n,
  /** The heal rate split BY CAUSE — a strict arm must be near zero on all. */
  healKinds,
  healKindsRate: Object.fromEntries(
    Object.entries(healKinds).map(([k, v]) => [k, v / n]),
  ),
  avgRepairIterations: allResults.reduce((s2, r) => s2 + (r.repairIterations ?? 0), 0) / n,
  /** Repairs per spec that COMPILED (the cost driver on a free tier). */
  repairsPerAcceptedSpec: compiledResults.length
    ? compiledResults.reduce((s, r) => s + r.repairIterations, 0) / compiledResults.length
    : 0,
  avgTokens: allResults.reduce((s2, r) => s2 + (r.tokens ?? 0), 0) / n,
  /** Tokens per ACCEPTED spec — what a free tier's daily cap actually buys. */
  tokensPerAcceptedSpec: compiledResults.length ? compiledTokens / compiledResults.length : 0,
  avgLatencyMs: allResults.reduce((s2, r) => s2 + (r.latencyMs ?? 0), 0) / n,
  totalTokens: allResults.reduce((s2, r) => s2 + (r.tokens ?? 0), 0),
  callCount: (prior?.callCount ?? 0) + callCount,
  rateLimitHits: (prior?.rateLimitHits ?? 0) + rateLimitHits,
  providerErrorCount: allResults.filter((r) => r.providerError).length,
  armFingerprint: ARM_FINGERPRINT,
  armConfig: ARM_CONFIG,
  armBatches: (prior?.armBatches ?? 0) + 1,
  results: allResults,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2));

// --- the run manifest ----------------------------------------------------
// "No number without a manifest." The manifest says what produced the
// numbers: the commit, the flags, the prompt set, the requirement set, the
// scorer, the route, the model that was asked for and the model that
// answered. Without it a result file is a number; with it, it is evidence.
if (MANIFEST) {
  // The manifest describes the WINDOW, not the invocation: with a
  // prompt-major schedule one window is many invocations, and a duration
  // that covered only the last one would misstate the window.
  const windowStart = WINDOW_STARTED ? Date.parse(WINDOW_STARTED) : startedAt;
  const manifest = {
    arm: `${PROVIDER_ID}/${MODEL}/${MODE}/${SCHEMA_DIALECT}${CONTRACT_ROLE !== 'user' ? `/${CONTRACT_ROLE}-role` : ''}`,
    startedAt: new Date(windowStart).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - windowStart,
    gitSha: gitSha(),
    gitDirty: gitDirty(),
    route: { provider: PROVIDER_ID, baseUrl: BASE_URL, keySource: resolvedKey.from },
    model: { requested: MODEL, served: report.servedModels },
    mode: MODE,
    constraintMode,
    promptContract: { propContract: PROP_CONTRACT, nodeShape: NODE_SHAPE, contractRole: CONTRACT_ROLE },
    // The words of the contract this run sent. The arm fingerprint does
    // not cover them, so the manifest is where a change to the prompt text
    // becomes visible.
    contractTextHash: CONTRACT_TEXT_HASH,
    schemaDialect: SCHEMA_DIALECT,
    scorerVersion: SCORER_VERSION,
    armFingerprint: ARM_FINGERPRINT,
    artifacts: {
      promptFile: PROMPT_FILE,
      promptSetHash: ARM_CONFIG.promptSetHash,
      requirementSetHash: ARM_CONFIG.requirementSetHash,
    },
    batch: {
      index: report.armBatches,
      resumed: Boolean(prior),
      promptsInThisBatch: batchCount,
      promptsInArm: n,
      skippedAlreadyMeasured: priorByPrompt.size,
      // The window this invocation belongs to. With a PROMPT-MAJOR
      // scheduler one window is many invocations, and a manifest that
      // recorded only the last invocation's duration would misstate how
      // long the window took.
      windowStartedAt: WINDOW_STARTED || null,
      circuitBreakerOpen: circuitOpened,
    },
    totals: {
      prompts: n,
      compiled: compiledResults.length,
      reachedTheModel: n - report.providerErrorCount,
      modelCalls: report.callCount,
      tokens: report.totalTokens,
      rateLimitHits: report.rateLimitHits,
      providerErrors: report.providerErrorCount,
    },
    metrics: {
      firstPassRate: report.firstPassRate,
      compilePassRate: report.compilePassRate,
      requirementPassRate: report.requirementPassRate,
      avgRequirementRate: report.avgRequirementRate,
      wrongValidSchemaRate: report.wrongValidSchemaRate,
      healedRate: report.healedRate,
      healKinds: report.healKinds,
      avgRepairIterations: report.avgRepairIterations,
      repairsPerAcceptedSpec: report.repairsPerAcceptedSpec,
      tokensPerAcceptedSpec: report.tokensPerAcceptedSpec,
    },
  };
  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest written to:   ${MANIFEST}`);
}

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function gitDirty() {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    return out.length > 0;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- capability
// What did this arm learn about (provider, model, dialect)?
//
// The classification matters: a 404 (the model is gone), a 403 (it is not
// allowed) and an EMPTY completion (it answers with nothing) are the
// MODEL's fault and demote it. A 429 is the ACCOUNT's fault — the budget
// is spent, the model is fine — and must NOT demote a working model: that
// is how a good model gets thrown out because the credits ran out.
const providerErrorCodes = allResults
  .flatMap((r) => (r.errorCodes ?? []).filter((c) => c.startsWith('provider:')))
  .map((c) => c.slice('provider:'.length));
const demotingReasons = providerErrorCodes.filter((c) =>
  c === '404' || c === '403' || c === '200',
);
const budgetOnly =
  providerErrorCodes.length > 0 &&
  providerErrorCodes.every((c) => c === '429');
if (demotingReasons.length > 0) {
  recordFailure(capability, capabilityRecord, `provider error ${demotingReasons[0]}`, {
    demoting: true,
  });
  console.log(
    `⚠ capability cache: ${PROVIDER_ID}/${MODEL} (${DIALECT}) DEMOTED — provider error ${demotingReasons[0]}`,
  );
} else if (budgetOnly) {
  console.log(
    `ℹ capability cache: ${PROVIDER_ID}/${MODEL} (${DIALECT}) not demoted — ` +
      'the failures are 429s (the BUDGET is spent, not the model)',
  );
} else if (report.providerErrorCount === 0 && report.promptCount > 0) {
  recordSuccess(capability, capabilityRecord);
}
writeCache(capability);

console.log('');
console.log('=== LIVE FIDELITY REPORT ===');
console.log(`mode:                  ${report.mode} (constraintMode=${report.constraintMode})`);
console.log(`model:                 ${report.model}`);
console.log(
  `provider:              ${report.provider} (${report.providerLabel})` +
    (report.routed ? ' — ROUTED: the model is picked per request' : ''),
);
const served = Object.entries(report.servedModels ?? {});
console.log(
  `served model(s):       ${
    served.length
      ? served.map(([m, c]) => `${m} ×${c}`).join(', ')
      : '(none reported)'
  }`,
);
console.log(`prop contract:         ${report.propContract ? 'on (per-component prop table in the prompt)' : 'off'}`);
console.log(`node shape in prompt:  ${report.nodeShape ? 'on' : 'off'}`);
console.log(`schema dialect:        ${report.schemaDialect}`);
console.log(`prompts:               ${report.promptCount}`);
console.log(`first-pass rate:       ${(report.firstPassRate * 100).toFixed(1)}%`);
console.log(`compile pass rate:     ${(report.compilePassRate * 100).toFixed(1)}%`);
console.log(
  `requirement pass rate: ${(report.requirementPassRate * 100).toFixed(1)}%  ` +
    `(every requirement met, of the trees that compiled)`,
);
console.log(
  `avg requirement rate:  ${(report.avgRequirementRate * 100).toFixed(1)}%  ` +
    `(${report.requirementsPerSpec.toFixed(1)} requirements per spec, ` +
    `${report.avgRequirementsFailed.toFixed(2)} failed on average)`,
);
console.log(`wrong-valid rate:      ${(report.wrongValidSchemaRate * 100).toFixed(1)}%  (compiled, a requirement failed)`);
console.log(`repairs per spec:      ${report.avgRepairIterations.toFixed(2)}  (per accepted spec: ${report.repairsPerAcceptedSpec.toFixed(2)})`);
console.log(`tokens per accepted:   ${report.tokensPerAcceptedSpec.toFixed(0)}`);
console.log(`healed rate:           ${(report.healedRate * 100).toFixed(1)}%  ` +
  `by cause: ${Object.entries(report.healKinds).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`);
console.log(`avg component F1:      ${report.avgComponentF1.toFixed(3)}  (LEGACY — superseded by the requirement rate)`);
console.log(`avg prop accuracy:     ${report.avgPropAccuracy.toFixed(3)}  (LEGACY — whole tree, path-matched)`);
console.log(`avg root prop accuracy: ${report.avgRootPropAccuracy.toFixed(3)}  (LEGACY — root node only)`);
console.log(`avg tokens:            ${report.avgTokens.toFixed(0)}`);
console.log(`avg latency:           ${report.avgLatencyMs.toFixed(0)}ms`);
console.log(`rate-limit hits:       ${report.rateLimitHits}`);
console.log(`total tokens:          ${report.totalTokens}`);
console.log(`results written to:    ${OUT}`);
if (circuitOpened) {
  // A DISTINCT exit code, so the scheduler can tell "this arm is done for
  // the window" from "this arm failed". 75 is EX_TEMPFAIL: the work is
  // incomplete and can be resumed, which is exactly what the cursor is for.
  console.log('circuit breaker:        OPEN (this arm stops here; the next window resumes it)');
  process.exit(75);
}
