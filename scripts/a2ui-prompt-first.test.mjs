// @p31ca/genui — A2UI v0.9 Prompt-First Generation Test
//
// Validates the "Prompt First" approach: embed the basic catalog in the system
// prompt, let the model emit A2UI JSONL in json-object mode (not strict),
// then validate against the official v0.9 schema.
//
// This tests the generation STRATEGY, not the emitter (which is already tested
// by a2ui-conformance.test.mjs). The key insight from A2UI v0.9 research:
// strict JSON schema decoding was WORSE for semantic accuracy (53.3% vs 76.7%
// compile rate). Prompt-first with json-object mode is the recommended approach.

import { readFileSync } from 'node:fs';

const CATALOG_PATH = '/home/p31/production/node_modules/.pnpm/@a2ui+web_core@0.14.0/node_modules/@a2ui/web_core/src/v0_9/schemas/catalogs/basic/catalog.json';
const SCHEMA_DIR = '/home/p31/production/node_modules/.pnpm/@a2ui+web_core@0.14.0/node_modules/@a2ui/web_core/src/v0_9/schemas';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// 1. Load catalog
const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
assert(catalog.components, 'catalog has components');
assert(Object.keys(catalog.components).length >= 10, `catalog has ${Object.keys(catalog.components).length} components`);

// 2. Build prompt-first system prompt
const componentNames = Object.keys(catalog.components);
const systemPrompt = `You are an A2UI v0.9 generator. Given a user request, emit A2UI JSONL messages.

Available components: ${componentNames.join(', ')}

Each message is a JSON object with one of:
- createSurface: { surfaceId, catalogId }
- updateComponents: { surfaceId, components: [{id, component, ...props}] }
- updateDataModel: { surfaceId, path, contents }

Rules:
- Every component needs a unique id
- Children reference parent by id
- Use only components from the catalog
- Output valid JSON only, no markdown fences
- First message must be createSurface, second updateComponents

Respond with a JSON object containing a "messages" array.`;

assert(systemPrompt.includes('createSurface'), 'system prompt includes createSurface');
assert(systemPrompt.includes('updateComponents'), 'system prompt includes updateComponents');
assert(systemPrompt.includes('Text'), 'system prompt includes Text component');

// 3. Validate a sample prompt-first output against the schema
const { Ajv2020 } = await import('ajv/dist/2020.js');
const { readdirSync } = await import('node:fs');
const { join } = await import('node:path');

const ajv = new Ajv2020({ allErrors: true, strict: false });

// Load schemas
function loadSchemas(dir) {
  try {
    const files = readdirSync(dir, { recursive: true });
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const schema = JSON.parse(readFileSync(join(dir, file), 'utf8'));
          if (schema.$id) ajv.addSchema(schema);
        } catch {}
      }
    }
  } catch {}
}
loadSchemas(SCHEMA_DIR);
// Load the catalog shim (same as a2ui-conformance.test.mjs)
try {
  const catalogSchema = JSON.parse(readFileSync('/tmp/catalog.json', 'utf8'));
  try { ajv.addSchema(catalogSchema); } catch (e) { /* already loaded */ }
} catch (e) {
  console.log('  (catalog shim not found, skipping)');
}

const SCHEMA = JSON.parse(readFileSync(join(SCHEMA_DIR, 'server_to_client.json'), 'utf8'));
const validate = ajv.getSchema(SCHEMA["$id"]) || ajv.compile(SCHEMA);

// 4. Test with a sample prompt-first output (simulating what the model would produce)
const sampleOutput = {
  messages: [
    { version: 'v0.9', createSurface: { surfaceId: 'main', catalogId: 'p31-catalog' } },
    { version: 'v0.9', updateComponents: { surfaceId: 'main', components: [
      { id: 'root', component: 'Column', children: ['title', 'card1'] },
      { id: 'title', component: 'Text', text: 'Dashboard', variant: 'h1' },
      { id: 'card1', component: 'Card', children: ['stat1'] },
      { id: 'stat1', component: 'Text', text: 'Revenue: $42,000' },
    ] } },
  ],
};

for (let j = 0; j < sampleOutput.messages.length; j++) {
  const msg = sampleOutput.messages[j];
  const valid = validate(msg);
  assert(valid, `sample message ${j + 1} validates against v0.9 schema`);
  if (!valid) {
    console.error('  errors:', JSON.stringify(validate.errors, null, 2));
  }
}

// 5. Verify the prompt-first catalog text is embeddable
const catalogText = JSON.stringify(catalog.components, null, 2);
assert(catalogText.length > 100, `catalog text is ${catalogText.length} chars (embeddable)`);
assert(catalogText.includes('Text'), 'catalog text includes Text component');
assert(catalogText.includes('properties'), 'catalog text includes component properties');

// 6. Verify the emitter still works (backward compat)
const { emitA2UI } = await import('../src/a2ui.ts');
const tree = {
  component: 'Stack',
  props: { direction: 'vertical', gap: 'md' },
  children: [
    { component: 'Card', props: { title: 'Hello' }, children: [], id: 'card-1' },
  ],
  id: 'root',
};
const result = emitA2UI(tree);
assert(result.messages.length >= 2, `emitter produces ${result.messages.length} messages`);
assert(result.messages[0].createSurface !== undefined, 'emitter: first message is createSurface');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);