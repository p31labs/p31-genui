/**
 * @p31ca/genui — Local JSON Heal (jsonrepair)
 *
 * Heals malformed JSON locally in ~1ms before spending a model call.
 * Handles trailing prose, missing brackets, single quotes, etc.
 *
 * WHY THE HEAL IS SPLIT BY CAUSE (2026-10-22)
 *
 * The harness used to report one number — "healed" — for every repair the
 * healer performed, which is a number that cannot say anything. A strict
 * decoder that returns exactly the JSON it was asked for needs NO healing:
 * if the strict arms still show a high healed rate, then the route is not
 * really constrained (or the healer is repairing something other than the
 * model's output). One number hides both cases.
 *
 * So every heal now carries its CAUSE:
 *
 *   fence          the model wrapped the JSON in a markdown fence
 *                  (```json ... ```) — the provider emitted prose around a
 *                  perfectly good payload
 *   trailingProse  the model emitted a sentence AFTER the JSON
 *   bracketRepair  the model's JSON was truncated / unbalanced and the
 *                  healer cut it back to the first balanced object
 *   quoteRepair    single quotes, unquoted keys, trailing commas
 *
 * A strict arm should be near zero on ALL of them. json-object arms are
 * expected to be non-zero on fence/trailingProse — that is the mode
 * working as designed, and now the number says so instead of hiding.
 */

export type HealKind = 'fence' | 'trailingProse' | 'bracketRepair' | 'quoteRepair';

export interface HealResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  /** Which repairs were applied (empty = the output was already valid JSON). */
  kinds: HealKind[];
  /** True when the raw output parsed as-is. */
  clean: boolean;
}

/** Strip a markdown code fence, if the whole payload is wrapped in one. */
function stripFence(text: string): { text: string; fenced: boolean } {
  const m = /^\s*```(?:json|JSON)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  if (!m) return { text, fenced: false };
  return { text: m[1], fenced: true };
}

/** Cut a trailing prose sentence that follows a complete JSON object. */
function stripTrailingProse(text: string): { text: string; prose: boolean } {
  // Only meaningful when the JSON is already balanced and something follows.
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0 || end >= text.length) return { text, prose: false };
  const rest = text.slice(end).trim();
  if (!rest) return { text, prose: false };
  return { text: text.slice(0, end), prose: true };
}

export function healJson(raw: string): HealResult {
  const kinds: HealKind[] = [];
  let text = String(raw ?? '').trim();

  // 1. A markdown fence around the whole payload.
  const fenced = stripFence(text);
  if (fenced.fenced) {
    kinds.push('fence');
    text = fenced.text.trim();
  }

  // 2. Direct parse.
  try {
    return { ok: true, value: JSON.parse(text), kinds, clean: kinds.length === 0 };
  } catch {
    // fall through
  }

  // 3. Trailing prose after a complete JSON object.
  const withoutProse = stripTrailingProse(text);
  if (withoutProse.prose) {
    kinds.push('trailingProse');
    text = withoutProse.text;
    try {
      return { ok: true, value: JSON.parse(text), kinds, clean: false };
    } catch {
      // fall through
    }
  }

  // 4. Trim to the first balanced JSON object/array.
  const start = Math.min(
    text.indexOf('{') === -1 ? Infinity : text.indexOf('{'),
    text.indexOf('[') === -1 ? Infinity : text.indexOf('[')
  );
  if (start === Infinity) {
    return { ok: false, error: 'no JSON object or array found', kinds, clean: false };
  }

  const candidate = text.slice(start);

  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }

  const sliced = end > 0 ? candidate.slice(0, end) : candidate;
  if (sliced !== candidate) kinds.push('bracketRepair');

  // 5. Try parsing the sliced candidate.
  try {
    return { ok: true, value: JSON.parse(sliced), kinds, clean: false };
  } catch {
    // 6. Common textual repairs: trailing commas, single quotes, unquoted keys.
    try {
      const fixed = sliced
        .replace(/,\s*([}\]])/g, '$1')           // trailing commas
        .replace(/'/g, '"')                       // single quotes
        .replace(/(\w+)\s*:/g, '"$1":');          // unquoted keys
      kinds.push('quoteRepair');
      return { ok: true, value: JSON.parse(fixed), kinds, clean: false };
    } catch (e) {
      return {
        ok: false,
        error: `unrepairable: ${e instanceof Error ? e.message : String(e)}`,
        kinds,
        clean: false,
      };
    }
  }
}
