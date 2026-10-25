/**
 * @p31ca/genui — hashing for run manifests (NODE ONLY).
 *
 * This module is deliberately NOT exported from the package index: the
 * package is also imported by browser code (`@p31ca/ui-forge` imports
 * `@p31ca/genui`, and the shell portal vendors it), and `node:crypto` does
 * not belong in a browser bundle. The harness scripts import this module
 * directly.
 *
 * The hashes go into the run manifest, so a number can be tied to the
 * EXACT artifacts that produced it: the prompt set, the requirement set,
 * the scorer, the git commit. A result file whose manifest cannot say
 * what it was measured against is not evidence — it is a number.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Requirement } from './requirements.ts';

/** A sha256 of a string, hex encoded. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** A sha256 of a file's bytes. */
export function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * A stable hash of a requirement set.
 *
 * Canonical: the assertions sorted, so re-ordering the file does not
 * change the hash, but CHANGING an assertion does.
 */
export function requirementSetHash(reqs: Requirement[] | undefined): string {
  const list = Array.isArray(reqs) ? reqs : [];
  const canonical = list
    .map((r) => `${r.id}:${r.assert}`)
    .sort()
    .join('\n');
  return sha256Hex(canonical);
}

/**
 * The hash of a whole prompt set: the prompts AND their requirements.
 *
 * The two are hashed separately as well, because they answer different
 * questions: "did the SPECS change?" and "did the ASSERTIONS change?".
 */
export function promptSetHash(specs: any[]): string {
  const canonical = specs
    .map((s) => {
      const reqs = (s.requirements ?? [])
        .map((r: any) => `${r.id}:${r.assert}`)
        .sort()
        .join('|');
      return `${s.id ?? ''}\t${s.prompt ?? ''}\t${reqs}`;
    })
    .join('\n');
  return sha256Hex(canonical);
}
