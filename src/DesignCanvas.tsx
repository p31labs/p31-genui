/**
 * @p31ca/genui — Craft.js Design canvas
 *
 * The editable surface for the Design artifact type. P31 trees are loaded
 * through `treeToCraft`, edited inside Craft.js `<Editor>` / `<Frame>`, and
 * emitted back as P31 trees through `craftToTree`.
 *
 * Everything here is prop-driven: no `window`, `document`, or other browser
 * globals are touched at module scope, so this module can be imported (and
 * typechecked) without a DOM.
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { Editor, Frame, useNode } from '@craftjs/core';
import { treeToCraft, craftToTree, type CraftTree } from './design-adapter.ts';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type CraftConfig<P> = {
  displayName?: string;
  isCanvas?: boolean;
  defaultProps?: Partial<P>;
  rules?: Record<string, unknown>;
};

type CraftComponent<P = Record<string, unknown>> = React.ComponentType<P> & {
  craft?: CraftConfig<P>;
};

export interface DesignCanvasProps {
  /** P31 tree to load into the editor. */
  tree: any;
  /** Called with the new P31 tree after an edit. */
  onChange?: (tree: any) => void;
  /** Whether the canvas accepts edits (default: true). */
  enabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

interface ChildrenProps {
  children?: React.ReactNode;
}

interface P31StackProps extends ChildrenProps {
  direction?: 'vertical' | 'horizontal';
  gap?: 'xs' | 'sm' | 'md' | 'lg';
}

interface P31CardProps extends ChildrenProps {
  title?: string;
  padding?: 'sm' | 'md' | 'lg';
}

interface P31TextProps {
  content?: string;
  size?: 'sm' | 'md' | 'lg';
  weight?: 'normal' | 'bold';
}

interface P31ButtonProps {
  label?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  onClick?: string;
}

interface P31BadgeProps {
  label?: string;
  variant?: 'default' | 'success' | 'warning' | 'error';
}

interface P31StatCardProps {
  label?: string;
  value?: string;
  trend?: 'up' | 'down' | 'neutral';
}

interface P31AlertProps {
  message?: string;
  severity?: 'info' | 'warning' | 'error' | 'success';
  /** Legacy alias used by early adapter fixtures. */
  variant?: 'info' | 'warning' | 'error' | 'success';
}

/* ------------------------------------------------------------------ */
/* Connectors                                                          */
/* ------------------------------------------------------------------ */

/**
 * Connect a DOM node to its Craft.js node and make it draggable.
 * Craft's connectors are chainable and return the element, so the ref
 * callback deliberately returns nothing.
 */
function useCraftConnector() {
  const {
    connectors: { connect, drag },
  } = useNode();

  return useCallback(
    (element: HTMLElement | null) => {
      if (element) connect(drag(element));
    },
    [connect, drag]
  );
}

/* ------------------------------------------------------------------ */
/* Design tokens (inline: no stylesheet import, no DOM at import time) */
/* ------------------------------------------------------------------ */

const GAP: Record<string, number> = { xs: 4, sm: 8, md: 12, lg: 24 };
const PADDING: Record<string, string> = { sm: '8px', md: '16px', lg: '24px' };
const FONT_SIZE: Record<string, number> = { sm: 12, md: 14, lg: 18 };

const BASE_FONT: React.CSSProperties = {
  fontFamily:
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  color: '#1f2328',
  lineHeight: 1.5,
};

const BUTTON_BG: Record<string, string> = {
  primary: '#1f6feb',
  secondary: '#6e7781',
  ghost: 'transparent',
};

const BADGE_TONE: Record<string, { background: string; color: string }> = {
  default: { background: '#eaeef2', color: '#424a53' },
  success: { background: '#dafbe1', color: '#116329' },
  warning: { background: '#fff8c5', color: '#7d4e00' },
  error: { background: '#ffebe9', color: '#a40e26' },
};

const ALERT_TONE: Record<string, { background: string; color: string; border: string }> = {
  info: { background: '#ddf4ff', color: '#0a3069', border: '#54aeff' },
  success: { background: '#dafbe1', color: '#116329', border: '#4ac26b' },
  warning: { background: '#fff8c5', color: '#7d4e00', border: '#d4a72c' },
  error: { background: '#ffebe9', color: '#a40e26', border: '#ff8182' },
};

/* ------------------------------------------------------------------ */
/* P31 user components                                                 */
/* ------------------------------------------------------------------ */

