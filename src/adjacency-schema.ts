/**
 * @p31ca/genui — The per-component strict schema (the "adjacency" dialect).
 *
 * WHY A SECOND DIALECT (2026-10-22)
 *
 * The strict schema in `catalogToStrictJsonSchema` has one property that
 * makes it weak: the props bag is the UNION of every prop name in the
 * catalog, with every key required and nullable. That shape cannot say
 * WHICH props belong to WHICH component — `variant` is
 * `Button{primary,secondary,ghost}` but `Badge{default,success,warning,error}`,
 * and a flat bag accepts `Badge.variant: "primary"`, which the compiler
 * then rejects. So the strict decoder accepts trees the compiler refuses
 * (the wrong-valid rate), and the per-component contract has to travel in
 * the PROMPT instead (measured: it is worth +66.7 points of compile rate
 * on a held-out set).
 *
 * The review's proposal: make the schema per-component, and express the
 * tree as a FLAT ADJACENCY LIST so there is no recursion and no top-level
 * `anyOf` (the two things the probed providers rejected):
 *
 *   {
 *     "nodes": [
 *       { "id": "n1", "component": "Card", "props": { ... }, "childIds": ["n2"] },
 *       { "id": "n2", "component": "Badge", "props": { ... }, "childIds": [] }
 *     ]
 *   }
 *
 * The per-component prop shapes live in an `anyOf` at the ARRAY-ITEM level
 * (`items.anyOf`), not at the top level. Each branch is a full object
 * shape with `component` pinned to a `const`/single-value enum and the
 * props that component actually accepts.
 *
 * THIS IS A HYPOTHESIS until it is probed. The provider rules were
 * established by failing probes, so this dialect is probed the same way
 * (packages/genui/scripts/probe-schema-dialect.mjs): a decoder that
 * rejects `anyOf` at ANY level rejects the dialect, and the probe says so
 * instead of the arm silently measuring a broken schema.
 *
 * The dialect is OPT-IN (`--schema-dialect=adjacency`). The proven
 * dialect stays the default, because a measured arm must not change
 * meaning because a file changed.
 */

import type { Catalog } from './catalog.ts';

/** The dialects the harness can run under. */
export type SchemaDialect = 'union-nullable' | 'adjacency' | 'adjacency-nullable-free';

export const SCHEMA_DIALECTS: SchemaDialect[] = [
  'union-nullable',
  'adjacency',
  'adjacency-nullable-free',
];

/** The dialect's name, as the report and the capability cache spell it. */
export function dialectLabel(dialect: SchemaDialect | undefined): string {
  return dialect ?? 'union-nullable';
}

interface PropShape {
  type: string;
  enum?: string[];
  nullable: boolean;
}

/** The prop shape of ONE component, as the strict dialect spells it. */
function componentPropShape(
  catalog: Catalog,
  componentName: string,
  nullable: boolean,
): Record<string, object> {
  const entry = catalog.components[componentName];
  const _shape = (entry?.props as any)?._def?.shape; const shape = (typeof _shape === 'function' ? _shape() : _shape) ?? {};
  const properties: Record<string, object> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape as Record<string, any>)) {
    const core = unwrapSchema(value);
    const typeName = core?._def?.typeName ?? '';
    let kind = 'string';
    if (typeName === 'ZodEnum') kind = 'enum';
    else if (typeName === 'ZodNumber') kind = 'number';
    else if (typeName === 'ZodBoolean') kind = 'boolean';
    else if (typeName === 'ZodString') kind = 'string';
    else if (typeName === 'ZodArray') kind = 'array';

    const values = core?._def?.values;
    if (Array.isArray(values) && kind === 'enum') {
      const enumValues = values.map(String);
      properties[key] = nullable
        ? { type: ['string', 'null'], enum: [...enumValues, null] }
        : { type: 'string', enum: enumValues };
    } else if (kind === 'number') {
      properties[key] = nullable ? { type: ['number', 'null'] } : { type: 'number' };
    } else if (kind === 'boolean') {
      properties[key] = nullable ? { type: ['boolean', 'null'] } : { type: 'boolean' };
    } else {
      properties[key] = nullable ? { type: ['string', 'null'] } : { type: 'string' };
    }
    // Every key is required: the strict decoder demands it, and a key the
    // component does not accept must not be emitted at all.
    required.push(key);
  }

  return { properties, required };
}

/** Read through the Zod wrappers (ZodDefault -> ZodOptional -> ZodEnum). */
function unwrapSchema(value: any): any {
  let node = value;
  for (let i = 0; i < 6 && node; i++) {
    const name = node?._def?.typeName;
    if (name && !['ZodOptional', 'ZodNullable', 'ZodDefault'].includes(name)) return node;
    node = node?._def?.innerType;
  }
  return node;
}

