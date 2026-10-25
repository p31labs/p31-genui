/**
 * @p31ca/genui — Patch-based editing + offline APR harness helpers
 */

import { evalRequirement } from './requirements.ts';
import type { Requirement } from './requirements.ts';

export type PatchOp = 'add' | 'modify' | 'remove';

export interface Patch {
  op: PatchOp;
  path: string;
  value?: any;
}

function clone<T>(x: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(x);
    } catch {
      // fall through
    }
  }
  return JSON.parse(JSON.stringify(x));
}

function parsePath(path: unknown): string[] {
  if (typeof path !== 'string') throw new Error('patch path must be a string');
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '/') return [];
  if (!trimmed.startsWith('/')) throw new Error(`invalid path: "${path}" (must start with /)`);
  const segs = trimmed.slice(1).split('/');
  if (segs.some((s) => s === '')) throw new Error(`invalid path: "${path}" (empty segment)`);
  return segs;
}

function isArrayIndex(seg: string): boolean {
  return /^\d+$/.test(seg);
}

function getChild(container: any, seg: string): any {
  if (Array.isArray(container)) {
    if (!isArrayIndex(seg)) throw new Error(`invalid path: array segment "${seg}" is not an index`);
    const idx = Number(seg);
    if (idx < 0 || idx >= container.length) throw new Error(`out of bounds: index ${idx} (length ${container.length})`);
    return container[idx];
  }
  if (container && typeof container === 'object') {
    if (!(seg in container)) throw new Error(`invalid path: property "${seg}" does not exist`);
    return container[seg];
  }
  throw new Error('invalid path: cannot traverse into non-object');
}

export function applyPatch(tree: any, patch: any): any {
  if (!patch || typeof patch !== 'object') throw new Error('patch must be an object');
  const op = patch.op;
  if (op !== 'add' && op !== 'modify' && op !== 'remove') {
    throw new Error(`invalid op: ${String(op)}`);
  }
  if (typeof patch.path !== 'string') throw new Error('patch.path must be a string');

  const segments = parsePath(patch.path);
  const root = clone(tree);

  if (segments.length === 0) {
    if (op === 'modify') return clone(patch.value);
    throw new Error('cannot add or remove the root node');
  }

  let parent: any = root;
  for (let i = 0; i < segments.length - 1; i++) {
    parent = getChild(parent, segments[i]);
  }
  const key = segments[segments.length - 1];

  if (Array.isArray(parent)) {
    if (key === '-') {
      if (op !== 'add') throw new Error('invalid path: "-" only valid for add');
      parent.push(clone(patch.value));
      return root;
    }
    if (!isArrayIndex(key)) throw new Error(`invalid path: array segment "${key}" is not an index`);
    const idx = Number(key);
    if (idx < 0) throw new Error(`out of bounds: negative index ${idx}`);

    if (op === 'add') {
      if (idx > parent.length) throw new Error(`out of bounds: index ${idx} (length ${parent.length})`);
      parent.splice(idx, 0, clone(patch.value));
    } else if (op === 'modify') {
      if (idx >= parent.length) throw new Error(`out of bounds: index ${idx} (length ${parent.length})`);
      parent[idx] = clone(patch.value);
    } else {
      if (idx >= parent.length) throw new Error(`out of bounds: index ${idx} (length ${parent.length})`);
      parent.splice(idx, 1);
    }
  } else if (parent && typeof parent === 'object') {
    if (op === 'add') {
      parent[key] = clone(patch.value);
    } else if (op === 'modify') {
      if (!(key in parent)) throw new Error(`invalid path: property "${key}" does not exist`);
      parent[key] = clone(patch.value);
    } else {
      if (!(key in parent)) throw new Error(`invalid path: property "${key}" does not exist`);
      delete parent[key];
    }
  } else {
    throw new Error('invalid path: parent is not an object or array');
  }

  return root;
}

export function applyPatches(tree: any, patches: any): any {
  if (!Array.isArray(patches)) throw new Error('patches must be an array');
  let current = clone(tree);
  for (const p of patches) {
    current = applyPatch(current, p);
  }
  return current;
}

function resolveDataPath(data: any, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = data;
  for (const part of parts) {
    if (current && typeof current === 'object' && part in (current as any)) {
      current = (current as any)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function replacePlaceholders(str: string, data: any): string {
  return str.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, rawPath) => {
    const value = resolveDataPath(data, String(rawPath).trim());
    if (value === undefined || value === null) return match;
    return String(value);
  });
}

function walkAndBind(node: any, data: any): any {
  if (Array.isArray(node)) {
    return node.map((n) => walkAndBind(n, data));
  }
  if (node && typeof node === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') {
        out[k] = replacePlaceholders(v, data);
      } else {
        out[k] = walkAndBind(v, data);
      }
    }
    return out;
  }
  if (typeof node === 'string') {
    return replacePlaceholders(node, data);
  }
  return node;
}

