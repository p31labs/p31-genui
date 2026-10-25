/**
 * @p31ca/genui — Full Pipeline Orchestrator
 *
 * Plan → Constrain → Compile → Repair
 *
 * Provider-aware: resolves constraint mode per provider/model,
 * heals JSON locally before parsing, bounds repair at 3 iterations.
 */

import type { Catalog } from './catalog.ts';
import { compile, formatErrorsForRepair, type CompileResult } from './compile.ts';
import { buildPlanPrompt, buildConstrainedPrompt, buildConstrainedMessages, extractPlan, type ContractRole } from './plan.ts';
import { schemaForMode } from './capability.ts';
import { healJson } from './heal.ts';
import {
  catalogToAdjacencyStrictJsonSchema,
  adjacencyToTree,
  type SchemaDialect,
} from './adjacency-schema.ts';
import { resolveConstraintMode, buildResponseFormat, repairResponseFormat, estimateTokens, guardBudget, FALLBACK_CHAINS } from './capability.ts';

export interface PipelineMetrics {
  planTokens: number;
  specTokens: number;
  repairIterations: number;
  firstPassSuccess: boolean;
  finalSuccess: boolean;
  errorCodes: string[];
  totalTokens: number;
  latencyMs: number;
  constraintMode: string;
  healedCount: number;
  /**
   * WHICH repair healed it (see src/heal.ts). One "healed" number cannot
   * say whether a route is really constrained: a strict decoder that still
   * needs fence-stripping is not constrained the way the report claims.
   */
  healKinds: Record<string, number>;
  /**
   * The model that SERVED the constrained emission. A router picks per
   * request, so this is the only honest record of what answered, and the
   * repair step pins it so the repair lands on the same model.
   */
  servedModel?: string;
}

export interface PipelineResult {
  success: boolean;
  tree?: CompileResult['tree'];
  /**
   * THE REJECTED TREE — the last tree the compiler refused.
   *
   * A compile failure is a DIAGNOSIS waiting to happen: the error codes
   * say WHAT was wrong (`slot_mismatch`, `invalid_structure`) but not
   * WHICH node, WHICH prop, or WHICH value. Without the rejected tree a
   * failure can only be COUNTED, never FIXED — and because the trees were
   * discarded, the 2026-10-21 failures are unrecoverable for good. This
   * is what makes the next window's failures diagnosable.
   */
  rejectedTree?: unknown;
  /**
   * The compiler's errors for the rejected tree, with the path, the
   * message, what was expected and what was received. The detail the
   * error CODES throw away.
   */
  compileErrors?: CompileResult['errors'];
  plan: string;
  metrics: PipelineMetrics;
  errors?: string[];
}

export type ModelFn = (
  prompt: string,
  options?: { format?: object; pin?: string; system?: string },
) => Promise<{ text: string; tokens: number; servedModel?: string }>;

/**
 * Default per-call model timeout, in ms.
 *
 * This is an OUTER BACKSTOP for callers that supply a ModelFn with no
 * timeout of its own. It is deliberately generous, because a metered
 * provider may need to sleep through a rate-limit reset (Groq's free tier
 * advertises a ~44s token-budget reset) before it can answer. The precise
 * per-request bound lives in the provider adapter (createProvider), which
 * uses AbortSignal on each HTTP attempt — see ./provider.ts.
 *
 * The 3-hour stuck local-runner incident is why this exists at all: a
 * provider that never answers must not hold the whole turn open.
 */
export const DEFAULT_MODEL_TIMEOUT_MS = 180_000;

export class ModelTimeoutError extends Error {
  constructor(ms: number) {
    super(`model call timed out after ${ms}ms`);
    this.name = 'ModelTimeoutError';
  }
}

