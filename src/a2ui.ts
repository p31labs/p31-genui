/**
 * @p31ca/genui — A2UI v0.9 Emitter
 *
 * Converts a compiled P31 UI tree to A2UI v0.9 messages.
 *
 * A2UI v0.9 messages (JSONL):
 *   1. createSurface — initialize a surface with a catalog ID
 *   2. updateComponents — flat component list with ID references
 *   3. updateDataModel — populate data bindings
 *
 * The adjacency dialect already matches v0.8's flat component format.
 * v0.9 uses the same flat format with renamed messages.
 *
 * Reference: https://a2ui.org/specification/v0_9/json/server_to_client.json
 */

import type { Catalog } from './catalog.ts';

export interface A2UIComponent {
  id: string;
  component: string;
  [key: string]: unknown;
}

export interface A2UIMessage {
  /** Wire-format version; every v0.9 message carries it. */
  version: 'v0.9';
  createSurface?: { surfaceId: string; catalogId?: string };
  updateComponents?: { surfaceId: string; components: A2UIComponent[] };
  // `contents` is the P31 dialect; `value` is the official v0.9 field.
  updateDataModel?: {
    surfaceId: string;
    path?: string;
    contents?: Record<string, unknown>;
    value?: Record<string, unknown>;
  };
}

export interface A2UIResult {
  messages: A2UIMessage[];
  surfaceId: string;
  catalogId: string;
}

let _counter = 0;

function nextId(prefix = 'c'): string {
  return `${prefix}${++_counter}`;
}

function resetCounter(): void {
  _counter = 0;
}

/**
 * Flatten a P31 tree into an A2UI component list.
 * Each node becomes a component with an id. Children are referenced by id.
 */
function flattenTree(node: any, components: A2UIComponent[], idMap: Map<any, string>): string {
  const id = node.id && typeof node.id === 'string' ? node.id : nextId();
  idMap.set(node, id);

  const comp: A2UIComponent = {
    id,
    component: node.component,
  };

  // Copy props (excluding children and id)
  if (node.props && typeof node.props === 'object') {
    for (const [k, v] of Object.entries(node.props)) {
      if (v !== null && v !== undefined) {
        comp[k] = v;
      }
    }
  }

  // Children as ID references
  if (Array.isArray(node.children) && node.children.length > 0) {
    const childIds: string[] = [];
    for (const child of node.children) {
      const childId = flattenTree(child, components, idMap);
      childIds.push(childId);
    }
    comp.children = childIds;
  } else {
    comp.children = [];
  }

  components.push(comp);
  return id;
}

/**
 * Extract data bindings from a tree into a flat data model.
 * Looks for {{path}} placeholders in props.
 */
function extractDataModel(node: any, dataModel: Record<string, unknown>, path = ''): void {
  if (!node || typeof node !== 'object') return;
  if (node.props && typeof node.props === 'object') {
    for (const [k, v] of Object.entries(node.props)) {
      if (typeof v === 'string') {
        const m = v.match(/\{\{\s*([^}]+?)\s*\}\}/);
        if (m) {
          const bindingPath = m[1].trim();
          if (bindingPath && !dataModel[bindingPath]) {
            dataModel[bindingPath] = null; // placeholder — populated by host
          }
        }
      }
    }
  }
  if (Array.isArray(node.children)) {
    node.children.forEach((c: any) => extractDataModel(c, dataModel));
  }
}

export function emitA2UI(tree: any, catalog?: Catalog, surfaceId = 'main'): A2UIResult {
  resetCounter();
  const components: A2UIComponent[] = [];
  const idMap = new Map<any, string>();

  const rootId = flattenTree(tree, components, idMap);

  const messages: A2UIMessage[] = [];

  // 1. createSurface
  messages.push({
    version: 'v0.9',
    createSurface: {
      surfaceId,
      catalogId: 'p31-catalog',
    },
  });

  // 2. updateComponents
  messages.push({
    version: 'v0.9',
    updateComponents: {
      surfaceId,
      components,
    },
  });

  // 3. updateDataModel (if there are bindings)
  const dataModel: Record<string, unknown> = {};
  extractDataModel(tree, dataModel);
  if (Object.keys(dataModel).length > 0) {
    messages.push({
      version: 'v0.9',
      updateDataModel: {
        surfaceId,
        path: '/',
        contents: dataModel,
      },
    });
  }

  return {
    messages,
    surfaceId,
    catalogId: 'p31-catalog',
  };
}

/**
 * The official A2UI v0.9 "basic" catalog. Third-party A2UI hosts render
 * against this; P31's own host renders against the `p31-catalog` superset.
 */
export const OFFICIAL_CATALOG_ID =
  'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json';

interface IdGen {
  claim(preferred: string): string;
  next(prefix: string): string;
}

function officialIdGen(): IdGen {
  const used = new Set<string>();
  let n = 0;
  return {
    claim(preferred) {
      let id = preferred;
      while (used.has(id)) id = `${preferred}-${++n}`;
      used.add(id);
      return id;
    },
    next(prefix) {
      let id = `${prefix}${++n}`;
      while (used.has(id)) id = `${prefix}${++n}`;
      used.add(id);
      return id;
    },
  };
}