export function resolveTemplatePlaceholders(tree: any, data: any): any {
  return walkAndBind(clone(tree), data);
}

export interface RetentionTurnResult {
  turn: number;
  applied: boolean;
  applyError: string | null;
  failedRequirements: string[];
  regressed: string[];
  goldMatch: boolean;
}

export interface RetentionEpisodeResult {
  episodeId: string;
  ok: boolean;
  turns: RetentionTurnResult[];
}

export interface RetentionReport {
  ok: boolean;
  episodes: RetentionEpisodeResult[];
}

export function checkRetention(episodes: any[]): RetentionReport {
  const episodeResults: RetentionEpisodeResult[] = [];
  let allOk = true;

  for (const ep of episodes || []) {
    const turns = Array.isArray(ep?.turns) ? ep.turns : [];
    let currentTree: any = ep?.initialTree != null ? clone(ep.initialTree) : null;
    const allReqs: Requirement[] = [];
    const passed = new Set<string>();
    const turnResults: RetentionTurnResult[] = [];
    let episodeOk = true;

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i] || {};

      for (const r of turn.requirements || []) {
        if (r && r.id && !allReqs.find((x) => x.id === r.id)) {
          allReqs.push({ id: String(r.id), assert: String(r.assert) });
        }
      }

      if (currentTree === null) {
        currentTree = turn.goldTree != null ? clone(turn.goldTree) : null;
      }

      let patched: any = currentTree;
      let applied = true;
      let applyError: string | null = null;
      const patch = turn.expectedPatch;

      try {
        if (patch == null) {
          patched = turn.goldTree != null ? clone(turn.goldTree) : currentTree;
        } else if (Array.isArray(patch)) {
          patched = applyPatches(currentTree, patch);
        } else {
          patched = applyPatch(currentTree, patch);
        }
      } catch (e: any) {
        applied = false;
        applyError = String(e?.message || e);
        episodeOk = false;
      }

      const outcomes = applied
        ? allReqs.map((r) => evalRequirement(patched, r))
        : [];
      const failedRequirements = outcomes.filter((o) => !o.passed).map((o) => o.id);
      const regressed = allReqs
        .filter((r) => passed.has(r.id))
        .filter((r) => {
          const o = outcomes.find((x) => x.id === r.id);
          return !o || !o.passed;
        })
        .map((r) => r.id);

      if (regressed.length > 0) episodeOk = false;

      for (const o of outcomes) {
        if (o.passed) passed.add(o.id);
      }

      let goldMatch = true;
      try {
        goldMatch = JSON.stringify(patched) === JSON.stringify(turn.goldTree);
      } catch {
        goldMatch = false;
      }

      if (!applied || failedRequirements.length > 0 || !goldMatch) {
        episodeOk = false;
      }

      if (applied) currentTree = patched;
      else if (turn.goldTree != null) currentTree = clone(turn.goldTree);

      turnResults.push({
        turn: i,
        applied,
        applyError,
        failedRequirements,
        regressed,
        goldMatch,
      });
    }

    if (!episodeOk) allOk = false;
    episodeResults.push({
      episodeId: String(ep?.id ?? ''),
      ok: episodeOk,
      turns: turnResults,
    });
  }

  return { ok: allOk, episodes: episodeResults };
}

export const retentionCheck = checkRetention;
export const runRetentionCheck = checkRetention;
export const verifyRetention = checkRetention;
export const retentionChecker = checkRetention;

const _default = { applyPatch, applyPatches, resolveTemplatePlaceholders, checkRetention, retentionCheck, runRetentionCheck, verifyRetention, retentionChecker };
export default _default;
// ---------------------------------------------------------------------------
// ID-based patch targeting (BlockNote model)
//
// Positional paths (/children/0) are fragile: an earlier insert shifts every
// later index.  These patches target nodes by their stable `id` field instead.
// A batch is all-or-nothing: if any referenced id is unknown, the whole
// batch is rejected before any mutation occurs.
// ---------------------------------------------------------------------------

export interface IdPatch {
  op: 'insert' | 'update' | 'remove';
  // insert
  parentId?: string;
  position?: 'start' | 'end' | 'before' | 'after';
  refId?: string;
  block?: any;
  // update
  targetId?: string;
  props?: Record<string, any>;
  // remove
  targetIds?: string[];
}

let _idCounter = 0;

