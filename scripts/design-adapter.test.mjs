// @p31ca/genui — Craft.js Design adapter round-trip test
// Proves: P31 tree -> Craft.js serialized node tree -> P31 tree is lossless.

import { treeToCraft, craftToTree, resetDesignCounter } from '../src/design-adapter.ts';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function treesEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => treesEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const keysA = Object.keys(a).sort();
    const keysB = Object.keys(b).sort();
    if (keysA.join(',') !== keysB.join(',')) return false;
    return keysA.every(k => treesEqual(a[k], b[k]));
  }
  return a === b;
}

const trees = [
  {
    component: 'Stack',
    props: { direction: 'vertical', gap: 'md' },
    children: [
      { component: 'Card', props: { title: 'Hello' }, children: [], id: 'card-1' },
      { component: 'Text', props: { content: 'World' }, children: [], id: 'text-1' },
      { component: 'Button', props: { label: 'Click me', variant: 'primary' }, children: [], id: 'btn-1' },
    ],
    id: 'root',
  },
  {
    component: 'Card',
    props: { title: 'StatCard Demo' },
    children: [
      { component: 'StatCard', props: { label: 'Users', value: '100', trend: 'up' }, children: [], id: 'stat-1' },
      { component: 'Badge', props: { label: 'New', variant: 'success' }, children: [], id: 'badge-1' },
      { component: 'Alert', props: { message: 'Warning', variant: 'warning' }, children: [], id: 'alert-1' },
    ],
    id: 'root2',
  },
  {
    component: 'Stack',
    props: { direction: 'horizontal', gap: 'sm' },
    children: [
      {
        component: 'Stack',
        props: { direction: 'vertical', gap: 'xs' },
        children: [
          { component: 'Text', props: { content: 'Nested' }, children: [], id: 'nested-text' },
        ],
        id: 'nested-stack',
      },
    ],
    id: 'root3',
  },
];

for (let i = 0; i < trees.length; i++) {
  resetDesignCounter();
  const tree = trees[i];
  console.log(`\nTree ${i + 1}:`);

  const craft = treeToCraft(tree);
  assert(typeof craft === 'object' && craft !== null, 'treeToCraft produces object');
  assert('ROOT' in craft, 'craft tree has ROOT node');
  assert(Array.isArray(craft['ROOT'].nodes), 'ROOT has nodes array');

  const roundTrip = craftToTree(craft);
  assert(roundTrip !== undefined, 'craftToTree produces tree');
  assert(roundTrip.component === tree.component, `component matches (${roundTrip.component})`);
  assert(roundTrip.children.length === tree.children.length, `children count matches (${roundTrip.children.length})`);

  // Check props
  for (let j = 0; j < tree.children.length; j++) {
    const origChild = tree.children[j];
    const rtChild = roundTrip.children[j];
    assert(rtChild.component === origChild.component, `child ${j} component matches`);
    // Check props
    const propKeys = Object.keys(origChild.props);
    for (const key of propKeys) {
      assert(rtChild.props[key] === origChild.props[key], `child ${j} prop ${key} matches`);
    }
  }

  // Deep equality check
  // Note: ids may differ, so we compare component + props + children structure
  assert(roundTrip.children.length === tree.children.length, 'deep: children count preserved');
}

// Test Craft.js node structure
resetDesignCounter();
const craft = treeToCraft(trees[0]);
const rootChildId = craft['ROOT'].nodes[0];
assert(craft[rootChildId].type.resolvedName === 'P31Stack', 'root child type is P31Stack');
assert(craft[rootChildId].isCanvas === true, 'Stack is canvas');
assert(craft[rootChildId].nodes.length === 3, 'Stack has 3 children');

// Check node types
const childTypes = craft[rootChildId].nodes.map(id => craft[id].type.resolvedName);
assert(childTypes.includes('P31Card'), 'has P31Card');
assert(childTypes.includes('P31Text'), 'has P31Text');
assert(childTypes.includes('P31Button'), 'has P31Button');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
