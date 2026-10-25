/**
 * @p31ca/genui — Repair Loop
 *
 * Feeds compiler errors back to the model for repair.
 * Tracks tokens, iterations, and error distribution.
 */

import type { Catalog } from './catalog.ts';
import { compile, formatErrorsForRepair, type CompileResult } from './compile.ts';

export interface RepairMetrics {
  iterations: number;
  totalTokens: number;
  firstPassSuccess: boolean;
  errorCodes: string[];
  finalSuccess: boolean;
}

export interface RepairResult {
  success: boolean;
  tree?: CompileResult['tree'];
  metrics: RepairMetrics;
  errors?: string[];
}

export type ModelFn = (prompt: string) => Promise<{ text: string; tokens: number }>;

export async function repairLoop(
  initialSpec: string,
  catalog: Catalog,
  model: ModelFn,
  maxRetries: number = 3
): Promise<RepairResult> {
  const metrics: RepairMetrics = {
    iterations: 0,
    totalTokens: 0,
    firstPassSuccess: false,
    errorCodes: [],
    finalSuccess: false,
  };

  // First attempt: compile the initial spec
  let parsed: unknown;
  try {
    parsed = JSON.parse(initialSpec);
  } catch {
    parsed = null;
  }

  if (parsed) {
    const result = compile(parsed, catalog);
    metrics.iterations = 1;
    if (result.ok) {
      metrics.firstPassSuccess = true;
      metrics.finalSuccess = true;
      return { success: true, tree: result.tree, metrics };
    }
    metrics.errorCodes = result.errors.map(e => e.code);
  }

  // Repair loop
  for (let i = 0; i < maxRetries; i++) {
    const lastErrors = parsed
      ? compile(parsed, catalog).errors
      : [{ code: 'invalid_structure' as const, path: 'root', message: 'Invalid JSON', expected: 'valid JSON', received: initialSpec }];

    const repairPrompt = `The following UI spec has errors. Fix them and return ONLY valid JSON.

ERRORS:
${formatErrorsForRepair(lastErrors)}

ORIGINAL SPEC:
${initialSpec}

Return the corrected JSON spec. No markdown, no explanation.`;

    const response = await model(repairPrompt);
    metrics.totalTokens += response.tokens;
    metrics.iterations++;

    try {
      parsed = JSON.parse(response.text);
    } catch {
      metrics.errorCodes.push('invalid_structure');
      continue;
    }

    const result = compile(parsed, catalog);
    if (result.ok) {
      metrics.finalSuccess = true;
      return { success: true, tree: result.tree, metrics };
    }
    metrics.errorCodes = [...new Set([...metrics.errorCodes, ...result.errors.map(e => e.code)])];
  }

  return {
    success: false,
    metrics,
    errors: metrics.errorCodes,
  };
}
