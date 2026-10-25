/**
 * @p31ca/genui — Provider Capability Resolver
 *
 * Model-allowlist: strict mode is per-model, not per-provider.
 * Groq strict: only openai/gpt-oss-20b, 120b, safeguard-20b.
 * All others: json-object (best-effort; compiler is the gate).
 */

export type ConstraintMode = 'strict-schema' | 'json-object' | 'prompt-only';

import type { Catalog } from './catalog.ts';
import { catalogToJsonSchema, catalogToStrictJsonSchema } from './schema.ts';

// Model allowlist for strict JSON schema mode (per provider)
const STRICT_MODELS: Record<string, Set<string>> = {
  groq: new Set(['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'openai/gpt-oss-safeguard-20b']),
  kilo: new Set(['openai/gpt-oss-20b']),
  openai: new Set(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano']),
  cerebras: new Set(['llama-3.3-70b']),
};

// TPM limits per model (free tier)
export const TPM_LIMITS: Record<string, number> = {
  'qwen/qwen3.8-27b': 8000,
  'openai/gpt-oss-20b': 8000,
  'openai/gpt-oss-120b': 8000,
  'openai/gpt-oss-safeguard-20b': 8000,
  'allam-2-7b': 8000,
};

// Fallback chains per constraint mode
export const FALLBACK_CHAINS: Record<ConstraintMode, Array<{ provider: string; model: string }>> = {
  'strict-schema': [
    { provider: 'groq', model: 'openai/gpt-oss-20b' },
    { provider: 'kilo', model: 'openai/gpt-oss-20b' },
  ],
  'json-object': [
    { provider: 'groq', model: 'qwen/qwen3.8-27b' },
    { provider: 'kilo', model: 'qwen/qwen3.8-27b' },
  ],
  'prompt-only': [
    { provider: 'groq', model: 'qwen/qwen3.8-27b' },
  ],
};

export function resolveConstraintMode(provider: string, model: string): ConstraintMode {
  if (STRICT_MODELS[provider]?.has(model)) return 'strict-schema';
  return 'json-object';
}

export function buildResponseFormat(mode: ConstraintMode, schema: object): object | undefined {
  if (mode === 'strict-schema') {
    return { type: 'json_schema', json_schema: { name: 'ui_spec', strict: true, schema } };
  }
  if (mode === 'json-object') {
    return { type: 'json_object' };
  }
  return undefined;
}

/**
 * The schema a given constraint mode must use.
 *
 * The strict decoder is STRICTER than the loose schema: it demands
 * `required` to list every key in `properties` and a non-empty `properties`
 * map on every object. The loose catalog schema violates that (its props bag
 * is an empty closed object), so sending it in strict mode gets the request
 * rejected with `json_validate_failed` — the strict path was never exercised
 * before 2026-10-21 and it did not work. See catalogToStrictJsonSchema.
 */
export function schemaForMode(mode: ConstraintMode, catalog: Catalog): object {
  return mode === 'strict-schema'
    ? catalogToStrictJsonSchema(catalog)
    : catalogToJsonSchema(catalog);
}

/**
 * The format the REPAIR step uses.
 *
 * A strict decoder cannot express "fix this tree". Probed 2026-10-21
 * (gpt-oss-20b): the first emission under the strict schema succeeds, but
 * the REPAIR prompt — which asks the model to correct a broken spec — is
 * rejected by the provider with `json_validate_failed`, the model's own
 * partial tree echoed back in `failed_generation`. The constrained grammar
 * fights the correction task.
 *
 * So the repair step runs under `json_object` even in strict mode. The
 * compiler (not the decoder) is the gate in both modes, which keeps the
 * json-object vs strict comparison apples-to-apples: same compiler, same
 * repair semantics, one difference — whether the FIRST emission is
 * decoder-constrained.
 */
export function repairResponseFormat(mode: ConstraintMode, schema: object): object | undefined {
  if (mode === 'strict-schema') return { type: 'json_object' };
  return buildResponseFormat(mode, schema);
}

export function estimateTokens(prompt: string, schema: object, maxOutput: number): number {
  return Math.ceil(prompt.length / 4) + Math.ceil(JSON.stringify(schema).length / 3) + maxOutput;
}

export function guardBudget(model: string, estimated: number): void {
  const tpm = TPM_LIMITS[model] ?? 8000;
  if (estimated > tpm) {
    throw new Error(`budget_exceeded: ${estimated} > ${tpm} TPM for ${model}`);
  }
}
