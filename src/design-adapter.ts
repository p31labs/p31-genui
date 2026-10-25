/**
 * @p31ca/genui — Craft.js Design adapter
 *
 * Converts between P31 compiled trees and Craft.js serialized node trees.
 * This enables the Design artifact type: visual editing via Craft.js,
 * agent-driven builds via MCP, and screenshot-based verification.
 *
 * Craft.js SerializedNode shape:
 *   { type: { resolvedName: string }, props: {...}, nodes: string[], ... }
 *
 * P31 tree shape:
 *   { component: string, props: {...}, children: [...], id: string }
 */

export interface CraftNode {
  type: { resolvedName: string };
  isCanvas?: boolean;
  props: Record<string, unknown>;
  nodes: string[];
  linkedNodes?: Record<string, string>;
  custom?: Record<string, unknown>;
  displayName?: string;
  hidden?: boolean;
  parent?: string;
}

export interface CraftTree {
  [nodeId: string]: CraftNode;
}

// Map P31 component names to Craft.js resolved names
const COMPONENT_MAP: Record<string, string> = {
  Card: 'P31Card',
  Stack: 'P31Stack',
  Text: 'P31Text',
  Button: 'P31Button',
  Badge: 'P31Badge',
  StatCard: 'P31StatCard',
  Alert: 'P31Alert',
};

const REVERSE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(COMPONENT_MAP).map(([k, v]) => [v, k])
);

let _counter = 0;
function nextId(): string { return `node-${++_counter}`; }
export function resetDesignCounter(): void { _counter = 0; }

/**
 * Convert a P31 tree to a Craft.js serialized node tree.
 */
export function treeToCraft(tree: any): CraftTree {
  resetDesignCounter();
  const result: CraftTree = {};
  const rootId = 'ROOT';

  function convert(node: any, parentId?: string): string {
    const id = node.id && typeof node.id === 'string' ? node.id : nextId();
    const resolvedName = COMPONENT_MAP[node?.component] || 'P31Text';

    const childIds: string[] = [];
    if (Array.isArray(node?.children)) {
      for (const child of node.children) {
        childIds.push(convert(child, id));
      }
    }

    result[id] = {
      type: { resolvedName },
      isCanvas: node?.component === 'Stack' || node?.component === 'Card',
      props: cloneProps(node?.props),
      nodes: childIds,
      displayName: node?.component || 'Text',
      parent: parentId,
    };

    return id;
  }

  const rootChildId = convert(tree);
  // Wrap in ROOT node
  result[rootId] = {
    type: { resolvedName: 'P31Root' },
    isCanvas: true,
    props: {},
    nodes: [rootChildId],
    displayName: 'Root',
  };
  // Update root child's parent
  if (result[rootChildId]) {
    result[rootChildId].parent = rootId;
  }

  return result;
}

/**
 * Convert a Craft.js serialized node tree back to a P31 tree.
 */
export function craftToTree(craft: CraftTree): any {
  if (!craft || typeof craft !== 'object') return undefined;

  const byId = new Map(Object.entries(craft));
  const referenced = new Set<string>();
  for (const node of Object.values(craft)) {
    if (Array.isArray(node?.nodes)) {
      for (const c of node.nodes) referenced.add(c);
    }
  }

  // Find root's first child (skip ROOT wrapper)
  const rootNode = craft['ROOT'];
  if (!rootNode || !Array.isArray(rootNode.nodes) || rootNode.nodes.length === 0) {
    return undefined;
  }

  function build(id: string): any {
    const node = craft[id];
    if (!node) return undefined;

    const component = REVERSE_MAP[node.type?.resolvedName] || 'Text';
    const result: any = {
      component,
      props: cloneProps(node.props),
      children: [],
    };

    // Preserve id if it looks like a P31 id
    if (typeof id === 'string' && !id.startsWith('node-')) {
      result.id = id;
    }

    if (Array.isArray(node.nodes)) {
      for (const childId of node.nodes) {
        const child = build(childId);
        if (child) result.children.push(child);
      }
    }

    return result;
  }

  const rootChildId = rootNode.nodes[0];
  return build(rootChildId);
}

function cloneProps(props: any): Record<string, unknown> {
  if (!props || typeof props !== 'object') return {};
  try { return structuredClone(props); }
  catch { return JSON.parse(JSON.stringify(props)); }
}

export function isCanvasComponent(component: string): boolean {
  return component === 'Stack' || component === 'Card';
}

export { COMPONENT_MAP, REVERSE_MAP };
