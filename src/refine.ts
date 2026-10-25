/**
 * @p31ca/genui — Stateful Refinement
 *
 * Multi-turn artifact maintenance: accept a prior tree, a conversation
 * history, and a new prompt; emit a diff tree plus retained/changed/
 * dropped requirement IDs. This is the EVOGENUI-BENCH pattern.
 */

import type { Catalog } from './catalog.ts';
import { compile, formatErrorsForRepair, type CompileResult } from './compile.ts';
import { buildPlanPrompt, buildConstrainedPrompt, extractPlan } from './plan.ts';
import { schemaForMode } from './capability.ts';
import { healJson } from './heal.ts';
import { resolveConstraintMode, buildResponseFormat, repairResponseFormat, estimateTokens, guardBudget } from './capability.ts';
import { withTimeout, DEFAULT_MODEL_TIMEOUT_MS } from './orchestrate.ts';
import type { UITreeNode } from './compile.ts';

export interface RefineInput {
  priorTree: UITreeNode;
  priorPrompt: string;
  newPrompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Optional requirements for retention tracking. */
  requirements?: Array<{ id: string; assert: (tree: any) => boolean }>;
  /** Max nodes that can change in a refinement (patch-size bound). */
  maxPatchSize?: number;
}

export interface RefineOutput {
  tree: UITreeNode;
  retained: string[];
  changed: string[];
  dropped: string[];
  plan: string;
  metrics: {
    totalTokens: number;
    latencyMs: number;
    repairIterations: number;
    firstPassSuccess: boolean;
    errorCodes: string[];
  };
}

export type ModelFn = (prompt: string, options?: { format?: object }) => Promise<{ text: string; tokens: number }>;

export async function refineUI(
  input: RefineInput,
  catalog: Catalog,
  model: ModelFn,
  provider: string = 'groq',
  modelName: string = 'qwen/qwen3.8-27b',
  maxRepairs: number = 3,
  timeoutMs: number = DEFAULT_MODEL_TIMEOUT_MS
): Promise<RefineOutput> {
  const startTime = Date.now();
  const metrics = {
    totalTokens: 0,
    latencyMs: 0,
    repairIterations: 0,
    firstPassSuccess: false,
    errorCodes: [] as string[],
  };

  // 1. Validate prior tree
  const priorCompile = compile(input.priorTree as any, catalog);
  if (!priorCompile.ok) {
    throw new Error(`Invalid prior tree: ${priorCompile.errors.map(e => e.code).join(', ')}`);
  }

  const componentNames = Object.keys(catalog.components);
  const mode = resolveConstraintMode(provider, modelName);
  // Mode-aware schema: the strict decoder rejects the loose schema.
  const jsonSchema = schemaForMode(mode, catalog);
  const format = buildResponseFormat(mode, jsonSchema);

  // 2. Build refinement prompt (diff-oriented, anchored on prior tree)
  const priorTreeJson = JSON.stringify(input.priorTree, null, 2);
  const historyText = input.history.map(h => `${h.role}: ${h.content}`).join('\n');

  const refinePrompt = `You are editing an existing UI tree. Here is the current tree:

${priorTreeJson}

The user's previous request was: "${input.priorPrompt}"

Conversation history:
${historyText}

New request: "${input.newPrompt}"

Instructions:
- Return the COMPLETE updated tree (not a diff).
- Preserve all nodes that are still valid for the new request.
- Add, modify, or remove nodes as needed to satisfy the new request.
- Use "component" (not "type") for component names.
- Use "content" (not "text") for Text component props.
- Use "label" for Button component props.
- Leaf components (Button, Text, Badge, StatCard, Alert) have NO children.
- Emit only valid JSON matching the catalog schema.

Updated tree:`;

  // 3. Plan step
  const planResponse = await withTimeout(
    model(buildPlanPrompt(input.newPrompt, componentNames)),
    timeoutMs
  );
  metrics.totalTokens += planResponse.tokens;
  const plan = extractPlan(planResponse.text);

  // 4. Constrained emission
  const constrainedPrompt = buildConstrainedPrompt(plan, componentNames);
  const specResponse = await withTimeout(
    model(constrainedPrompt, format ? { format } : undefined),
    timeoutMs
  );
  metrics.totalTokens += specResponse.tokens;

  // Heal JSON
  const healed = healJson(specResponse.text);
  let parsed: unknown = healed.ok ? healed.value : null;

  // 5. Compile
  if (parsed) {
    const result = compile(parsed as any, catalog);
    metrics.repairIterations = 1;
    if (result.ok) {
      metrics.firstPassSuccess = true;
      // Compute retention if requirements are provided.
      const reqs = input.requirements ?? [];
      const diff = reqs.length > 0
        ? computeDiff(input.priorTree, result.tree as UITreeNode, reqs)
        : { retained: [], changed: [], dropped: [] };
      // Patch-size bound: if too many nodes changed, flag it.
      const patchSize = countChangedNodes(input.priorTree, result.tree as UITreeNode);
      if (input.maxPatchSize && patchSize > input.maxPatchSize) {
        metrics.errorCodes.push('patch_size_exceeded');
      }
      metrics.latencyMs = Date.now() - startTime;
      return {
        tree: result.tree as UITreeNode,
        retained: diff.retained,
        changed: diff.changed,
        dropped: diff.dropped,
        plan,
        metrics,
      };
    }
  }

  // 6. Repair loop
  for (let i = 0; i < maxRepairs; i++) {
    const lastErrors = parsed
      ? compile(parsed as any, catalog).errors
      : [{ code: 'invalid_structure' as const, path: 'root', message: 'Invalid JSON', expected: 'valid JSON', received: specResponse.text }];

    const repairPrompt = `Your previous spec failed compilation with these errors:
${formatErrorsForRepair(lastErrors)}

The original plan was:
${plan}

The refinement request was: "${input.newPrompt}"

${(input.requirements ?? []).length > 0 ? `REQUIREMENTS TO PRESERVE (do not drop these):\n${(input.requirements ?? []).map(r => `- ${r.id}`).join('\n')}\n\n` : ''}IMPORTANT: Use "component" (not "type") for the component name field.
Use "content" (not "text") for Text component props.
Use "label" for Button component props.
Leaf components (Button, Text, Badge, StatCard, Alert) have NO children.

Fix the spec to match the plan and the catalog. Emit only the corrected JSON.`;

    // The repair call is a CORRECTION task; a strict decoder rejects it
    // (probed 2026-10-21: 400 json_validate_failed, the model's partial
    // tree echoed in `failed_generation`). It runs under json_object even in
    // strict mode and is validated by the compiler — the gate either way.
    const repairFormat = repairResponseFormat(mode, jsonSchema);
    let repairResponse: { text: string; tokens: number };
    try {
      repairResponse = await withTimeout(
        model(repairPrompt, repairFormat ? { format: repairFormat } : undefined),
        timeoutMs
      );
    } catch {
      // A provider rejection during repair must not erase the accounting of
      // the emission that got us here: record it and stop repairing.
      metrics.errorCodes.push('repair_provider_error');
      break;
    }
    metrics.totalTokens += repairResponse.tokens;
    metrics.repairIterations++;

    const repairHealed = healJson(repairResponse.text);
    if (repairHealed.ok) {
      parsed = repairHealed.value;
    } else {
      continue;
    }

    const result = compile(parsed as any, catalog);
    if (result.ok) {
      const reqs = input.requirements ?? [];
      const diff = reqs.length > 0
        ? computeDiff(input.priorTree, result.tree as UITreeNode, reqs)
        : { retained: [], changed: [], dropped: [] };
      metrics.latencyMs = Date.now() - startTime;
      return {
        tree: result.tree as UITreeNode,
        retained: diff.retained,
        changed: diff.changed,
        dropped: diff.dropped,
        plan,
        metrics,
      };
    }
  }

  metrics.latencyMs = Date.now() - startTime;
  throw new Error(`Refinement failed after ${maxRepairs} repairs`);
}

