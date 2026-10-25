// @p31ca/genui — Craft.js Design canvas gate
//
// Proves the editable canvas surface stays wired to the adapter:
//   1. DesignCanvas's resolver names exactly match COMPONENT_MAP / REVERSE_MAP.
//   2. treeToCraft -> craftToTree is lossless for a nested all-7-component tree.
//   3. Craft.js serialized output is structurally valid (type/props/nodes, no
//      dangling child ids, every node reachable from ROOT exactly once).
//
// Deliberately does NOT import DesignCanvas.tsx: this test runs under plain
// `node`, and TSX/React DOM rendering is not required to prove the contract.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  treeToCraft,
  craftToTree,
  COMPONENT_MAP,
  REVERSE_MAP,
} from '../src/design-adapter.ts';

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

function sorted(list) {
  return [...list].sort();
}

/* ------------------------------------------------------------------ */
/* 1. Resolver names match the adapter maps                            */
/* ------------------------------------------------------------------ */

console.log('Resolver map parity:');

const canvasPath = fileURLToPath(new URL('../src/DesignCanvas.tsx', import.meta.url));
const canvasSource = readFileSync(canvasPath, 'utf8');

const resolverMatch = canvasSource.match(/export const P31_RESOLVER\s*=\s*\{([\s\S]*?)\};/);
assert(resolverMatch !== null, 'DesignCanvas.tsx exports a P31_RESOLVER object literal');

const resolverNames = resolverMatch
  ? resolverMatch[1]
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean)
  : [];
assert(resolverNames.length === 7, `resolver declares exactly 7 components (got ${resolverNames.length})`);
assert(
  resolverNames.every(name => /^[A-Za-z_$][\w$]*$/.test(name)),
  'every resolver entry is an identifier'
);

const forwardNames = Object.values(COMPONENT_MAP);
const reverseNames = Object.keys(REVERSE_MAP);

assert(forwardNames.length === 7, 'COMPONENT_MAP has 7 forward entries');
assert(reverseNames.length === 7, 'REVERSE_MAP has 7 reverse entries');
assert(
  sorted(resolverNames).join(',') === sorted(forwardNames).join(','),
  'resolver names exactly match COMPONENT_MAP values'
);
assert(
  sorted(resolverNames).join(',') === sorted(reverseNames).join(','),
  'resolver names exactly match REVERSE_MAP keys'
);
assert(
  sorted(forwardNames).join(',') === sorted(reverseNames).join(','),
  'COMPONENT_MAP and REVERSE_MAP are exact inverses'
);

for (const name of forwardNames) {
  assert(
    new RegExp(`export const ${name}\\b`).test(canvasSource),
    `${name} component is defined in DesignCanvas.tsx`
  );
}

