#!/usr/bin/env node
/**
 * adjacency-dialect.test.mjs — the contract test for the per-component
 * schema dialect.
 *
 * The dialect is a HYPOTHESIS about what a provider's strict decoder will
 * accept (packages/genui/scripts/probe-schema-dialect.mjs probes it per
 * route). Two things must hold REGARDLESS of what any provider says:
 *
 *   1. THE SCHEMA RESPECTS THE PROBED RULES. Every object sets
 *      `additionalProperties: false`; every object's `required` lists EVERY
 *      key in its `properties`; `properties` is non-empty; there is no
 *      recursion ($ref/$defs); and the `anyOf` is at the ARRAY-ITEM level,
 *      never at the top level. Those are the rules the providers were
 *      probed against, and a dialect that breaks one is dead on arrival.
 *
 *   2. THE ROUND TRIP IS LOSSLESS. tree -> adjacency -> tree must give
 *      back the same tree, because the pipeline converts the model's
 *      flat list back into a tree before the compiler sees it. A lossy
 *      round trip would silently change what is being measured.
 *
 * A malformed list must be REFUSED (dangling childIds, a duplicate id, a
 * cycle, no root): a partial tree would score as a missing component and
 * hide the real defect.
 */
import { getCatalog } from '../src/catalog.ts';
import { compile } from '../src/compile.ts';
import {
  catalogToAdjacencyStrictJsonSchema,
  adjacencyToTree,
  treeToAdjacency,
} from '../src/adjacency-schema.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const catalog = getCatalog();

/** Walk a schema and report the rule violations the providers rejected. */
function inspectSchema(node, path = '$', violations = []) {
  if (!node || typeof node !== 'object') return violations;
  if (Array.isArray(node)) {
    node.forEach((child, i) => inspectSchema(child, `${path}[${i}]`, violations));
    return violations;
  }
  if (node.type === 'object') {
    const props = node.properties ?? {};
    const propKeys = Object.keys(props);
    if (node.additionalProperties !== false) {
      violations.push(`${path}: additionalProperties is not false`);
    }
    if (propKeys.length === 0) {
      violations.push(`${path}: properties is empty`);
    }
    const required = node.required ?? [];
    for (const key of propKeys) {
      if (!required.includes(key)) {
        violations.push(`${path}: required does not list "${key}"`);
      }
    }
    for (const key of required) {
      if (!propKeys.includes(key)) {
        violations.push(`${path}: required lists "${key}", which is not in properties`);
      }
    }
  }
  if (node.$ref || node.$defs) {
    violations.push(`${path}: uses $ref/$defs (the probed decoders cannot follow recursion)`);
  }
  if (node.anyOf && !path.includes('items')) {
    violations.push(`${path}: anyOf outside an array item (the probed decoders reject a top-level anyOf)`);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === 'properties') {
      for (const [propName, propSchema] of Object.entries(child)) {
        inspectSchema(propSchema, `${path}.${propName}`, violations);
      }
    } else {
      inspectSchema(child, `${path}.${key}`, violations);
    }
  }
  return violations;
}

for (const nullable of [true, false]) {
  const name = nullable ? 'adjacency' : 'adjacency-nullable-free';
  const schema = catalogToAdjacencyStrictJsonSchema(catalog, { nullable });
  const violations = inspectSchema(schema);
  check(
    violations.length === 0,
    `${name}: the schema respects every probed provider rule`,
    violations.slice(0, 4).join(' | '),
  );
  check(
    schema.type === 'object' && !schema.anyOf,
    `${name}: the top level is a plain object (no top-level anyOf)`,
  );
  check(
    Array.isArray(schema.properties?.nodes?.items?.anyOf),
    `${name}: the per-component anyOf is at the array-item level`,
  );
  check(
    schema.properties?.nodes?.items?.anyOf?.length === Object.keys(catalog.components).length,
    `${name}: there is one branch per component`,
  );
  if (!nullable) {
    const json = JSON.stringify(schema);
    check(!json.includes('"null"'), `${name}: no nullable typing anywhere`);
  }
}

// --- the round trip ------------------------------------------------------
const goldSpecs = JSON.parse(
  (await import('fs')).readFileSync(
    new URL('../fixtures/live-prompts.json', import.meta.url),
    'utf8',
  ),
);

let roundTripOk = 0;
let roundTripTotal = 0;
for (const spec of goldSpecs) {
  roundTripTotal++;
  const flattened = treeToAdjacency(spec.goldTree);
  if (!flattened.ok) {
    check(false, `${spec.id}: the gold tree flattens`, flattened.error);
    continue;
  }
  const restored = adjacencyToTree(flattened.adjacency);
  if (!restored.ok) {
    check(false, `${spec.id}: the flat list restores`, restored.error);
    continue;
  }
  // The restored tree must compile AND carry the same components.
  const compiled = compile(restored.tree, catalog);
  const sameShape = JSON.stringify(stripIds(spec.goldTree)) === JSON.stringify(stripIds(restored.tree));
  if (compiled.ok && sameShape) roundTripOk++;
  else {
    check(false, `${spec.id}: the round trip is lossless`, sameShape ? 'the tree does not compile' : 'the tree changed');
  }
}
check(
  roundTripOk === roundTripTotal,
  `the round trip is lossless for every gold tree`,
  `${roundTripOk}/${roundTripTotal}`,
);

function stripIds(node) {
  if (!node || typeof node !== 'object') return node;
  const { id, ...rest } = node;
  return {
    component: rest.component,
    props: rest.props ?? {},
    children: (rest.children ?? []).map(stripIds),
  };
}

// --- malformed lists are refused -----------------------------------------
const dangling = adjacencyToTree({ nodes: [{ id: 'n1', component: 'Badge', props: {}, childIds: ['n9'] }] });
check(!dangling.ok, 'a dangling childIds reference is refused', dangling.error);

const duplicate = adjacencyToTree({
  nodes: [
    { id: 'n1', component: 'Badge', props: {}, childIds: [] },
    { id: 'n1', component: 'Text', props: {}, childIds: [] },
  ],
});
check(!duplicate.ok, 'a duplicate id is refused', duplicate.error);

const noRoot = adjacencyToTree({
  nodes: [
    { id: 'n1', component: 'Badge', props: {}, childIds: ['n2'] },
    { id: 'n2', component: 'Text', props: {}, childIds: ['n1'] },
  ],
});
check(!noRoot.ok, 'a list with no root (a cycle) is refused', noRoot.error);

if (failures > 0) {
  console.log(`\nadjacency dialect contract: FAIL — ${failures} failure(s)`);
  process.exit(1);
}
console.log('\nadjacency dialect contract: PASS');