/**
 * Compute retained/changed/dropped requirement IDs between two trees.
 */
export function computeDiff(
  priorTree: UITreeNode,
  newTree: UITreeNode,
  requirements: Array<{ id: string; assert: (tree: any) => boolean }>
): { retained: string[]; changed: string[]; dropped: string[] } {
  const retained: string[] = [];
  const changed: string[] = [];
  const dropped: string[] = [];

  for (const r of requirements) {
    const wasPassed = r.assert(priorTree);
    const isPassed = r.assert(newTree);

    if (wasPassed && isPassed) {
      retained.push(r.id);
    } else if (wasPassed && !isPassed) {
      dropped.push(r.id);
    } else if (!wasPassed && isPassed) {
      changed.push(r.id);
    }
  }

  return { retained, changed, dropped };
}


/**
 * Count the number of nodes that changed between two trees.
 * Used for patch-size bounding in refineUI.
 */
export function countChangedNodes(prior: any, next: any): number {
  const priorNodes = new Map<string, any>();
  const nextNodes = new Map<string, any>();
  function walk(node: any, map: Map<string, any>, path: string) {
    if (!node || typeof node !== 'object') return;
    const key = `${path}:${node.component}`;
    map.set(key, node);
    if (Array.isArray(node.children)) {
      node.children.forEach((c: any, i: number) => walk(c, map, `${path}.children[${i}]`));
    }
  }
  walk(prior, priorNodes, 'root');
  walk(next, nextNodes, 'root');
  let changed = 0;
  for (const [key, node] of nextNodes) {
    const priorNode = priorNodes.get(key);
    if (!priorNode || JSON.stringify(priorNode.props) !== JSON.stringify(node.props)) {
      changed++;
    }
  }
  // Count removed nodes
  for (const key of priorNodes.keys()) {
    if (!nextNodes.has(key)) changed++;
  }
  return changed;
}
