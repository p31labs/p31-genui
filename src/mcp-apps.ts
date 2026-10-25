/**
 * @p31ca/genui — MCP Apps (SEP-1865) ui:// emitter
 *
 * Converts a compiled P31 UI tree (JSON: component/props/children/id) into a
 * self-contained HTML page that MCP hosts (Claude, ChatGPT, VS Code, Goose)
 * render inside a sandboxed iframe under a `ui://` resource.
 *
 * The server's role is purely declarative: this module only produces the
 * HTML payload + the resource URI + the CSP declaration. It performs no
 * provider calls and no network I/O.
 *
 * Spec references (modelcontextprotocol/ext-apps):
 *   - resource URI scheme:  ui://<server>/<path>
 *   - MIME type:            text/html;profile=mcp-app
 *   - tool metadata:        _meta.ui.resourceUri  (preferred)
 *                           _meta["ui/resourceUri"] (legacy)
 *   - resource metadata:    _meta.ui.csp  (connectDomains, resourceDomains,
 *                                          frameDomains, baseUriDomains)
 *   - capability:           io.modelcontextprotocol/ui
 *   - iframe:               sandboxed (allow-scripts; no same-origin)
 */

import type { Catalog } from './catalog.ts';
import type { UITreeNode } from './compile.ts';

export interface McpAppCsp {
  /** Origins for fetch/XHR/WebSocket. Empty = no network (secure default). */
  connectDomains: string[];
  /** Origins for images/scripts/styles/fonts/media. Empty = none. */
  resourceDomains: string[];
  /** Origins for nested iframes. Empty = frame-src 'none'. */
  frameDomains: string[];
  /** Allowed base URIs. Empty = base-uri 'self'. */
  baseUriDomains: string[];
}

export interface McpAppEmission {
  /** Self-contained HTML page, renderable in a sandboxed iframe. */
  html: string;
  /** The ui:// resource URI the tool's _meta.ui.resourceUri should point at. */
  resourceUri: string;
  /** Deny-by-default CSP declaration for _meta.ui.csp. */
  csp: McpAppCsp;
}

export interface EmitMcpAppOptions {
  /** Override the generated resource URI. */
  resourceUri?: string;
  /** Document title. Defaults to "P31 GenUI". */
  title?: string;
}

const COMPONENT_DEFAULTS: Record<string, Record<string, unknown>> = {
  Card: { padding: 'md' },
  Stack: { direction: 'vertical', gap: 'md' },
  Button: { variant: 'primary' },
  Text: { size: 'md', weight: 'normal' },
  Badge: { variant: 'default' },
  Alert: { severity: 'info' },
};

