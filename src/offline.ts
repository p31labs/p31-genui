/**
 * @p31ca/genui — Offline fixture model + harness helpers
 *
 * Provides a stub ModelFn that replays pre-recorded fixture JSON instead
 * of calling a live provider. This lets the compiler + APR harness run
 * with zero API keys and zero network calls.
 */

import type { ModelFn } from './orchestrate.ts';
import { parseAssert, evalParsed } from './requirements.ts';

export interface FixtureEntry {
  /** The user prompt (matched as a substring of the model prompt). */
  prompt: string;
  /** The gold tree to return when the model is asked for a spec. */
  goldTree: unknown;
}

/**
 * Build a stub ModelFn that replays fixture gold trees.
 */
export function createFixtureModelFn(fixtures: FixtureEntry[]): ModelFn {
  const promptToGold = new Map(fixtures.map(f => [f.prompt, f.goldTree]));

  function findGold(text: string): unknown | undefined {
    for (const [prompt, gold] of promptToGold) {
      if (text.includes(prompt)) return gold;
    }
    for (const [prompt, gold] of promptToGold) {
      if (text.includes(`Plan for: ${prompt}`)) return gold;
    }
    return undefined;
  }

  return async (prompt: string, _options?: { format?: object; pin?: string; system?: string }) => {
    if (prompt.includes('You are a UI planner')) {
      const m = prompt.match(/User request: (.+)/);
      const userPrompt = m ? m[1].trim() : '';
      return { text: `Plan for: ${userPrompt}`, tokens: 0 };
    }
    const gold = findGold(prompt);
    if (gold !== undefined) {
      return { text: JSON.stringify(gold), tokens: 0 };
    }
    return { text: '{}', tokens: 0 };
  };
}

/**
 * Convert apr-tasks.json (string assertions) into APRTask-compatible
 * turns with executable assert functions.
 */
export function stringAssertToFn(assertStr: string): (tree: any) => boolean {
  const parsed = parseAssert(assertStr);
  return (tree: any) => evalParsed(tree, parsed);
}

/**
 * Convert a fixture task list (with string assertions) into the shape
 * expected by runAPRHarness, with assert functions.
 */
export function aprTasksFromFixture(
  tasks: Array<{ id: string; turns: Array<{ prompt: string; goldTree: unknown; requirements: Array<{ id: string; assert: string }> }> }>,
): Array<{ id: string; turns: Array<{ prompt: string; goldTree: unknown; requirements: Array<{ id: string; assert: (tree: any) => boolean }> }> }> {
  return tasks.map(task => ({
    id: task.id,
    turns: task.turns.map(turn => ({
      prompt: turn.prompt,
      goldTree: turn.goldTree,
      requirements: turn.requirements.map(req => ({
        id: req.id,
        assert: stringAssertToFn(req.assert),
      })),
    })),
  }));
}
