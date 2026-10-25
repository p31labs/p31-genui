/**
 * @p31ca/genui — Component Catalog
 *
 * Derived from design-core's auto-generated catalog.
 * Each entry has a description the model reads, a Zod prop schema,
 * and slot rules the compiler enforces.
 *
 * This is the allowlist. The model can only use these components.
 */

import { z } from 'zod';

export interface CatalogEntry {
  name: string;
  description: string;
  props: z.ZodObject<any>;
  slots: string[]; // allowed child component names, empty = leaf
  examples: string[];
}

export interface Catalog {
  components: Record<string, CatalogEntry>;
  version: string;
}

// Core P31 component catalog — derived from design-core COMPONENT_CATALOG
// but in a model-consumable shape (Zod schemas + descriptions + examples).
export const P31_CATALOG: Catalog = {
  version: '1.0.0',
  components: {
    Card: {
      name: 'Card',
      description: 'A container with optional title and padding. Use for grouping related content.',
      props: z.object({
        title: z.string().optional(),
        padding: z.enum(['sm', 'md', 'lg']).optional().default('md'),
      }),
      slots: ['*'], // accepts any component
      examples: [
        '{ "component": "Card", "props": { "title": "LOVE Balance" }, "children": [...] }',
      ],
    },
    Stack: {
      name: 'Stack',
      description: 'Layout children vertically or horizontally with consistent gap.',
      props: z.object({
        direction: z.enum(['vertical', 'horizontal']).optional().default('vertical'),
        gap: z.enum(['sm', 'md', 'lg']).optional().default('md'),
      }),
      slots: ['*'],
      examples: [
        '{ "component": "Stack", "props": { "direction": "horizontal", "gap": "sm" }, "children": [...] }',
      ],
    },
    Button: {
      name: 'Button',
      description: 'A clickable button with label and variant.',
      props: z.object({
        label: z.string(),
        variant: z.enum(['primary', 'secondary', 'ghost']).optional().default('primary'),
        onClick: z.string().optional(), // action name, not code
      }),
      slots: [],
      examples: [
        '{ "component": "Button", "props": { "label": "Submit", "variant": "primary" } }',
      ],
    },
    Text: {
      name: 'Text',
      description: 'Display text content. Use for labels, descriptions, or static content.',
      props: z.object({
        content: z.string(),
        size: z.enum(['sm', 'md', 'lg']).optional().default('md'),
        weight: z.enum(['normal', 'bold']).optional().default('normal'),
      }),
      slots: [],
      examples: [
        '{ "component": "Text", "props": { "content": "Hello", "size": "lg", "weight": "bold" } }',
      ],
    },
    Badge: {
      name: 'Badge',
      description: 'Compact status label. Use for tags, counts, or status indicators.',
      props: z.object({
        label: z.string(),
        variant: z.enum(['default', 'success', 'warning', 'error']).optional().default('default'),
      }),
      slots: [],
      examples: [
        '{ "component": "Badge", "props": { "label": "Active", "variant": "success" } }',
      ],
    },
    StatCard: {
      name: 'StatCard',
      description: 'Display a single metric with label and value. Use for dashboards.',
      props: z.object({
        label: z.string(),
        value: z.string(),
        trend: z.enum(['up', 'down', 'neutral']).optional(),
      }),
      slots: [],
      examples: [
        '{ "component": "StatCard", "props": { "label": "LOVE Balance", "value": "42", "trend": "up" } }',
      ],
    },
    Alert: {
      name: 'Alert',
      description: 'Display an alert message with severity. Use for warnings or notifications.',
      props: z.object({
        message: z.string(),
        severity: z.enum(['info', 'warning', 'error', 'success']).optional().default('info'),
      }),
      slots: [],
      examples: [
        '{ "component": "Alert", "props": { "message": "Low spoons", "severity": "warning" } }',
      ],
    },
  },
};

export function getCatalog(): Catalog {
  return P31_CATALOG;
}

export function getComponentNames(catalog: Catalog): string[] {
  return Object.keys(catalog.components);
}
