import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { ShellRenderer } from './ShellRenderer';
import { shellGate } from '@p31ca/shell';

describe('ShellRenderer', () => {
  it('renders a UITreeNode inside a shell frame that passes ShellGate', () => {
    const tree = { component: 'div', props: {}, children: [], id: 'root' } as any;
    const html = renderToStaticMarkup(<ShellRenderer tree={tree} />);
    const dom = new JSDOM(html, { url: 'http://localhost' });
    // stub geometry
    const doc = dom.window.document;
    Object.defineProperty(dom.window, 'innerWidth', { value: 1024 });
    const el = (node: Element) => {
      (node as any).getBoundingClientRect = () => ({ left: 0, width: 1024, right: 280, top: 0, bottom: 64, height: 64 });
    };
    doc.querySelectorAll('*').forEach((n) => el(n));
    const result = shellGate(doc.body);
    expect(result.violations).toEqual([]);
    expect(result.pass).toBe(true);
  });
});
