/**
 * @p31ca/genui — Data Binding Runtime
 *
 * Resolves binding paths like "request.body.name", "response.id",
 * "request.params.id" against a data context and injects values
 * into the component tree.
 */

import type { UITreeNode } from './compile';

export interface BindingContext {
  request?: {
    body?: Record<string, unknown>;
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
  };
  response?: Record<string, unknown>;
  item?: Record<string, unknown>;
}

export function applyBindings(tree: UITreeNode, data: BindingContext): UITreeNode {
  const binding = tree.props?.binding as string | undefined;
  const newProps = { ...tree.props };

  if (binding) {
    const value = resolvePath(data, binding);
    if (value !== undefined) {
      if (tree.component === 'Text' && !newProps.content) {
        newProps.content = String(value);
      } else if (tree.component === 'StatCard' && !newProps.value) {
        newProps.value = String(value);
      } else if (tree.component === 'Badge' && !newProps.label) {
        newProps.label = String(value);
      } else if (tree.component === 'Alert' && !newProps.message) {
        newProps.message = String(value);
      }
    }
  }

  const newChildren = (tree.children || []).map(child =>
    applyBindings(child as UITreeNode, data)
  );

  return {
    ...tree,
    props: newProps,
    children: newChildren,
  };
}

function resolvePath(data: BindingContext, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = data;
  for (const part of parts) {
    if (current && typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export function resolveTemplates(tree: UITreeNode, data: BindingContext): UITreeNode {
  const newProps = { ...tree.props };

  for (const key of Object.keys(newProps)) {
    const val = newProps[key];
    if (typeof val === 'string' && val.includes('{{') && val.includes('}}')) {
      const match = val.match(/\{\{([^}]+)\}\}/);
      if (match) {
        const path = match[1].trim();
        const resolved = resolvePath(data, path);
        if (resolved !== undefined) {
          newProps[key] = val.replace(match[0], String(resolved));
        }
      }
    }
  }

  const newChildren = (tree.children || []).map(child =>
    resolveTemplates(child as UITreeNode, data)
  );

  return {
    ...tree,
    props: newProps,
    children: newChildren,
  };
}
