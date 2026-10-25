/**
 * @p31ca/genui — Spec Compiler
 *
 * Validates an agent's JSON spec against the catalog.
 * Returns structured errors the repair loop can feed back to the model.
 */

import { z } from 'zod';
import type { Catalog, CatalogEntry } from './catalog';

export type CompileErrorCode =
  | 'unknown_component'
  | 'missing_required_prop'
  | 'invalid_prop'
  | 'slot_mismatch'
  | 'invalid_structure'
  | 'interaction_cycle';

export interface CompileError {
  code: CompileErrorCode;
  path: string;
  message: string;
  expected?: string;
  received?: unknown;
}

export interface UITreeNode {
  component: string;
  props?: Record<string, unknown>;
  children?: UITreeNode[];
  id?: string;
}

export interface CompileResult {
  ok: boolean;
  tree?: UITreeNode;
  errors: CompileError[];
}

function validateNode(
  node: unknown,
  catalog: Catalog,
  path: string,
  errors: CompileError[],
  parentEntry: CatalogEntry | null
): UITreeNode | null {
  if (!node || typeof node !== 'object') {
    errors.push({
      code: 'invalid_structure',
      path,
      message: 'Node must be an object with a "component" field',
      expected: '{ component: string, props?: object, children?: array }',
      received: node,
    });
    return null;
  }

  const n = node as Record<string, unknown>;

  if (typeof n.component !== 'string') {
    errors.push({
      code: 'invalid_structure',
      path: `${path}.component`,
      message: 'component must be a string',
      expected: 'string',
      received: n.component,
    });
    return null;
  }

  const entry = catalog.components[n.component];
  if (!entry) {
    errors.push({
      code: 'unknown_component',
      path: `${path}.component`,
      message: `Unknown component: ${n.component}`,
      expected: Object.keys(catalog.components).join(' | '),
      received: n.component,
    });
    return null;
  }

  // Check slot compatibility
  if (parentEntry) {
    if (parentEntry.slots.length === 0) {
      // Leaf node: no children allowed
      errors.push({
        code: 'slot_mismatch',
        path,
        message: `${parentEntry.name} is a leaf component and cannot have children`,
        expected: 'no children',
        received: n.component,
      });
      return null;
    }
    if (!parentEntry.slots.includes('*') && !parentEntry.slots.includes(n.component)) {
      errors.push({
        code: 'slot_mismatch',
        path,
        message: `${n.component} is not allowed in ${parentEntry.name} (allowed: ${parentEntry.slots.join(', ')})`,
        expected: parentEntry.slots.join(' | '),
        received: n.component,
      });
      return null;
    }
  }

  // Validate props
  // Strict-mode providers (Groq gpt-oss json_schema) force EVERY prop key to
  // be present, typed as nullable, because their strict validator requires
  // `required` to list every key in `properties`. A null prop therefore means
  // "not set" — and Zod's `.optional()` rejects null. Drop nulls before
  // validation: lossless (a null prop carries no information) and it keeps
  // the strict path and the json-object path on ONE compiler.
  const rawProps = (n.props as Record<string, unknown>) ?? {};
  const props = Object.fromEntries(
    Object.entries(rawProps).filter(([, v]) => v !== null)
  );
  const result = entry.props.safeParse(props);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path.join('.');
      errors.push({
        code: issue.code === 'invalid_type' && issue.message.includes('Required')
          ? 'missing_required_prop'
          : 'invalid_prop',
        path: field ? `${path}.props.${field}` : `${path}.props`,
        message: issue.message,
        expected: issue.code === 'invalid_enum_value'
          ? (issue as any).options?.join(' | ')
          : undefined,
        received: field ? props[field] : props,
      });
    }
  }

  // Validate children
  const children: UITreeNode[] = [];
  if (n.children !== undefined) {
    if (!Array.isArray(n.children)) {
      errors.push({
        code: 'invalid_structure',
        path: `${path}.children`,
        message: 'children must be an array',
        expected: 'array',
        received: n.children,
      });
    } else {
      for (let i = 0; i < n.children.length; i++) {
        const child = validateNode(n.children[i], catalog, `${path}.children[${i}]`, errors, entry);
        if (child) children.push(child);
      }
    }
  }

  if (errors.length > 0 && !result.success) {
    return null;
  }

  return {
    component: n.component,
    props: result.success ? result.data : props,
    children: children.length > 0 ? children : undefined,
    id: typeof n.id === 'string' ? n.id : undefined,
  };
}

export function compile(spec: unknown, catalog: Catalog): CompileResult {
  const errors: CompileError[] = [];

  if (!spec || typeof spec !== 'object') {
    return {
      ok: false,
      errors: [{
        code: 'invalid_structure',
        path: 'root',
        message: 'Spec must be an object with a "component" field',
        expected: '{ component: string, props?: object, children?: array }',
        received: spec,
      }],
    };
  }

  const tree = validateNode(spec, catalog, 'root', errors, null);

  if (errors.length > 0 || !tree) {
    return { ok: false, errors };
  }

  return { ok: true, tree, errors: [] };
}

export function formatErrorsForRepair(errors: CompileError[]): string {
  return errors.map(e => {
    let msg = `[${e.code}] ${e.path}: ${e.message}`;
    if (e.expected) msg += ` (expected: ${e.expected})`;
    if (e.received !== undefined) msg += ` (received: ${JSON.stringify(e.received)})`;
    return msg;
  }).join('\n');
}
