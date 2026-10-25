/**
 * @p31ca/genui — Adjacent Pass Retention (APR) Harness
 *
 * Measures multi-turn artifact maintenance: a requirement that passes
 * in turn n must still pass in turn n+1. This is the EVOGENUI-BENCH metric.
 */

import type { Catalog } from './catalog.ts';
import type { UITreeNode } from './compile.ts';
import type { ModelFn } from './refine.ts';
import { refineUI, computeDiff } from './refine.ts';

export interface APRRequirement {
  id: string;
  assert: (tree: any) => boolean;
}

export interface APRTurn {
  prompt: string;
  goldTree: any;
  requirements: APRRequirement[];
}

export interface APRTask {
  id: string;
  turns: APRTurn[];
}

export interface APRResult {
  taskId: string;
  turnCount: number;
  turnPass: number;
  episodeComplete: boolean;
  apr: number;
  retained: string[];
  dropped: string[];
  errors: string[];
}

export interface APRReport {
  taskCount: number;
  avgTurnPass: number;
  episodeCompletionRate: number;
  avgAPR: number;
  results: APRResult[];
}

export async function runAPRHarness(
  tasks: APRTask[],
  catalog: Catalog,
  model: ModelFn,
  provider: string = 'groq',
  modelName: string = 'qwen/qwen3.8-27b'
): Promise<APRReport> {
  const results: APRResult[] = [];

  for (const task of tasks) {
    const errors: string[] = [];
    let currentTree: UITreeNode | null = null;
    let priorPrompt = '';
    const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    const allRequirements: APRRequirement[] = [];
    const passed = new Set<string>();

    let turnPassCount = 0;
    let dropped: string[] = [];
    let retained: string[] = [];

    for (let i = 0; i < task.turns.length; i++) {
      const turn = task.turns[i];

      // Accumulate requirements
      for (const r of turn.requirements) {
        if (!allRequirements.find(x => x.id === r.id)) {
          allRequirements.push(r);
        }
      }

      try {
        if (i === 0 || !currentTree) {
          // First turn: generate fresh
          const { generateUI } = await import('./orchestrate.ts');
          const result = await generateUI(turn.prompt, catalog, model, provider, modelName);
          if (result.success && result.tree) {
            currentTree = result.tree as UITreeNode;
            turnPassCount++;
          } else {
            errors.push(`Turn ${i}: generation failed`);
            continue;
          }
        } else {
          // Subsequent turns: refine
          const priorTreeSnapshot = currentTree!;
          const result = await refineUI(
            {
              priorTree: priorTreeSnapshot,
              priorPrompt,
              newPrompt: turn.prompt,
              history,
            },
            catalog,
            model,
            provider,
            modelName
          );
          const diff = computeDiff(priorTreeSnapshot, result.tree, allRequirements);
          retained = diff.retained;
          dropped = diff.dropped;
          currentTree = result.tree;
          turnPassCount++;
        }

        // Check retention: any previously passed requirement that now fails?
        for (const r of allRequirements) {
          if (passed.has(r.id) && !r.assert(currentTree)) {
            dropped.push(r.id);
            errors.push(`APR violation: ${r.id} regressed on turn ${i}`);
          }
          if (r.assert(currentTree)) {
            passed.add(r.id);
          }
        }

        priorPrompt = turn.prompt;
        history.push({ role: 'user', content: turn.prompt });
        history.push({ role: 'assistant', content: JSON.stringify(currentTree) });
      } catch (e: any) {
        errors.push(`Turn ${i}: ${String(e?.message || e)}`);
      }
    }

    const apr = allRequirements.length > 0
      ? retained.length / allRequirements.length
      : 1;

    results.push({
      taskId: task.id,
      turnCount: task.turns.length,
      turnPass: turnPassCount / task.turns.length,
      episodeComplete: turnPassCount === task.turns.length && dropped.length === 0,
      apr,
      retained,
      dropped,
      errors,
    });
  }

  const totalTurns = results.reduce((s, r) => s + r.turnCount, 0);
  const totalPass = results.reduce((s, r) => s + r.turnPass * r.turnCount, 0);

  return {
    taskCount: results.length,
    avgTurnPass: totalTurns > 0 ? totalPass / totalTurns : 0,
    episodeCompletionRate: results.filter(r => r.episodeComplete).length / results.length,
    avgAPR: results.reduce((s, r) => s + r.apr, 0) / results.length,
    results,
  };
}

export { checkRetention, retentionCheck, runRetentionCheck, verifyRetention, retentionChecker, applyPatch, applyPatches, resolveTemplatePlaceholders } from './patch.ts';
