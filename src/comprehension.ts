/**
 * @p31ca/genui — Comprehension Gate — **PARKED (experimental, not gated)**
 *
 * Measures whether a generated UI conveys understanding, not just
 * preference. A reader model answers objective questions from the
 * rendered tree; compare against a plain-text baseline.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PARKED 2026-10-21 (external code review).
 *
 * Why: this gate has never produced a number. Every claim the estate made
 * about it came from fixtures the same author wrote, so it could not fail —
 * the exact "vacuous metric" failure the review called out. Worse, it
 * doubles the model-call count per evaluation (one reader call per question
 * PER condition) and the reader model is a third moving part whose own
 * answer variance is unmeasured, so a "lift" figure would not even be
 * reproducible.
 *
 * It stays in the tree as an API (no caller, not exported from any gate
 * path) until there is (a) a LIVE fidelity baseline to compare against and
 * (b) a held-out question set the pipeline has never seen. The unblock
 * criteria are written down in docs/fix-plans/genui-fidelity-2026-10-21.md.
 *
 * Until then: do NOT quote a comprehension number. The only honest status
 * is "not measured".
 * ─────────────────────────────────────────────────────────────────────────
 */

import type { UITreeNode } from './compile';

export interface ComprehensionQuestion {
  question: string;
  expectedAnswer: string;
}

export interface ComprehensionResult {
  question: string;
  answer: string;
  correct: boolean;
}

export interface ComprehensionReport {
  uiScore: number;       // 0-1 fraction of correct answers from UI
  textScore: number;     // 0-1 fraction of correct answers from plain text
  lift: number;         // uiScore - textScore (positive = UI helps)
  results: ComprehensionResult[];
}

export type ReaderFn = (context: string, question: string) => Promise<string>;

export async function measureComprehension(
  tree: UITreeNode,
  plainText: string,
  questions: ComprehensionQuestion[],
  reader: ReaderFn
): Promise<ComprehensionReport> {
  const uiContext = JSON.stringify(tree, null, 2);
  const uiResults: ComprehensionResult[] = [];
  const textResults: ComprehensionResult[] = [];

  for (const q of questions) {
    const uiAnswer = await reader(uiContext, q.question);
    const textAnswer = await reader(plainText, q.question);

    uiResults.push({
      question: q.question,
      answer: uiAnswer,
      correct: normalize(uiAnswer) === normalize(q.expectedAnswer),
    });

    textResults.push({
      question: q.question,
      answer: textAnswer,
      correct: normalize(textAnswer) === normalize(q.expectedAnswer),
    });
  }

  const uiScore = uiResults.filter(r => r.correct).length / questions.length;
  const textScore = textResults.filter(r => r.correct).length / questions.length;

  return {
    uiScore,
    textScore,
    lift: uiScore - textScore,
    results: uiResults,
  };
}

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/[^\w\s]/g, '');
}
