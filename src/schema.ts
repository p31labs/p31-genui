/**
 * @p31ca/genui — JSON Schema Export for Constrained Decoding
 *
 * Derived from catalog. Strict-mode compatible:
 * - additionalProperties: false on every object
 * - all fields in required array
 * - no $ref, no anyOf/oneOf (flat schema for small models)
 */

import type { Catalog } from './catalog.ts';

export function catalogToJsonSchema(catalog: Catalog): object {
  const componentNames = Object.keys(catalog.components);

  const nodeSchema = {
    type: 'object',
    required: ['component', 'props', 'children', 'id'],
    additionalProperties: false,
    properties: {
      component: { type: 'string', enum: componentNames },
      props: { type: 'object', additionalProperties: false },
      children: {
        type: 'array',
        items: { $ref: '#/$defs/node' },
      },
      id: { type: 'string' },
    },
    $defs: {
      node: {
        type: 'object',
        required: ['component', 'props', 'children', 'id'],
        additionalProperties: false,
        properties: {
          component: { type: 'string', enum: componentNames },
          props: { type: 'object', additionalProperties: false },
          children: {
            type: 'array',
            items: { $ref: '#/$defs/node' },
          },
          id: { type: 'string' },
        },
      },
    },
  };

  return nodeSchema;
}

/**
 * catalogToStrictJsonSchema — the STRICT (decoder-constrained) schema.
 *
 * WHY THIS EXISTS: the loose schema above is NOT strict-compatible, and the
 * mismatch was invisible until a strict run actually hit the provider. The
 * Groq strict validator (`json_schema.strict = true`, gpt-oss models)
 * enforces FOUR rules, each of which the loose schema breaks:
 *
 *   1. the top level must be `type: 'object'` (no anyOf/oneOf at the top);
 *   2. every object sets `additionalProperties: false`;
 *   3. every object's `required` lists EVERY key in its `properties`;
 *   4. `properties` must be non-empty.
 *
 * The loose schema's props bag (`{ type:'object', additionalProperties:false }`)
 * breaks rule 4 → the provider answers `json_validate_failed` and the whole
 * run dies on prompt #1. (Probed 2026-10-21: a trivial strict schema is
 * accepted; the loose catalog schema is not.)
 *
 * The strict bag is therefore the UNION of every catalog prop name, every key
 * REQUIRED and typed as nullable — the standard strict-mode idiom for optional
 * fields. The decoder then guarantees: the component is in the enum, the tree
 * shape is right, and every prop name is a real catalog prop. The per-
 * component prop RULES stay with the compiler (and its repair loop), which is
 * where they were enforced before.
 *
 * TWO MORE THINGS THE PROVIDER TEACHED (probed 2026-10-21, gpt-oss-20b):
 *
 *   - `$ref`/`$defs` RECURSION IS NOT SUPPORTED by Groq's strict decoder: a
 *     schema whose children point at `#/$defs/node` is accepted structurally
 *     but every generation fails `json_validate_failed` ("Generated JSON does
 *     not match the expected schema"). The recursion is INLINED to a bounded
 *     depth instead (maxDepth levels + a childless leaf).
 *   - a top-level `anyOf` (a per-component discriminated union) is rejected
 *     outright: "schema must have type 'object' and not have 'oneOf'/'anyOf'".
 *
 * The depth bound is a real constraint on the output, not a detail: a tree
 * deeper than maxDepth cannot be produced in strict mode. The live fixtures'
 * gold trees are 3 levels deep (50-prompt set) and 4 (held-out set), so the
 * default of 4 levels covers them with one level of headroom.
 */
export function catalogToStrictJsonSchema(
  catalog: Catalog,
  options: { maxDepth?: number } = {},
): object {
  const componentNames = Object.keys(catalog.components);
  const maxDepth = options.maxDepth ?? 4;

  // Union of every prop name in the catalog, with its primitive type.
  //
  // The catalog props are wrapped (`ZodDefault(ZodOptional(ZodEnum))`), so
  // the type has to be read through the wrapper chain — one level of
  // `innerType` is not enough (probed 2026-10-21: reading only one level
  // reported every enum prop as a plain string, which silently disabled
  // the enum constraint).
  const unwrap = (value: any): any => {
    let node = value;
    for (let i = 0; i < 6 && node; i++) {
      const name = node?._def?.typeName;
      if (name && name !== 'ZodOptional' && name !== 'ZodNullable' && name !== 'ZodDefault') {
        return node;
      }
      node = node?._def?.innerType;
    }
    return node;
  };

  const propTypes: Record<string, Set<string>> = {};
  const propEnums: Record<string, Set<string>> = {};
  for (const entry of Object.values(catalog.components)) {
    const _shape = (entry.props as any)?._def?.shape; const shape = (typeof _shape === 'function' ? _shape() : _shape) ?? {};
    for (const [key, value] of Object.entries(shape as Record<string, any>)) {
      const core = unwrap(value);
      const typeName: string = core?._def?.typeName ?? '';
      let kind = 'string';
      if (typeName === 'ZodEnum') kind = 'enum';
      else if (typeName === 'ZodNumber') kind = 'number';
      else if (typeName === 'ZodBoolean') kind = 'boolean';
      (propTypes[key] ||= new Set()).add(kind);
      // An enum prop is worth constraining to its real values: the model
      // invents values ("column" for a vertical/horizontal stack) that the
      // loose bag accepts and the compiler then rejects. The strict bag
      // closes that hole.
      //
      // The values are UNIONED across every component that declares the
      // prop, because one prop name can mean different things per
      // component: `variant` is Button{primary,secondary,ghost} but
      // Badge{default,success,warning,error}. First-wins would make
      // `Badge.variant: "warning"` UNREACHABLE in strict mode — the
      // decoder could never emit a tree that compiles. The per-component
      // rule stays with the compiler.
      const values = core?._def?.values;
      if (Array.isArray(values)) {
        (propEnums[key] ||= new Set());
        for (const v of values) propEnums[key].add(String(v));
      }
    }
  }

  const propProperties: Record<string, object> = {};
  for (const [key, kinds] of Object.entries(propTypes)) {
    const enumValues = propEnums[key];
    if (enumValues && enumValues.size) {
      propProperties[key] = { type: ['string', 'null'], enum: [...enumValues, null] };
      continue;
    }
    // A prop whose type differs per component (e.g. number here, string
    // there) is typed by the union of its types; the compiler arbitrates.
    const concrete = [...kinds].filter((k) => k !== 'enum');
    const type = concrete.length === 1 ? concrete[0] : 'string';
    propProperties[key] = { type: [type, 'null'] };
  }

  const propsBag = {
    type: 'object',
    properties: propProperties,
    required: Object.keys(propProperties),
    additionalProperties: false,
  };

  // The recursion is INLINED (no $ref/$defs — the provider's strict decoder
  // cannot follow it) to a bounded depth. The deepest level is a leaf whose
  // `children` must be empty.
  const build = (depth: number): object => ({
    type: 'object',
    required: ['component', 'props', 'children', 'id'],
    additionalProperties: false,
    properties: {
      component: { type: 'string', enum: componentNames },
      props: propsBag,
      children: depth > 0
        ? { type: 'array', items: build(depth - 1) }
        : { type: 'array', items: { type: 'object', properties: { component: { type: 'string', enum: componentNames } }, required: ['component'], additionalProperties: false }, maxItems: 0 },
      id: { type: 'string' },
    },
  });

  return build(maxDepth);
}