// Stack and Card must be Craft canvases; the other five are leaves.
for (const name of ['P31Stack', 'P31Card']) {
  const block = canvasSource.match(new RegExp(`${name}\\.craft\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  assert(block !== null, `${name}.craft config exists`);
  assert(block !== null && /isCanvas:\s*true/.test(block[1]), `${name} is marked as a canvas`);
}
for (const name of ['P31Text', 'P31Button', 'P31Badge', 'P31StatCard', 'P31Alert']) {
  const block = canvasSource.match(new RegExp(`${name}\\.craft\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  assert(block !== null, `${name}.craft config exists`);
  assert(block !== null && !/isCanvas:\s*true/.test(block[1]), `${name} is not a canvas`);
}
assert(
  /export const DESIGN_RESOLVER\b[\s\S]*?\.\.\.P31_RESOLVER[\s\S]*?P31Root/.test(canvasSource),
  'DESIGN_RESOLVER includes the seven components plus P31Root (the adapter ROOT type)'
);

/* ------------------------------------------------------------------ */
/* 2. Nested all-7-component round trip                                */
/* ------------------------------------------------------------------ */

console.log('\nAll-7-component round trip:');

const tree = {
  component: 'Stack',
  props: { direction: 'vertical', gap: 'lg' },
  id: 'root',
  children: [
    {
      component: 'Card',
      props: { title: 'Design artifact', padding: 'md' },
      id: 'card',
      children: [
        {
          component: 'StatCard',
          props: { label: 'LOVE', value: '42', trend: 'up' },
          id: 'stat',
          children: [],
        },
        {
          component: 'Text',
          props: { content: 'Editable surface', size: 'lg', weight: 'bold' },
          id: 'text',
          children: [],
        },
        {
          component: 'Badge',
          props: { label: 'Live', variant: 'success' },
          id: 'badge',
          children: [],
        },
        {
          component: 'Alert',
          props: { message: 'Keep it deterministic', severity: 'warning' },
          id: 'alert',
          children: [],
        },
        {
          component: 'Stack',
          props: { direction: 'horizontal', gap: 'sm' },
          id: 'inner-stack',
          children: [
            {
              component: 'Button',
              props: { label: 'Ship it', variant: 'primary' },
              id: 'button',
              children: [],
            },
          ],
        },
      ],
    },
  ],
};

const craft = treeToCraft(tree);
assert(craft && typeof craft === 'object', 'treeToCraft produces an object');
assert('ROOT' in craft, 'serialized tree has a ROOT node');

const roundTrip = craftToTree(craft);
assert(roundTrip !== undefined, 'craftToTree produces a P31 tree');
assert(treesEqual(roundTrip, tree), 'nested tree survives treeToCraft -> craftToTree exactly');

const seenComponents = new Set();
(function collect(node) {
  if (!node) return;
  seenComponents.add(node.component);
  for (const child of node.children || []) collect(child);
})(roundTrip);
for (const name of forwardNames) {
  assert(seenComponents.has(name.replace(/^P31/, '')), `round trip preserves ${name.replace(/^P31/, '')}`);
}

/* ------------------------------------------------------------------ */
/* 3. Serialized node shape                                            */
/* ------------------------------------------------------------------ */

console.log('\nSerialized node shape:');

const craftEntries = Object.entries(craft);
let treeNodeCount = 0;
(function countNodes(node) {
  if (!node) return;
  treeNodeCount++;
  for (const child of node.children || []) countNodes(child);
})(tree);
assert(craftEntries.length === treeNodeCount + 1,
  `serialized tree has ROOT + ${treeNodeCount} nodes (got ${craftEntries.length})`);
assert(craft.ROOT.type.resolvedName === 'P31Root', 'ROOT resolvedName is P31Root');
assert(craft.ROOT.isCanvas === true, 'ROOT is a canvas');

for (const [id, node] of craftEntries) {
  assert(node.type && typeof node.type.resolvedName === 'string' && node.type.resolvedName.length > 0,
    `node ${id} has type.resolvedName`);
  assert(node.props && typeof node.props === 'object' && !Array.isArray(node.props),
    `node ${id} has an object props bag`);
  assert(Array.isArray(node.nodes), `node ${id} has a nodes array`);
  for (const childId of node.nodes) {
    assert(Object.prototype.hasOwnProperty.call(craft, childId),
      `node ${id} child ${childId} exists in the map`);
    if (Object.prototype.hasOwnProperty.call(craft, childId)) {
      assert(craft[childId].parent === id, `node ${childId} points back to parent ${id}`);
    }
  }
  if (id !== 'ROOT') {
    assert(typeof node.parent === 'string' && Object.prototype.hasOwnProperty.call(craft, node.parent),
      `non-root node ${id} has a parent in the map`);
  }
}

// Reachability: every node is reachable from ROOT exactly once, and the
// visible graph matches the map (no orphans, no double-parenting).
const reachable = new Map();
(function walk(id, via) {
  reachable.set(id, (reachable.get(id) || 0) + 1);
  for (const childId of craft[id].nodes) {
    if (!Object.prototype.hasOwnProperty.call(craft, childId)) continue;
    assert(!reachable.has(childId), `node ${childId} has exactly one parent (seen again via ${id})`);
    walk(childId, id);
  }
})( 'ROOT', null );

assert(reachable.size === craftEntries.length,
  `every serialized node is reachable from ROOT (${reachable.size}/${craftEntries.length})`);
assert([...reachable.values()].every(count => count === 1), 'no node is reached twice');

// The resolver must be able to resolve every type the adapter emits.
const emittedTypes = new Set(craftEntries.map(([, node]) => node.type.resolvedName));
for (const type of emittedTypes) {
  assert(resolverNames.includes(type) || type === 'P31Root',
    `emitted type ${type} is covered by the resolver`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