export function assignIds(tree: any): any {
  const clone_ = clone(tree);
  function walk(node: any): void {
    if (!node || typeof node !== 'object') return;
    if (!node.id || typeof node.id !== 'string') {
      node.id = `n${++_idCounter}`;
    }
    if (Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  }
  walk(clone_);
  return clone_;
}

export function resetIdCounter(): void {
  _idCounter = 0;
}

export function findNode(tree: any, id: string): any {
  if (!tree || typeof tree !== 'object') return null;
  if (tree.id === id) return tree;
  if (Array.isArray(tree.children)) {
    for (const child of tree.children) {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  return null;
}

export function findParent(tree: any, id: string): { parent: any; index: number } | null {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree.children)) {
    for (let i = 0; i < tree.children.length; i++) {
      if (tree.children[i]?.id === id) {
        return { parent: tree, index: i };
      }
      const found = findParent(tree.children[i], id);
      if (found) return found;
    }
  }
  return null;
}

function validateIdPatch(patch: any): void {
  if (!patch || typeof patch !== 'object') throw new Error('patch must be an object');
  const op = patch.op;
  if (op !== 'insert' && op !== 'update' && op !== 'remove') {
    throw new Error(`invalid op: ${String(op)} (expected insert|update|remove)`);
  }
  if (op === 'insert') {
    if (typeof patch.parentId !== 'string') throw new Error('insert requires parentId');
    if (!['start', 'end', 'before', 'after'].includes(patch.position)) throw new Error('insert requires position (start|end|before|after)');
    if ((patch.position === 'before' || patch.position === 'after') && typeof patch.refId !== 'string') throw new Error('before/after requires refId');
    if (!patch.block || typeof patch.block !== 'object') throw new Error('insert requires block');
  }
  if (op === 'update') {
    if (typeof patch.targetId !== 'string') throw new Error('update requires targetId');
    if (!patch.props || typeof patch.props !== 'object') throw new Error('update requires props');
  }
  if (op === 'remove') {
    if (!Array.isArray(patch.targetIds) || patch.targetIds.length === 0) throw new Error('remove requires non-empty targetIds array');
  }
}

function validateIdBatch(tree: any, patches: any[]): void {
  for (const p of patches) validateIdPatch(p);
  // Check all referenced ids exist in the tree
  const allIds = new Set<string>();
  function collectIds(node: any): void {
    if (!node || typeof node !== 'object') return;
    if (typeof node.id === 'string') allIds.add(node.id);
    if (Array.isArray(node.children)) node.children.forEach(collectIds);
  }
  collectIds(tree);
  for (const p of patches) {
    if (p.op === 'insert') {
      if (!allIds.has(p.parentId)) throw new Error(`unknown parentId: ${p.parentId}`);
      if (p.refId && !allIds.has(p.refId)) throw new Error(`unknown refId: ${p.refId}`);
    }
    if (p.op === 'update') {
      if (!allIds.has(p.targetId)) throw new Error(`unknown targetId: ${p.targetId}`);
    }
    if (p.op === 'remove') {
      for (const id of p.targetIds) {
        if (!allIds.has(id)) throw new Error(`unknown targetId: ${id}`);
      }
    }
  }
}

export function applyIdPatch(tree: any, patch: any): any {
  validateIdPatch(patch);
  const root = clone(tree);
  const allIds = new Set<string>();
  function collectIds(node: any): void {
    if (!node || typeof node !== 'object') return;
    if (typeof node.id === 'string') allIds.add(node.id);
    if (Array.isArray(node.children)) node.children.forEach(collectIds);
  }
  collectIds(root);

  if (patch.op === 'insert') {
    const parent = findNode(root, patch.parentId);
    if (!parent) throw new Error(`parent not found: ${patch.parentId}`);
    if (!Array.isArray(parent.children)) parent.children = [];
    const block = clone(patch.block);
    if (!block.id || typeof block.id !== 'string') {
      block.id = `n${++_idCounter}`;
    }
    if (patch.position === 'start') {
      parent.children.unshift(block);
    } else if (patch.position === 'end') {
      parent.children.push(block);
    } else if (patch.position === 'before') {
      const idx = parent.children.findIndex((c: any) => c?.id === patch.refId);
      if (idx === -1) throw new Error(`refId not found: ${patch.refId}`);
      parent.children.splice(idx, 0, block);
    } else if (patch.position === 'after') {
      const idx = parent.children.findIndex((c: any) => c?.id === patch.refId);
      if (idx === -1) throw new Error(`refId not found: ${patch.refId}`);
      parent.children.splice(idx + 1, 0, block);
    }
    return root;
  }

  if (patch.op === 'update') {
    const node = findNode(root, patch.targetId);
    if (!node) throw new Error(`target not found: ${patch.targetId}`);
    if (patch.props && typeof patch.props === 'object') {
      node.props = { ...node.props, ...clone(patch.props) };
    }
    return root;
  }

  if (patch.op === 'remove') {
    for (const id of patch.targetIds) {
      const found = findParent(root, id);
      if (found) {
        found.parent.children.splice(found.index, 1);
      }
    }
    return root;
  }

  return root;
}

export function applyIdPatches(tree: any, patches: any[]): any {
  if (!Array.isArray(patches)) throw new Error('patches must be an array');
  // Validate the entire batch against the original tree before any mutation
  validateIdBatch(tree, patches);
  let current = clone(tree);
  for (const p of patches) {
    current = applyIdPatch(current, p);
  }
  return current;
}
