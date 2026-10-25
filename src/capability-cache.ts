/**
 * @p31ca/genui — Capability cache.
 *
 * The free model pool is VOLATILE (measured 2026-10-21/22):
 *   - `qwen3-8b:free` was deprecated on 9 Oct
 *   - `llama-3.3-70b:free` went paid-only
 *   - several models answered 429 or 404
 *   - one answered HTTP 200 with an empty body
 *   - one route (Kilo's) rejected the nullable schema types outright
 * So "which model can do what" is a fact that EXPIRES, and a pipeline that
 * hard-codes it keeps rediscovering the failures at runtime.
 *
 * This cache remembers, per (provider, model, schema dialect), whether the
 * combination actually WORKS, when it last worked, and — after a 404, a
 * 403 or an empty body — it DEMOTES the combination for a TTL. A demoted
 * combination is skipped by a production path and reported by an eval arm
 * ("this arm ran against a demoted model") rather than being rediscovered
 * one 404 at a time.
 *
 * PINNED vs ROUTED. An eval arm pins one model, so the cache is a WARNING
 * there (an arm must not silently switch models). A production path may
 * route, so the cache is a FILTER: a demoted model is skipped in favour of
 * the next candidate.
 *
 * The cache lives OUTSIDE the repo (default `~/.p31/capability-cache.json`)
 * because it is live state, and live state in the working tree would make
 * the estate gate refuse every run.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CapabilityEntry {
  provider: string;
  model: string;
  /** The schema dialect the capability was measured with. */
  dialect: string;
  ok: boolean;
  successes: number;
  failures: number;
  lastOkAt?: string;
  lastFailureAt?: string;
  /** The combination is skipped until this instant. */
  demotedUntil?: string;
  lastReason?: string;
}

export interface CapabilityCache {
  version: 1;
  entries: Record<string, CapabilityEntry>;
}

/** How long a demotion lasts. Long enough to outlast a daily cap, short
 *  enough that a restored model comes back without a human. */
export const DEMOTE_TTL_MS = 6 * 60 * 60 * 1000;

/** The default location: outside the repo, inside the estate's state dir. */
export function defaultCachePath(): string {
  return process.env.P31_CAPABILITY_CACHE
    ? process.env.P31_CAPABILITY_CACHE
    : join(homedir(), '.p31', 'capability-cache.json');
}

export function cacheKey(provider: string, model: string, dialect: string): string {
  return `${provider}::${model}::${dialect}`;
}

export function emptyCache(): CapabilityCache {
  return { version: 1, entries: {} };
}

/** Read the cache. A missing or corrupt file is an EMPTY cache, never a
 *  crash: the cache is an optimisation, not a gate. */
export function readCache(path: string = defaultCachePath()): CapabilityCache {
  try {
    if (!existsSync(path)) return emptyCache();
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || parsed.version !== 1 || typeof parsed.entries !== 'object') return emptyCache();
    return parsed as CapabilityCache;
  } catch {
    return emptyCache();
  }
}

export function writeCache(cache: CapabilityCache, path: string = defaultCachePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2) + '\n');
  } catch {
    // A cache that cannot be written is a cache that does not exist. The
    // run continues; it just re-learns what it already knew.
  }
}

export interface CapabilityRecord {
  provider: string;
  model: string;
  dialect: string;
}

/** The combination WORKED. */
export function recordSuccess(
  cache: CapabilityCache,
  record: CapabilityRecord,
  now: number = Date.now(),
): CapabilityEntry {
  const key = cacheKey(record.provider, record.model, record.dialect);
  const prev = cache.entries[key];
  const entry: CapabilityEntry = {
    provider: record.provider,
    model: record.model,
    dialect: record.dialect,
    ok: true,
    successes: (prev?.successes ?? 0) + 1,
    failures: prev?.failures ?? 0,
    lastOkAt: new Date(now).toISOString(),
    lastReason: undefined,
    demotedUntil: undefined,
  };
  cache.entries[key] = entry;
  return entry;
}

/**
 * The combination FAILED.
 *
 * `demoting` says whether the failure is the model's fault (404 — the
 * model is gone; 403 — it is not allowed; empty — it answers with
 * nothing) or the ACCOUNT's (429 — the budget is spent, and the model is
 * fine). A budget problem must NOT demote a model: that is how a working
 * model gets thrown out because the credits ran out.
 */
export function recordFailure(
  cache: CapabilityCache,
  record: CapabilityRecord,
  reason: string,
  options: { demoting?: boolean; now?: number } = {},
): CapabilityEntry {
  const now = options.now ?? Date.now();
  const demoting = options.demoting ?? true;
  const key = cacheKey(record.provider, record.model, record.dialect);
  const prev = cache.entries[key];
  const entry: CapabilityEntry = {
    provider: record.provider,
    model: record.model,
    dialect: record.dialect,
    ok: false,
    successes: prev?.successes ?? 0,
    failures: (prev?.failures ?? 0) + 1,
    lastFailureAt: new Date(now).toISOString(),
    lastOkAt: prev?.lastOkAt,
    lastReason: reason.slice(0, 200),
    demotedUntil:
      demoting && prev?.demotedUntil && new Date(prev.demotedUntil).getTime() > now
        ? prev.demotedUntil
        : demoting
          ? new Date(now + DEMOTE_TTL_MS).toISOString()
          : undefined,
  };
  cache.entries[key] = entry;
  return entry;
}

/** Is this combination currently demoted? */
export function isDemoted(
  cache: CapabilityCache,
  record: CapabilityRecord,
  now: number = Date.now(),
): boolean {
  const entry = cache.entries[cacheKey(record.provider, record.model, record.dialect)];
  if (!entry?.demotedUntil) return false;
  return new Date(entry.demotedUntil).getTime() > now;
}

/** Why is it demoted (one line), for the report. */
export function demotionReason(
  cache: CapabilityCache,
  record: CapabilityRecord,
  now: number = Date.now(),
): string | null {
  const key = cacheKey(record.provider, record.model, record.dialect);
  const entry = cache.entries[key];
  if (!entry?.demotedUntil) return null;
  const until = new Date(entry.demotedUntil).getTime();
  if (until <= now) return null;
  const mins = Math.round((until - now) / 60000);
  return `demoted for ${mins} min: ${entry.lastReason ?? 'unknown reason'}`;
}