/**
 * The Craft.js root node. `treeToCraft` emits its ROOT wrapper with the
 * resolved name `P31Root`, so it has to exist in the resolver.
 */
export const P31Root: CraftComponent<ChildrenProps> = ({ children }) => {
  const setRef = useCraftConnector();
  return (
    <div ref={setRef} data-p31-component="Root" style={{ minHeight: 48 }}>
      {children}
    </div>
  );
};

P31Root.craft = { displayName: 'Root', isCanvas: true };

export const P31Stack: CraftComponent<P31StackProps> = ({
  direction = 'vertical',
  gap = 'md',
  children,
}) => {
  const setRef = useCraftConnector();
  return (
    <div
      ref={setRef}
      data-p31-component="Stack"
      style={{
        ...BASE_FONT,
        display: 'flex',
        flexDirection: direction === 'horizontal' ? 'row' : 'column',
        alignItems: direction === 'horizontal' ? 'center' : 'stretch',
        gap: GAP[gap] ?? GAP.md,
        minHeight: 24,
      }}
    >
      {children}
    </div>
  );
};

P31Stack.craft = {
  displayName: 'Stack',
  isCanvas: true,
  defaultProps: { direction: 'vertical', gap: 'md' },
};

export const P31Card: CraftComponent<P31CardProps> = ({ title, padding = 'md', children }) => {
  const setRef = useCraftConnector();
  return (
    <div
      ref={setRef}
      data-p31-component="Card"
      style={{
        ...BASE_FONT,
        border: '1px solid #d0d7de',
        borderRadius: 10,
        padding: PADDING[padding] ?? PADDING.md,
        background: '#ffffff',
        boxShadow: '0 1px 2px rgba(31, 35, 40, 0.06)',
        minHeight: 24,
      }}
    >
      {title ? (
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>{title}</div>
      ) : null}
      {children}
    </div>
  );
};

P31Card.craft = {
  displayName: 'Card',
  isCanvas: true,
  defaultProps: { padding: 'md' },
};

export const P31Text: CraftComponent<P31TextProps> = ({
  content = '',
  size = 'md',
  weight = 'normal',
}) => {
  const setRef = useCraftConnector();
  return (
    <span
      ref={setRef}
      data-p31-component="Text"
      style={{
        ...BASE_FONT,
        display: 'inline-block',
        fontSize: FONT_SIZE[size] ?? FONT_SIZE.md,
        fontWeight: weight === 'bold' ? 700 : 400,
      }}
    >
      {content}
    </span>
  );
};

P31Text.craft = {
  displayName: 'Text',
  defaultProps: { content: 'Text', size: 'md', weight: 'normal' },
};