/**
 * Project a P31 tree onto the official v0.9 "basic" catalog.
 *
 * The P31 catalog is a superset dialect (Stack, StatCard, Badge, Alert,
 * `content`/`title`/`label` props). This adapter lowers each P31 component
 * to the closest official component, synthesizing wrapper nodes where the
 * official schema is stricter (Card takes one `child`; Button takes a
 * `child` plus an `action`).
 *
 * Unmappable components throw — the failure is auditable, never silent.
 */
export function emitA2UIOfficial(tree: any, surfaceId = 'main'): A2UIResult {
  const components: A2UIComponent[] = [];
  const ids = officialIdGen();

  const push = (component: A2UIComponent): string => {
    components.push(component);
    return component.id;
  };

  const adapt = (node: any): string => {
    const props = node?.props ?? {};
    const kids: any[] = Array.isArray(node?.children) ? node.children : [];
    const preferred = typeof node?.id === 'string' && node.id ? node.id : ids.next('n');
    const id = ids.claim(preferred);

    switch (node?.component) {
      case 'Stack': {
        // Official v0.9 has Row/Column; Stack's `direction` selects one.
        return push({
          id,
          component: props.direction === 'horizontal' ? 'Row' : 'Column',
          children: kids.map(adapt),
        });
      }

      case 'Text': {
        const text: A2UIComponent = { id, component: 'Text', text: String(props.content ?? '') };
        if (props.size === 'lg' || props.weight === 'bold') text.variant = 'h3';
        else if (props.size === 'sm') text.variant = 'caption';
        return push(text);
      }

      case 'Card': {
        const childIds: string[] = [];
        if (typeof props.title === 'string' && props.title) {
          childIds.push(push({ id: ids.next(`${id}-title`), component: 'Text', text: props.title, variant: 'h3' }));
        }
        for (const kid of kids) childIds.push(adapt(kid));
        const child = childIds.length === 0
          ? push({ id: ids.next(`${id}-empty`), component: 'Text', text: '' })
          : childIds.length === 1
            ? childIds[0]
            : push({ id: ids.next(`${id}-content`), component: 'Column', children: childIds });
        return push({ id, component: 'Card', child });
      }

      case 'Button': {
        const labelId = push({ id: ids.next(`${id}-label`), component: 'Text', text: String(props.label ?? '') });
        const button: A2UIComponent = {
          id,
          component: 'Button',
          child: labelId,
          action: { event: { name: String(props.onClick ?? 'click') } },
        };
        if (props.variant === 'primary') button.variant = 'primary';
        else if (props.variant === 'ghost') button.variant = 'borderless';
        return push(button);
      }

      case 'Badge':
        return push({ id, component: 'Text', text: String(props.label ?? ''), variant: 'caption' });

      case 'StatCard': {
        const parts = [
          push({ id: ids.next(`${id}-label`), component: 'Text', text: String(props.label ?? ''), variant: 'caption' }),
          push({ id: ids.next(`${id}-value`), component: 'Text', text: String(props.value ?? ''), variant: 'h2' }),
        ];
        if (props.trend) {
          parts.push(push({
            id: ids.next(`${id}-trend`),
            component: 'Text',
            text: `trend: ${props.trend}`,
            variant: 'caption',
          }));
        }
        const child = push({ id: ids.next(`${id}-content`), component: 'Column', children: parts });
        return push({ id, component: 'Card', child });
      }

      case 'Alert': {
        const severity = props.severity ?? props.variant ?? 'info';
        const child = push({
          id: ids.next(`${id}-content`),
          component: 'Column',
          children: [
            push({ id: ids.next(`${id}-severity`), component: 'Text', text: String(severity), variant: 'caption' }),
            push({ id: ids.next(`${id}-message`), component: 'Text', text: String(props.message ?? '') }),
          ],
        });
        return push({ id, component: 'Card', child });
      }

      default:
        throw new Error(`emitA2UIOfficial: no v0.9 mapping for component "${node?.component}"`);
    }
  };

  adapt(tree);

  const messages: A2UIMessage[] = [
    {
      version: 'v0.9',
      createSurface: { surfaceId, catalogId: OFFICIAL_CATALOG_ID },
    },
    {
      version: 'v0.9',
      updateComponents: { surfaceId, components },
    },
  ];

  const dataModel: Record<string, unknown> = {};
  extractDataModel(tree, dataModel);
  if (Object.keys(dataModel).length > 0) {
    messages.push({
      version: 'v0.9',
      updateDataModel: { surfaceId, path: '/', value: dataModel },
    });
  }

  return { messages, surfaceId, catalogId: OFFICIAL_CATALOG_ID };
}

export function emitA2UIJsonl(result: A2UIResult): string {
  return result.messages.map(m => JSON.stringify(m)).join('\n');
}
