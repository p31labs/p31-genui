/**
 * @p31ca/genui — ShellRenderer
 *
 * Renders a compiled UITreeNode inside a @p31ca/shell frame.
 */

import React from 'react';
import type { UITreeNode } from './compile';
import { render } from './render';
import { applyBindings, resolveTemplates, type BindingContext } from './binding';
import { SHELL_CONTRACT, type ShellContract } from '@p31ca/shell';

export interface ShellRendererProps {
  tree: UITreeNode;
  contract?: ShellContract;
  bindingData?: BindingContext;
}

export function ShellRenderer({ tree, contract = SHELL_CONTRACT, bindingData }: ShellRendererProps) {
  const c = contract;
  const slotReset = c.slotReset;

  // Resolve bindings before rendering
  let resolvedTree = tree;
  if (bindingData) {
    resolvedTree = resolveTemplates(applyBindings(tree, bindingData), bindingData);
  }

  const slotStyle: React.CSSProperties = {
    borderRadius: slotReset.borderRadius,
    border: slotReset.border,
    boxShadow: slotReset.boxShadow,
    margin: slotReset.margin,
  };

  return (
    <div
      className="p31-shell"
      style={{ display: 'grid', gridTemplateColumns: `${c.railWidth} 1fr`, gridTemplateRows: `${c.headerHeight} 1fr`, minHeight: '100vh' }}
    >
      <header data-shell-region="header" style={{ gridColumn: '1 / -1', height: c.headerHeight, ...slotStyle }}>
        <div data-shell-slot="posner-topbar" style={slotStyle} />
      </header>
      <nav data-shell-region="rail" style={{ width: c.railWidth, ...slotStyle }}>
        <div data-shell-slot="sidebar-nav" style={slotStyle} />
      </nav>
      <main data-shell-region="main" style={{ ...slotStyle }}>
        {render(resolvedTree)}
      </main>
      <aside data-shell-region="details" style={{ ...slotStyle }}>
        <div data-shell-slot="topbar" style={slotStyle} />
      </aside>
    </div>
  );
}

export default ShellRenderer;