/**
 * Wrap a model call with a hard timeout. The underlying promise is not
 * cancellable (ModelFn has no AbortSignal), but the caller stops waiting,
 * which is what keeps the pipeline bounded.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number = DEFAULT_MODEL_TIMEOUT_MS
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ModelTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface GenerateOptions {
  /**
   * Give the model the per-component prop contract in the constrained prompt.
   *
   * DEFAULT ON in production (2026-10-22): the held-out A/B measured the
   * contract as the biggest single lever (compile rate 25% -> 91.7% on a
   * set the pipeline had never seen), so a production call that does not
   * ask for it is asking for the worse behaviour. The eval harness passes
   * it EXPLICITLY (true or false) because a measured arm must state which
   * prompt it ran — that is why the flag is still a flag and not a constant.
   */
  propContract?: boolean;
  /**
   * State the node shape in the constrained prompt.
   *
   * DEFAULT ON for the same reason: without it the free-tier models put the
   * props next to "component" instead of inside "props", and 100% of
   * prompts failed to compile (measured 2026-10-21).
   */
  nodeShape?: boolean;
  /**
   * The schema dialect. 'union-nullable' (the default) is the proven one;
   * 'adjacency' and 'adjacency-nullable-free' are the per-component
   * hypothesis (see src/adjacency-schema.ts) and are opt-in.
   */
  schemaDialect?: SchemaDialect;
  /**
   * Where the CONTRACT travels: in the user message (default, historical) or
   * in its own system message.
   *
   * DEFAULT 'user' so production behaviour — and every existing arm's
   * fingerprint — is untouched. The 'system' placement is a MEASURED
   * experiment (the harness's --contract-role), not a default: a study of
   * local models found the system role materially better for first-attempt
   * validity (1.7% vs 7.9% invalid), but that is a finding about other
   * models, and this pipeline measures its own.
   */
  contractRole?: ContractRole;
}

