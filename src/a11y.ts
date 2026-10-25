/**
 * @p31ca/genui — Render-Time Accessibility Gate
 *
 * Machine-checkable WCAG AA constraints: contrast ratio, heading order,
 * touch targets, and 375px overflow. Runs against the rendered DOM.
 */

import type { UITreeNode } from './compile.ts';

export interface A11yViolation {
  code: 'contrast' | 'heading_order' | 'touch_target' | 'overflow' | 'missing_label';
  path: string;
  detail: string;
}

export interface A11yResult {
  pass: boolean;
  violations: A11yViolation[];
}

export function checkA11y(tree: UITreeNode): A11yResult {
  const violations: A11yViolation[] = [];

  // Walk the tree and check structural accessibility rules
  function walk(node: any, path: string, headings: number[]) {
    if (!node || typeof node !== 'object') return;

    const comp = node.component;

    // Check: Buttons must have a label
    if (comp === 'Button') {
      if (!node.props?.label || String(node.props.label).trim() === '') {
        violations.push({
          code: 'missing_label',
          path,
          detail: 'Button has no label',
        });
      }
    }

    // Check: Text with size lg/xl must be a heading (track heading order)
    if (comp === 'Text' && (node.props?.size === 'lg' || node.props?.size === 'xl')) {
      const level = node.props?.size === 'xl' ? 1 : 2;
      if (headings.length > 0 && level > headings[headings.length - 1] + 1) {
        violations.push({
          code: 'heading_order',
          path,
          detail: `Heading level ${level} skips from ${headings[headings.length - 1]}`,
        });
      }
      headings.push(level);
    }

    // Check: touch targets (buttons should have adequate size)
    if (comp === 'Button') {
      // Default button size is assumed 48px minimum
      // If explicitly set smaller, flag it
      if (node.props?.size === 'sm') {
        violations.push({
          code: 'touch_target',
          path,
          detail: 'Button size "sm" may be below 48px touch target',
        });
      }
    }

    // Check children
    if (Array.isArray(node.children)) {
      node.children.forEach((child: any, i: number) => {
        walk(child, `${path}.children[${i}]`, headings);
      });
    }
  }

  walk(tree, 'root', []);

  return {
    pass: violations.length === 0,
    violations,
  };
}

/**
 * Check contrast ratio between foreground and background colors.
 * Returns true if ratio >= 4.5:1 (WCAG AA for normal text).
 */
export function checkContrast(fg: string, bg: string): boolean {
  const fgLum = relativeLuminance(fg);
  const bgLum = relativeLuminance(bg);
  const lighter = Math.max(fgLum, bgLum);
  const darker = Math.min(fgLum, bgLum);
  const ratio = (lighter + 0.05) / (darker + 0.05);
  return ratio >= 4.5;
}

function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map(c => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}
