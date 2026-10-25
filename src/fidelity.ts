/**
 * @p31ca/genui — Semantic Fidelity Harness
 *
 * Measures REQUIREMENT satisfaction against human-authored gold specs.
 * This is the metric that matters: compile-pass is not correctness.
 *
 * THE METRIC IS THE REQUIREMENT, NOT THE TREE (2026-10-22).
 *
 * The harness used to score a generated tree against ONE hand-written gold
 * tree (component multiset F1 + exact-match prop accuracy). That punishes a
 * VALID ALTERNATIVE — a different title, different wording, a different
 * nesting — as hard as a missing component, and it read BACKWARDS: the
 * 12-spec held-out set scored better than the 50-spec dev set. The spec now
 * carries REQUIREMENTS (R1..Rn), and a tree is correct when it satisfies
 * them. The tree-F1 numbers are kept as `legacy*` fields for continuity.
 */

import type { Catalog } from './catalog.ts';
import { compile, type CompileResult } from './compile.ts';
import type { UITreeNode } from './compile.ts';
import { evalRequirements, type Requirement } from './requirements.ts';

export interface GoldSpec {
  prompt: string;
  goldTree: any; // human-authored reference spec
  /** R1..Rn — what the spec requires. See src/requirements.ts. */
  requirements?: Requirement[];
}

export interface FidelityResult {
  prompt: string;
  compiled: boolean;
  /** The correctness number: did the tree satisfy every requirement? */
  requirementsMet: boolean;
  requirementsPassed: number;
  requirementsTotal: number;
  requirementRate: number;
  failedRequirementIds: string[];
  /** LEGACY — the metric that was wrong, kept for continuity. */
  componentF1: number;
  propAccuracy: number;
  semanticallyWrong: boolean; // compiled but a requirement failed
  errors: string[];
  totalTokens: number;
  latencyMs: number;
}

export interface FidelityReport {
  mode: string;
  promptCount: number;
  compilePassRate: number;
  /** Of the compiled trees, the share that satisfied every requirement. */
  requirementPassRate: number;
  avgRequirementRate: number;
  wrongValidSchemaRate: number;
  /** LEGACY */
  avgComponentF1: number;
  avgPropAccuracy: number;
  avgTokens: number;
  avgLatencyMs: number;
  results: FidelityResult[];
}

function extractComponents(tree: any): Set<string> {
  const components = new Set<string>();
  function walk(node: any) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.component === 'string') components.add(node.component);
    if (Array.isArray(node.children)) node.children.forEach(walk);
  }
  walk(tree);
  return components;
}

function componentF1(actual: any, gold: any): number {
  const actualSet = extractComponents(actual);
  const goldSet = extractComponents(gold);
  if (goldSet.size === 0 && actualSet.size === 0) return 1;
  if (goldSet.size === 0 || actualSet.size === 0) return 0;
  const intersection = new Set([...actualSet].filter(c => goldSet.has(c)));
  const precision = intersection.size / actualSet.size;
  const recall = intersection.size / goldSet.size;
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

function propAccuracy(actual: any, gold: any): number {
  if (!actual || !gold) return 0;
  const actualProps = actual.props || {};
  const goldProps = gold.props || {};
  const keys = Object.keys(goldProps);
  if (keys.length === 0) return actualProps && Object.keys(actualProps).length === 0 ? 1 : 0;
  let match = 0;
  for (const key of keys) {
    if (JSON.stringify(actualProps[key]) === JSON.stringify(goldProps[key])) match++;
  }
  return match / keys.length;
}

export async function runFidelityHarness(
  mode: string,
  goldSpecs: GoldSpec[],
  catalog: Catalog,
  modelFn: (prompt: string, options?: { format?: object }) => Promise<{ text: string; tokens: number }>,
  maxRepairs: number = 3
): Promise<FidelityReport> {
  const results: FidelityResult[] = [];

  for (const spec of goldSpecs) {
    const startTime = Date.now();
    let compiled = false;
    let tree: any = null;
    const errors: string[] = [];
    let totalTokens = 0;

    // Import generateUI dynamically to avoid circular deps
    const { generateUI } = await import('./orchestrate.ts');
    const { resolveConstraintMode, buildResponseFormat, schemaForMode } = await import('./capability.ts');

    const constraintMode = resolveConstraintMode('groq', 'qwen/qwen3.8-27b');
    // Mode-aware schema: the strict decoder rejects the loose schema.
    const jsonSchema = schemaForMode(constraintMode, catalog);
    const format = buildResponseFormat(constraintMode, jsonSchema);

    const result = await generateUI(spec.prompt, catalog, modelFn, 'groq', 'qwen/qwen3.8-27b', maxRepairs);
    totalTokens = result.metrics.totalTokens;
    compiled = result.success;
    tree = result.tree;
    if (result.errors) errors.push(...result.errors);

    const f1 = compiled ? componentF1(tree, spec.goldTree) : 0;
    const pa = compiled ? propAccuracy(tree, spec.goldTree) : 0;
    // THE correctness number.
    const reqs = spec.requirements ?? [];
    const tally = compiled ? evalRequirements(tree, reqs) : null;

    results.push({
      prompt: spec.prompt,
      compiled,
      requirementsMet: tally ? tally.allPassed : false,
      requirementsPassed: tally ? tally.passed : 0,
      requirementsTotal: reqs.length,
      requirementRate: tally ? tally.rate : 0,
      failedRequirementIds: tally ? tally.failedIds : [],
      componentF1: f1,
      propAccuracy: pa,
      semanticallyWrong: compiled && tally ? !tally.allPassed : false,
      errors,
      totalTokens,
      latencyMs: Date.now() - startTime,
    });
  }

  const compiledResults = results.filter(r => r.compiled);
  return {
    mode,
    promptCount: results.length,
    compilePassRate: compiledResults.length / results.length,
    requirementPassRate: compiledResults.length > 0
      ? compiledResults.filter(r => r.requirementsMet).length / compiledResults.length
      : 0,
    avgRequirementRate: compiledResults.length > 0
      ? compiledResults.reduce((s, r) => s + r.requirementRate, 0) / compiledResults.length
      : 0,
    wrongValidSchemaRate: compiledResults.length > 0
      ? compiledResults.filter(r => r.semanticallyWrong).length / compiledResults.length
      : 0,
    avgComponentF1: compiledResults.length > 0
      ? compiledResults.reduce((s, r) => s + r.componentF1, 0) / compiledResults.length
      : 0,
    avgPropAccuracy: compiledResults.length > 0
      ? compiledResults.reduce((s, r) => s + r.propAccuracy, 0) / compiledResults.length
      : 0,
    avgTokens: results.reduce((s, r) => s + r.totalTokens, 0) / results.length,
    avgLatencyMs: results.reduce((s, r) => s + r.latencyMs, 0) / results.length,
    results,
  };
}