export async function generateUI(
  userPrompt: string,
  catalog: Catalog,
  model: ModelFn,
  provider: string = 'groq',
  modelName: string = 'qwen/qwen3.8-27b',
  maxRepairs: number = 3,
  timeoutMs: number = DEFAULT_MODEL_TIMEOUT_MS,
  options: GenerateOptions = {}
): Promise<PipelineResult> {
  const startTime = Date.now();
  const metrics: PipelineMetrics = {
    planTokens: 0,
    specTokens: 0,
    repairIterations: 0,
    firstPassSuccess: false,
    finalSuccess: false,
    errorCodes: [],
    totalTokens: 0,
    latencyMs: 0,
    constraintMode: resolveConstraintMode(provider, modelName),
    healedCount: 0,
    healKinds: {},
  };

  const componentNames = Object.keys(catalog.components);

  // Step 1: Plan (free-form, unconstrained)
  const planResponse = await withTimeout(
    model(buildPlanPrompt(userPrompt, componentNames)),
    timeoutMs
  );
  metrics.planTokens = planResponse.tokens;
  metrics.totalTokens += planResponse.tokens;
  const plan = extractPlan(planResponse.text);

  // Step 2: Constrained emission (given plan) with provider fallback
  const mode = resolveConstraintMode(provider, modelName);
  // The schema must match the mode: the strict decoder rejects the loose
  // schema outright (json_validate_failed) and vice versa.
  //
  // The DIALECT is the schema's spelling. The default ('union-nullable') is
  // the one that was probed and proven; the adjacency dialects are the
  // per-component hypothesis and are opt-in, because a measured arm must
  // not change meaning because a file changed.
  const dialect: SchemaDialect = options.schemaDialect ?? 'union-nullable';
  const jsonSchema =
    mode === 'strict-schema' && dialect !== 'union-nullable'
      ? catalogToAdjacencyStrictJsonSchema(catalog, { nullable: dialect !== 'adjacency-nullable-free' })
      : schemaForMode(mode, catalog);
  const adjacencyDialect = mode === 'strict-schema' && dialect !== 'union-nullable';
  const format = buildResponseFormat(mode, jsonSchema);
  const constrained = buildConstrainedMessages(plan, componentNames, {
    // DEFAULT ON in production; the eval harness passes the flags
    // explicitly (true or false) so a measured arm always says which
    // prompt it ran.
    propContract: options.propContract ?? true,
    nodeShape: options.nodeShape ?? true,
    strict: mode === 'strict-schema',
    adjacency: adjacencyDialect,
    // Where the contract travels. The default keeps the historical single
    // user message; 'system' splits the contract into its own system
    // message (the words are identical — only the role changes).
    contractRole: options.contractRole ?? 'user',
    catalog,
  });
  // The whole text the model sees, for the budget estimate: with the
  // contract split out, the user message alone understates the prompt.
  const constrainedPrompt = constrained.system
    ? `${constrained.system}\n${constrained.user}`
    : constrained.user;

  // Fallback chain: try primary, then fallback on 429/transport error
  const chain = FALLBACK_CHAINS[mode] || [{ provider, model: modelName }];
  let specResponse: { text: string; tokens: number; servedModel?: string } | null = null;
  let usedProvider = provider;
  let usedModel = modelName;

  for (const entry of chain) {
    try {
      specResponse = await withTimeout(
        model(
          constrained.user,
          {
            ...(format ? { format } : {}),
            ...(constrained.system ? { system: constrained.system } : {}),
          },
        ),
        timeoutMs
      );
      usedProvider = entry.provider;
      usedModel = entry.model;
      break;
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('429') || msg.includes('rate') || msg.includes('budget_exceeded') || msg.includes('timeout')) {
        console.warn(`[genui] Fallback: ${entry.provider}/${entry.model} failed (${msg}), trying next`);
        continue;
      }
      throw e; // non-transport error: propagate
    }
  }

  if (!specResponse) {
    metrics.latencyMs = Date.now() - startTime;
    return { success: false, plan, metrics, errors: ['all_providers_failed'] };
  }

  // THE SERVED MODEL, remembered for the repair.
  //
  // A router picks a model per request, so the repair can land on a
  // DIFFERENT model than the one that produced the tree being repaired —
  // and a different model means a different notion of what the catalog
  // looks like. The repair therefore asks for the model that SERVED the
  // first emission (measured 2026-10-22, the review's point about random
  // routing). The pin is best-effort: a provider that refuses the pinned
  // model falls back to the unpinned request.
  const servedModel = specResponse.servedModel;
  metrics.servedModel = servedModel;

  const estimated = estimateTokens(constrainedPrompt, jsonSchema, 512);
  try {
    guardBudget(modelName, estimated);
  } catch (e) {
    metrics.latencyMs = Date.now() - startTime;
    return { success: false, plan, metrics, errors: [String(e)] };
  }

  metrics.specTokens = specResponse!.tokens;
  metrics.totalTokens += specResponse.tokens;

  // Heal JSON locally before parsing
  const healed = healJson(specResponse.text);
  if (healed.ok && healed.value !== undefined) {
    if (healed.kinds.length > 0) {
      metrics.healedCount++;
      for (const kind of healed.kinds) {
        metrics.healKinds[kind] = (metrics.healKinds[kind] ?? 0) + 1;
      }
    }
  }

  let parsed: unknown = healed.ok ? healed.value : null;

  // The ADJACENCY dialect speaks a flat node list; the compiler speaks
  // trees. Convert before compiling — and refuse a malformed list loudly,
  // because a partial tree would score as a missing component and hide the
  // real defect.
  const toTree = (value: unknown): { ok: boolean; tree?: any; error?: string } => {
    if (!adjacencyDialect) return { ok: true, tree: value };
    const converted = adjacencyToTree(value);
    if (!converted.ok) return { ok: false, error: converted.error };
    return { ok: true, tree: converted.tree };
  };

  // Step 3: Compile
  if (parsed) {
    const converted = toTree(parsed);
    if (!converted.ok) {
      metrics.errorCodes = ['invalid_structure'];
      metrics.repairIterations = 1;
      parsed = null;
    } else {
      parsed = converted.tree;
      const result = compile(parsed as any, catalog);
      metrics.repairIterations = 1;
      if (result.ok) {
        metrics.firstPassSuccess = true;
        metrics.finalSuccess = true;
        metrics.latencyMs = Date.now() - startTime;
        return { success: true, tree: result.tree, plan, metrics };
      }
      metrics.errorCodes = result.errors.map(e => e.code);
    }
  } else {
    metrics.errorCodes = ['invalid_structure'];
  }

  // Step 4: Repair loop (plan-anchored, bounded at maxRepairs)
  for (let i = 0; i < maxRepairs; i++) {
    const lastErrors = parsed
      ? compile(parsed as any, catalog).errors
      : [{ code: 'invalid_structure' as const, path: 'root', message: 'Invalid JSON', expected: 'valid JSON', received: specResponse.text }];

    const repairPrompt = `Your previous spec failed compilation with these errors:
${formatErrorsForRepair(lastErrors)}

The original plan was:
${plan}

IMPORTANT: Use "component" (not "type") for the component name field.
Use "content" (not "text") for Text component props.
Use "label" for Button component props.
Leaf components (Button, Text, Badge, StatCard, Alert) have NO children.
${adjacencyDialect ? 'Keep the FLAT node list shape: {"nodes":[{"id","component","props","childIds"}]}. The first node is the root.\n' : ''}
Fix the spec to match the plan and the catalog. Emit only the corrected JSON.`;

    // The repair call is a CORRECTION task; a strict decoder rejects it
    // (probed 2026-10-21: 400 json_validate_failed). It runs under
    // json_object and is validated by the compiler — the gate either way.
    //
    // The repair prompt is IDENTICAL in both contract placements: it restates
    // the rules inline ("Use component not type", "Leaf components have NO
    // children"), so it does not carry the contract block and it does not get
    // a system message. That keeps the role A/B confined to the FIRST
    // emission — the one the placement can change.
    const repairFormat = repairResponseFormat(mode, jsonSchema);
    let repairResponse: { text: string; tokens: number; servedModel?: string };
    try {
      repairResponse = await withTimeout(
        model(
          repairPrompt,
          repairFormat
            ? { format: repairFormat, ...(servedModel ? { pin: servedModel } : {}) }
            : servedModel
              ? { pin: servedModel }
              : undefined,
        ),
        timeoutMs
      );
    } catch (e: any) {
      // A provider rejection during repair must not erase the accounting of
      // the first emission: record it and stop repairing.
      metrics.errorCodes.push('repair_provider_error');
      break;
    }
    metrics.totalTokens += repairResponse.tokens;
    metrics.repairIterations++;

    const repairHealed = healJson(repairResponse.text);
    if (repairHealed.ok) {
      const converted = toTree(repairHealed.value);
      if (!converted.ok) {
        metrics.errorCodes.push('invalid_structure');
        continue;
      }
      parsed = converted.tree;
      if (repairHealed.kinds.length > 0) {
        metrics.healedCount++;
        for (const kind of repairHealed.kinds) {
          metrics.healKinds[kind] = (metrics.healKinds[kind] ?? 0) + 1;
        }
      }
    } else {
      metrics.errorCodes.push('invalid_structure');
      continue;
    }

    const result = compile(parsed as any, catalog);
    if (result.ok) {
      metrics.finalSuccess = true;
      metrics.latencyMs = Date.now() - startTime;
      return { success: true, tree: result.tree, plan, metrics };
    }
    metrics.errorCodes = [...new Set([...metrics.errorCodes, ...result.errors.map(e => e.code)])];
  }

  metrics.latencyMs = Date.now() - startTime;
  return {
    success: false,
    plan,
    metrics,
    errors: metrics.errorCodes,
    // The tree the compiler refused, and the compiler's own errors with
    // their paths — kept so a failure can be diagnosed instead of only
    // counted.
    rejectedTree: parsed ?? null,
    compileErrors: parsed
      ? compile(parsed as any, catalog).errors
      : [
          {
            code: 'invalid_structure' as const,
            path: 'root',
            message: 'Invalid JSON',
            expected: 'valid JSON',
            received: specResponse.text,
          },
        ],
  };
}
