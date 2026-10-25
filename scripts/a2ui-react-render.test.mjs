// @vitest-environment jsdom
// @p31ca/genui — A2UI v0.9 React host consumption test
//
// Verifies that a React-compatible host (via @a2ui/web_core's MessageProcessor,
// the same processor @a2ui/react drives) can consume emitA2UI output:
//   - the surface is created
//   - components are registered against a catalog
//   - a simple P31 tree round-trips through the processor
//
// Uses @a2ui/web_core directly (no React DOM rendering required).

// ---- module resolution (works from any cwd) ----
let webCore;
try {
  webCore = await import('@a2ui/web_core/v0_9');
} catch {
  webCore = await import('/home/p31/production/node_modules/.pnpm/@a2ui+web_core@0.14.0/node_modules/@a2ui/web_core/src/v0_9/index.js');
}
const { MessageProcessor, Catalog } = webCore;

let zodMod;
try {
  zodMod = await import('zod');
} catch {
  zodMod = await import('/home/p31/production/packages/genui/node_modules/zod/index.js');
}
const { z } = zodMod;

const emitMod = await import('/home/p31/production/packages/genui/src/a2ui.ts');
const { emitA2UI } = emitMod;

// ---- P31 catalog mirroring emitA2UI's default catalogId ----
const P31_COMPONENTS = ['Card', 'Stack', 'Button', 'Text', 'Badge', 'StatCard', 'Alert'];
const catalog = new Catalog(
  'p31-catalog',
  '0.9',
  P31_COMPONENTS.map((name) => ({ name, schema: z.object({}).passthrough() })),
);

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

console.log('\nA2UI React host consumption:');

// ---- Test 1: surface created + components registered ----
{
  console.log('\n  Test: surface created and components registered');
  const tree = {
    id: 'root',
    component: 'Card',
    props: { title: 'Hello' },
    children: [
      { id: 't1', component: 'Text', props: { content: 'World' }, children: [] },
    ],
  };
  const result = emitA2UI(tree);
  assert(result.messages.length >= 2, `emits >=2 messages (got ${result.messages.length})`);
  assert(result.messages[0].createSurface !== undefined, 'first message is createSurface');
  assert(result.messages[0].createSurface?.catalogId === 'p31-catalog', 'catalogId matches host catalog');

  const processor = new MessageProcessor([catalog]);
  let created = false;
  const sub = processor.onSurfaceCreated(() => {
    created = true;
  });
  try {
    processor.processMessages(result.messages);
  } catch (e) {
    console.error('  process error:', e?.message || e);
  }
  sub.unsubscribe();

  assert(created, 'onSurfaceCreated fired');
  assert(processor.getSurfaces().size === 1, `one surface created (got ${processor.getSurfaces().size})`);

  const surface = processor.getSurface('main');
  assert(!!surface, 'surface "main" retrievable');
  if (surface) {
    assert(surface.rootId === 'root', `rootId is "root" (got ${surface.rootId})`);
    const cm = surface.componentsModel;
    assert(cm.components.size === 2, `2 components registered (got ${cm.components.size})`);
    assert(cm.components.has('root'), 'component "root" registered');
    assert(cm.components.has('t1'), 'component "t1" registered');
  }
  processor.dispose();
}

// ---- Test 2: simple P31 tree with Stack/Button ----
{
  console.log('\n  Test: simple P31 tree (Stack + Button)');
  const tree = {
    id: 'root',
    component: 'Stack',
    props: { direction: 'vertical', gap: 'md' },
    children: [
      { id: 'btn1', component: 'Button', props: { label: 'Click me' }, children: [] },
      { id: 'txt1', component: 'Text', props: { content: 'Status' }, children: [] },
    ],
  };
  const result = emitA2UI(tree);
  const processor = new MessageProcessor([catalog]);
  try {
    processor.processMessages(result.messages);
  } catch (e) {
    console.error('  process error:', e?.message || e);
  }
  assert(processor.getSurfaces().size === 1, 'surface created for Stack tree');
  const surface = processor.getSurface('main');
  if (surface) {
    const cm = surface.componentsModel;
    assert(cm.components.size === 3, `3 components registered (got ${cm.components.size})`);
    const stack = cm.components.get('root');
    assert(!!stack, 'Stack component present');
  }
  processor.dispose();
}

// ---- Test 3: children referenced by id survive processing ----
{
  console.log('\n  Test: child references preserved after processing');
  const tree = {
    id: 'root',
    component: 'Card',
    props: { title: 'Parent' },
    children: [
      { id: 'child-a', component: 'Badge', props: { label: 'ok' }, children: [] },
    ],
  };
  const result = emitA2UI(tree);
  const update = result.messages.find((m) => m.updateComponents);
  const card = update?.updateComponents?.components?.find((c) => c.component === 'Card');
  assert(Array.isArray(card?.children) && card.children.includes('child-a'), 'emitted Card references child-a');

  const processor = new MessageProcessor([catalog]);
  processor.processMessages(result.messages);
  const surface = processor.getSurface('main');
  if (surface) {
    assert(surface.componentsModel.components.has('child-a'), 'child-a registered in host');
  }
  processor.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