export const P31Button: CraftComponent<P31ButtonProps> = ({
  label = 'Button',
  variant = 'primary',
  onClick,
}) => {
  const setRef = useCraftConnector();
  return (
    <button
      ref={setRef}
      type="button"
      data-p31-component="Button"
      data-p31-action={onClick || undefined}
      style={{
        ...BASE_FONT,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '8px 14px',
        borderRadius: 8,
        border: variant === 'ghost' ? '1px solid #d0d7de' : '1px solid transparent',
        background: BUTTON_BG[variant] ?? BUTTON_BG.primary,
        color: variant === 'ghost' ? '#1f2328' : '#ffffff',
        fontWeight: 600,
        fontSize: 14,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
};

P31Button.craft = {
  displayName: 'Button',
  defaultProps: { label: 'Button', variant: 'primary' },
};

export const P31Badge: CraftComponent<P31BadgeProps> = ({
  label = 'Badge',
  variant = 'default',
}) => {
  const setRef = useCraftConnector();
  const tone = BADGE_TONE[variant] ?? BADGE_TONE.default;
  return (
    <span
      ref={setRef}
      data-p31-component="Badge"
      style={{
        ...BASE_FONT,
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        background: tone.background,
        color: tone.color,
      }}
    >
      {label}
    </span>
  );
};

P31Badge.craft = {
  displayName: 'Badge',
  defaultProps: { label: 'Badge', variant: 'default' },
};

export const P31StatCard: CraftComponent<P31StatCardProps> = ({
  label = 'Metric',
  value = '0',
  trend,
}) => {
  const setRef = useCraftConnector();
  const arrow = trend === 'up' ? '↑' : trend === 'down' ? '↓' : trend === 'neutral' ? '→' : '';
  return (
    <div
      ref={setRef}
      data-p31-component="StatCard"
      style={{
        ...BASE_FONT,
        display: 'inline-flex',
        flexDirection: 'column',
        gap: 4,
        minWidth: 140,
        padding: PADDING.md,
        border: '1px solid #d0d7de',
        borderRadius: 10,
        background: '#f6f8fa',
      }}
    >
      <span style={{ fontSize: 12, color: '#57606a', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </span>
      <span style={{ fontSize: 24, fontWeight: 700 }}>
        {value}
        {arrow ? <span style={{ fontSize: 14, marginLeft: 6 }}>{arrow}</span> : null}
      </span>
    </div>
  );
};

P31StatCard.craft = {
  displayName: 'StatCard',
  defaultProps: { label: 'Metric', value: '0' },
};

export const P31Alert: CraftComponent<P31AlertProps> = ({
  message = '',
  severity,
  variant,
}) => {
  const setRef = useCraftConnector();
  const tone = ALERT_TONE[severity ?? variant ?? 'info'] ?? ALERT_TONE.info;
  return (
    <div
      ref={setRef}
      data-p31-component="Alert"
      role="alert"
      style={{
        ...BASE_FONT,
        padding: '10px 12px',
        borderRadius: 8,
        borderLeft: `4px solid ${tone.border}`,
        background: tone.background,
        color: tone.color,
        fontSize: 14,
      }}
    >
      {message}
    </div>
  );
};

P31Alert.craft = {
  displayName: 'Alert',
  defaultProps: { message: 'Alert', severity: 'info' },
};

/* ------------------------------------------------------------------ */
/* Resolver                                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolver names must stay in lockstep with COMPONENT_MAP in
 * design-adapter.ts. `design-canvas.test.mjs` imports both maps and fails if
 * this list drifts.
 */
export const P31_RESOLVER = {
  P31Card,
  P31Stack,
  P31Text,
  P31Button,
  P31Badge,
  P31StatCard,
  P31Alert,
};

/** Full resolver handed to Craft.js — the seven P31 components plus ROOT. */
export const DESIGN_RESOLVER: Record<string, CraftComponent<any>> = {
  ...P31_RESOLVER,
  P31Root,
};

/* ------------------------------------------------------------------ */
/* Canvas                                                              */
/* ------------------------------------------------------------------ */

/** Drop ids before building the load key: `craftToTree` omits generated ids. */
function withoutIds(node: any): any {
  if (!node || typeof node !== 'object') return node;
  const { id: _id, ...rest } = node;
  return {
    ...rest,
    children: Array.isArray(rest.children) ? rest.children.map(withoutIds) : [],
  };
}

/** Deterministic stringify so key order in the source tree cannot reload. */
function stableStringify(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Editable Craft.js surface for a P31 tree.
 *
 * The `tree` prop is the source of truth. Structural changes to `tree`
 * remount `<Frame>` and deserialize the new tree; edits inside the canvas
 * emit a P31 tree through `onChange`. Echoing an emitted tree back in does
 * not remount (ids are not part of the load key).
 */
export function DesignCanvas({
  tree,
  onChange,
  enabled = true,
  className,
  style,
}: DesignCanvasProps): React.ReactElement {
  const inputCraft = useMemo<CraftTree | undefined>(
    () => (tree ? treeToCraft(tree) : undefined),
    [tree]
  );

  const loadKey = useMemo(() => stableStringify(withoutIds(tree ?? null)), [tree]);

  // Editor snapshots its options on first render, so keep the current
  // callback in a ref instead of relying on option re-subscription.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const lastEmittedRef = useRef<string | null>(null);

  const handleNodesChange = useCallback((query: any) => {
    const nodes: CraftTree | undefined =
      typeof query?.getSerializedNodes === 'function' ? query.getSerializedNodes() : undefined;
    if (!nodes) return;

    const serialized = JSON.stringify(nodes);
    if (serialized === lastEmittedRef.current) return;
    lastEmittedRef.current = serialized;

    const nextTree = craftToTree(nodes);
    if (nextTree) onChangeRef.current?.(nextTree);
  }, []);

  return (
    <div
      className={className}
      style={style}
      data-p31-design-canvas="true"
      data-p31-design-enabled={enabled ? 'true' : 'false'}
    >
      <Editor
        resolver={DESIGN_RESOLVER}
        enabled={enabled}
        onNodesChange={handleNodesChange}
      >
        <Frame key={loadKey} data={inputCraft as any} />
      </Editor>
    </div>
  );
}

DesignCanvas.displayName = 'DesignCanvas';
