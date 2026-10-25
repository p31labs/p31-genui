// @p31ca/genui — A2UI v0.9 conformance test
// Validates emitA2UI output against the official v0.9 server_to_client schema.
// Uses ajv (JSON Schema Draft 2020-12) with all referenced schemas loaded.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { emitA2UIJsonl, emitA2UIOfficial } from '../src/a2ui.ts';

const SCHEMA_DIR = join(import.meta.dirname, '..', 'node_modules', '@a2ui', 'web_core', 'src', 'v0_9', 'schemas');
const CATALOG_DIR = join(SCHEMA_DIR, 'catalogs', 'basic');

const ajv = new Ajv2020({ allErrors: true, strict: false });

// Load all schemas from the v0.9 schemas directory
function loadSchemas(dir) {
  try {
    const files = readdirSync(dir, { recursive: true });
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const schema = JSON.parse(readFileSync(join(dir, file), 'utf8'));
          if (schema.$id) {
            ajv.addSchema(schema);
          }
        } catch {}
      }
    }
  } catch {}
}
loadSchemas(SCHEMA_DIR);

// The v0.9 server schema references the basic catalog at a canonical URL that
// differs from the $id the package ships, so $ref resolution needs an alias.
// Derive it from the vendored package instead of depending on /tmp/catalog.json
// (a hand-made shim that disappeared with the machine's temp dir).
const CATALOG_CANONICAL_ID = 'https://a2ui.org/specification/v0_9/catalog.json';
try {
  const catalogSchema = JSON.parse(readFileSync(join(CATALOG_DIR, 'catalog.json'), 'utf8'));
  try { ajv.addSchema(catalogSchema); } catch { /* already registered */ }
  if (catalogSchema.$id !== CATALOG_CANONICAL_ID) {
    ajv.addSchema({...catalogSchema, $id: CATALOG_CANONICAL_ID});
  }
} catch (e) {
  console.log(`  (catalog schema unavailable: ${e.message})`);
}

const SCHEMA = JSON.parse(readFileSync(join(SCHEMA_DIR, 'server_to_client.json'), 'utf8'));
const validate = ajv.getSchema(SCHEMA["$id"]) || ajv.compile(SCHEMA);

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const trees = [
  {
    component: 'Stack',
    props: { direction: 'vertical', gap: 'md' },
    children: [
      { component: 'Card', props: { title: 'Hello' }, children: [], id: 'card-1' },
      { component: 'Text', props: { content: 'World' }, children: [], id: 'text-1' },
    ],
    id: 'root',
  },
  {
    component: 'Card',
    props: { title: 'StatCard Demo' },
    children: [
      { component: 'StatCard', props: { label: 'Users', value: '100', trend: 'up' }, children: [], id: 'stat-1' },
      { component: 'Alert', props: { message: 'Warning', variant: 'warning' }, children: [], id: 'alert-1' },
    ],
    id: 'root2',
  },
];

for (let i = 0; i < trees.length; i++) {
  const tree = trees[i];
  console.log(`\nTree ${i + 1}:`);

  const result = emitA2UIOfficial(tree);
  assert(result.messages.length >= 2, `has at least 2 messages (got ${result.messages.length})`);
  assert(result.messages[0].createSurface !== undefined, 'first message is createSurface');
  assert(result.messages[1].updateComponents !== undefined, 'second message is updateComponents');

  for (let j = 0; j < result.messages.length; j++) {
    const msg = result.messages[j];
    const valid = validate(msg);
    if (!valid) {
      console.error('  Schema errors:', JSON.stringify(validate.errors, null, 2));
    }
    assert(valid, `message ${j + 1} (${Object.keys(msg)[0]}) validates against v0.9 schema`);
  }

  const createIdx = result.messages.findIndex(m => m.createSurface);
  const updateIdx = result.messages.findIndex(m => m.updateComponents);
  assert(createIdx < updateIdx, 'createSurface precedes updateComponents');

  const components = result.messages[updateIdx].updateComponents.components;
  for (const comp of components) {
    // Official v0.9 uses `child` (single id); P31's dialect uses `children`.
    if (typeof comp.child === 'string') {
      assert(components.some(c => c.id === comp.child), `child reference ${comp.child} exists in component list`);
    }
    if (Array.isArray(comp.children)) {
      for (const child of comp.children) {
        assert(typeof child === 'string', `child reference is string (got ${typeof child})`);
        const childExists = components.some(c => c.id === child);
        assert(childExists, `child reference ${child} exists in component list`);
      }
    }
  }

  const ids = components.map(c => c.id);
  const uniqueIds = new Set(ids);
  assert(uniqueIds.size === ids.length, 'all component IDs are unique');
}

const jsonl = emitA2UIJsonl(emitA2UIOfficial(trees[0]));
const lines = jsonl.split('\n');
assert(lines.length === 2, `JSONL has 2 lines (got ${lines.length})`);
for (const line of lines) {
  try { JSON.parse(line); assert(true, 'JSONL line is valid JSON'); }
  catch { assert(false, 'JSONL line is valid JSON'); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