/**
 * The adjacency dialect's strict schema.
 *
 * `nullable` controls the NULLABLE-FREE variant: one provider's route
 * rejected the nullable-union typing outright (`Mismatch type string with
 * value array` — measured 2026-10-21 on Kilo's minimax route), so the
 * dialect exists in both spellings and the probe decides which route can
 * take which.
 */
export function catalogToAdjacencyStrictJsonSchema(
  catalog: Catalog,
  options: { nullable?: boolean } = {},
): object {
  const nullable = options.nullable !== false;
  const componentNames = Object.keys(catalog.components);

  // One branch per component: the component name is PINNED and the props
  // are that component's own. This is the whole point of the dialect.
  const branches = componentNames.map((name) => {
    const { properties, required } = componentPropShape(catalog, name, nullable);
    return {
      type: 'object',
      additionalProperties: false,
      required: ['component', 'props'],
      properties: {
        component: { type: 'string', enum: [name] },
        props: {
          type: 'object',
          additionalProperties: false,
          properties,
          required,
        },
      },
    };
  });

  const nodeItem: Record<string, object> = {
    anyOf: branches,
  };

  return {
    type: 'object',
    additionalProperties: false,
    required: ['nodes'],
    properties: {
      nodes: {
        type: 'array',
        items: nodeItem,
      },
    },
  };
}

/**
 * Turn the flat adjacency list back into a TREE.
 *
 * The compiler works on trees, so the pipeline converts before it compiles.
 * The conversion is deliberately STRICT about structure — a dangling
 * childIds, a duplicate id or a cycle is a malformed tree and must fail
 * loudly rather than silently produce a partial tree (a partial tree
 * would score as a missing component and hide the real defect).
 */
export function adjacencyToTree(adjacency: any): {
  ok: boolean;
  tree?: any;
  error?: string;
} {
  if (!adjacency || typeof adjacency !== 'object') {
    return { ok: false, error: 'not an object' };
  }
  const nodes = adjacency.nodes;
  if (!Array.isArray(nodes)) return { ok: false, error: 'no nodes array' };

  const byId = new Map<string, any>();
  for (const node of nodes) {
    if (!node || typeof node !== 'object') return { ok: false, error: 'a node is not an object' };
    const id = node.id;
    if (typeof id !== 'string' || !id) return { ok: false, error: 'a node has no id' };
    if (byId.has(id)) return { ok: false, error: `duplicate node id ${id}` };
    byId.set(id, node);
  }

  // Build the tree, refusing a dangling reference or a cycle.
  const childOf = new Map<string, string[]>();
  for (const [id, node] of byId) {
    const childIds = node.childIds ?? [];
    if (!Array.isArray(childIds)) return { ok: false, error: `node ${id} has a non-array childIds` };
    for (const childId of childIds) {
      if (!byId.has(childId)) {
        return { ok: false, error: `node ${id} references unknown child ${childId}` };
      }
    }
    childOf.set(id, childIds);
  }

  const referenced = new Set<string>();
  for (const ids of childOf.values()) for (const c of ids) referenced.add(c);
  const roots = [...byId.keys()].filter((id) => !referenced.has(id));
  if (roots.length === 0) return { ok: false, error: 'every node is a child — the list has no root' };

  const build = (id: string, seen: Set<string>): any => {
    if (seen.has(id)) return { ok: false, error: `cycle at ${id}` };
    seen.add(id);
    const node = byId.get(id)!;
    const children: any[] = [];
    for (const childId of childOf.get(id) ?? []) {
      const child = build(childId, new Set(seen));
      if (child.ok === false) return child;
      children.push(child.tree);
    }
    return {
      ok: true,
      tree: {
        component: node.component,
        props: node.props ?? {},
        children,
        id: node.id,
      },
    };
  };

  const built = build(roots[0], new Set());
  if (built.ok === false) return built;
  return { ok: true, tree: built.tree };
}

/**
 * Flatten a TREE into the adjacency form.
 *
 * Used to build the reference answer for the adjacency dialect's own
 * contract test (and by anything that needs to hand a tree to a decoder
 * that speaks adjacency).
 */
export function treeToAdjacency(tree: any): {
  ok: boolean;
  adjacency?: any;
  error?: string;
} {
  const nodes: any[] = [];
  let counter = 0;
  const walk = (node: any): string | null => {
    if (!node || typeof node !== 'object') return null;
    const id = typeof node.id === 'string' && node.id ? node.id : `n${++counter}`;
    const children: string[] = [];
    for (const child of node.children ?? []) {
      const childId = walk(child);
      if (childId === null) return null;
      children.push(childId);
    }
    nodes.push({
      id,
      component: node.component,
      props: node.props ?? {},
      childIds: children,
    });
    return id;
  };
  const rootId = walk(tree);
  if (rootId === null) return { ok: false, error: 'the tree could not be flattened' };
  return { ok: true, adjacency: { nodes } };
}
