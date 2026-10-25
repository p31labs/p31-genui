/**
 * @p31ca/genui — Deterministic Renderer
 *
 * Maps a validated UITreeNode to real React components.
 * No eval, no dangerouslySetInnerHTML, no code execution.
 * The catalog is the allowlist.
 */

import React from 'react';
import type { UITreeNode } from './compile';

// Component registry — maps catalog names to React components.
// These are thin wrappers around design-core components.
const REGISTRY: Record<string, React.ComponentType<any>> = {};

export function registerComponent(name: string, component: React.ComponentType<any>) {
  REGISTRY[name] = component;
}

export function render(tree: UITreeNode): React.ReactElement {
  const Component = REGISTRY[tree.component];
  if (!Component) {
    // Fallback: render as a div with data attribute for debugging
    return React.createElement('div', { 'data-genui': tree.component, 'data-genui-error': 'unregistered' },
      tree.children?.map((c, i) => React.createElement(React.Fragment, { key: i }, render(c)))
    );
  }

  const props = { ...tree.props };
  const children = tree.children?.map((c, i) =>
    React.createElement(React.Fragment, { key: i }, render(c))
  );

  return React.createElement(Component, props, children);
}

export function renderToString(tree: UITreeNode): string {
  // For SSR / testing
  return JSON.stringify(tree);
}