function propOf(node: UITreeNode, key: string): unknown {
  const props = (node.props ?? {}) as Record<string, unknown>;
  if (props[key] !== undefined && props[key] !== null) return props[key];
  return COMPONENT_DEFAULTS[node.component]?.[key];
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderNode(node: UITreeNode): string {
  const comp = node.component;
  const idAttr = node.id ? ` id="${esc(node.id)}"` : '';
  const marker =
    `class="genui-${esc(comp).toLowerCase()} p31-${esc(comp).toLowerCase()}" ` +
    `data-component="${esc(comp)}" data-genui-component="${esc(comp)}"`;
  const children = (node.children ?? []).map(renderNode).join('');

  switch (comp) {
    case 'Card': {
      const title = propOf(node, 'title');
      const padding = propOf(node, 'padding');
      return `<section ${marker}${idAttr} data-padding="${esc(padding)}">
  ${title != null ? `<header class="genui-card__title p31-card__title">${esc(title)}</header>` : ''}
  <div class="genui-card__body p31-card__body" data-padding="${esc(padding)}">${children}</div>
</section>`;
    }
    case 'Stack': {
      const direction = propOf(node, 'direction');
      const gap = propOf(node, 'gap');
      return `<div ${marker}${idAttr} data-direction="${esc(direction)}" data-gap="${esc(gap)}" data-layout="stack">${children}</div>`;
    }
    case 'Button': {
      const label = propOf(node, 'label');
      const variant = propOf(node, 'variant');
      const onClick = propOf(node, 'onClick');
      const actionAttr = onClick != null ? ` data-action="${esc(onClick)}"` : '';
      return `<button type="button" ${marker}${idAttr} data-variant="${esc(variant)}"${actionAttr}>${esc(label)}</button>`;
    }
    case 'Text': {
      const content = propOf(node, 'content');
      const size = propOf(node, 'size');
      const weight = propOf(node, 'weight');
      return `<p ${marker}${idAttr} data-size="${esc(size)}" data-weight="${esc(weight)}">${esc(content)}</p>`;
    }
    case 'Badge': {
      const label = propOf(node, 'label');
      const variant = propOf(node, 'variant');
      return `<span ${marker}${idAttr} data-variant="${esc(variant)}">${esc(label)}</span>`;
    }
    case 'StatCard': {
      const label = propOf(node, 'label');
      const value = propOf(node, 'value');
      const trend = propOf(node, 'trend');
      const trendAttr = trend != null ? ` data-trend="${esc(trend)}"` : '';
      const trendEl = trend != null ? `<div class="genui-statcard__trend p31-statcard__trend" data-trend="${esc(trend)}">${esc(trend)}</div>` : '';
      return `<div ${marker}${idAttr}${trendAttr} data-label="${esc(label)}" data-value="${esc(value)}">
  <div class="genui-statcard__label p31-statcard__label">${esc(label)}</div>
  <div class="genui-statcard__value p31-statcard__value">${esc(value)}</div>
  ${trendEl}
</div>`;
    }
    case 'Alert': {
      const message = propOf(node, 'message');
      const severity = propOf(node, 'severity');
      return `<div ${marker}${idAttr} role="alert" data-severity="${esc(severity)}">${esc(message)}</div>`;
    }
    default: {
      return `<div ${marker}${idAttr} data-unknown="true">Unknown component: ${esc(comp)}</div>`;
    }
  }
}

function hashTree(tree: UITreeNode): string {
  // Pure (browser-safe) FNV-1a 32-bit hash of the canonical JSON.
  const str = JSON.stringify(tree);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const INLINE_CSS = `
  :root {
    --p31-bg: #0a0a0f;
    --p31-text: #f5f5f7;
    --p31-muted: rgba(245,245,247,0.65);
    --p31-accent: #00f0ff;
    --p31-success: #22c55e;
    --p31-warning: #fbbf24;
    --p31-error: #ef4444;
    --p31-info: #60a5fa;
    --p31-card-bg: rgba(255,255,255,0.04);
    --p31-card-border: rgba(255,255,255,0.08);
    --p31-radius: 10px;
    --p31-font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --p31-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--p31-bg);
    color: var(--p31-text);
    font-family: var(--p31-font);
    font-size: 14px;
    line-height: 1.45;
    padding: 16px;
  }
  .genui-card, .p31-card {
    background: var(--p31-card-bg);
    border: 1px solid var(--p31-card-border);
    border-radius: var(--p31-radius);
    padding: 12px;
    margin: 8px 0;
  }
  .genui-card__title, .p31-card__title { font-weight: 700; margin: 0 0 8px; font-size: 15px; }
  .genui-card__body, .p31-card__body { display: flex; flex-direction: column; gap: 8px; }
  .genui-stack, .p31-stack { display: flex; gap: 8px; }
  .genui-stack[data-direction="vertical"], .p31-stack[data-direction="vertical"] { flex-direction: column; }
  .genui-stack[data-direction="horizontal"], .p31-stack[data-direction="horizontal"] { flex-direction: row; flex-wrap: wrap; }
  .genui-stack[data-gap="sm"], .p31-stack[data-gap="sm"] { gap: 4px; }
  .genui-stack[data-gap="md"], .p31-stack[data-gap="md"] { gap: 8px; }
  .genui-stack[data-gap="lg"], .p31-stack[data-gap="lg"] { gap: 16px; }
  .genui-button, .p31-button {
    border: 1px solid var(--p31-card-border);
    background: var(--p31-card-bg);
    color: var(--p31-text);
    border-radius: 8px;
    padding: 8px 14px;
    font: inherit;
    cursor: pointer;
  }
  .genui-button[data-variant="primary"], .p31-button[data-variant="primary"] {
    background: var(--p31-accent); color: #000; border-color: transparent; font-weight: 600;
  }
  .genui-button[data-variant="secondary"], .p31-button[data-variant="secondary"] { background: rgba(255,255,255,0.08); }
  .genui-button[data-variant="ghost"], .p31-button[data-variant="ghost"] { background: transparent; }
  .genui-text, .p31-text { margin: 4px 0; }
  .genui-text[data-size="sm"], .p31-text[data-size="sm"] { font-size: 12px; }
  .genui-text[data-size="md"], .p31-text[data-size="md"] { font-size: 14px; }
  .genui-text[data-size="lg"], .p31-text[data-size="lg"] { font-size: 18px; }
  .genui-text[data-weight="bold"], .p31-text[data-weight="bold"] { font-weight: 700; }
  .genui-badge, .p31-badge {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 600; background: rgba(255,255,255,0.08);
  }
  .genui-badge[data-variant="success"], .p31-badge[data-variant="success"] { background: rgba(34,197,94,0.18); color: var(--p31-success); }
  .genui-badge[data-variant="warning"], .p31-badge[data-variant="warning"] { background: rgba(251,191,36,0.18); color: var(--p31-warning); }
  .genui-badge[data-variant="error"], .p31-badge[data-variant="error"] { background: rgba(239,68,68,0.18); color: var(--p31-error); }
  .genui-statcard, .p31-statcard {
    background: var(--p31-card-bg); border: 1px solid var(--p31-card-border);
    border-radius: var(--p31-radius); padding: 12px; margin: 8px 0;
  }
  .genui-statcard__label, .p31-statcard__label { font-size: 11px; color: var(--p31-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .genui-statcard__value, .p31-statcard__value { font-size: 24px; font-weight: 700; margin-top: 4px; }
  .genui-statcard__trend, .p31-statcard__trend { font-size: 11px; color: var(--p31-muted); margin-top: 2px; }
  .genui-alert, .p31-alert {
    border-radius: 8px; padding: 10px 12px; margin: 8px 0; border: 1px solid var(--p31-card-border);
  }
  .genui-alert[data-severity="info"], .p31-alert[data-severity="info"] { background: rgba(96,165,250,0.12); color: var(--p31-info); }
  .genui-alert[data-severity="warning"], .p31-alert[data-severity="warning"] { background: rgba(251,191,36,0.12); color: var(--p31-warning); }
  .genui-alert[data-severity="error"], .p31-alert[data-severity="error"] { background: rgba(239,68,68,0.12); color: var(--p31-error); }
  .genui-alert[data-severity="success"], .p31-alert[data-severity="success"] { background: rgba(34,197,94,0.12); color: var(--p31-success); }
`;

export function emitMcpApp(
  tree: UITreeNode,
  catalog: Catalog,
  options: EmitMcpAppOptions = {},
): McpAppEmission {
  // `catalog` is accepted for API compatibility / future component resolution;
  // rendering is driven by the allowlisted P31 component set above.
  void catalog;

  const title = options.title ?? 'P31 GenUI';
  const body = renderNode(tree);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${INLINE_CSS}
</style>
</head>
<body>
<main id="p31-genui-root" data-genui="root" data-mcp-app="true">
${body}
</main>
</body>
</html>`;

  const resourceUri = options.resourceUri ?? `ui://p31/genui/${hashTree(tree)}.html`;

  const csp: McpAppCsp = {
    connectDomains: [],
    // 'unsafe-inline' is required because the emitted HTML uses inline
    // <style> and <script> tags. A host enforcing default-src 'none' will
    // block them unless the CSP explicitly allows inline content.
    resourceDomains: ["'unsafe-inline'"],
    frameDomains: [],
    baseUriDomains: [],
  };

  return { html, resourceUri, csp };
}

export default emitMcpApp;
