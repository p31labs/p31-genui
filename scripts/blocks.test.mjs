#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { treeToBlocks, blocksToTree } from '../src/blocks.ts';
import { assignIds, resetIdCounter } from '../src/patch.ts';

const fixturePath = path.resolve(import.meta.dirname, '../fixtures/live-prompts.json');
const data = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

console.log('blocks round-trip');

for (const spec of data) {
  const tree = spec.goldTree;

  // Shape + round-trip without ids (gold trees have no id).
  const blocks = treeToBlocks(tree);
  check(`${spec.id} treeToBlocks returns array`, Array.isArray(blocks) && blocks.length > 0);
  let shapeOk = true;
  for (const b of blocks) {
    if (typeof b.id !== 'string' || !b.id) shapeOk = false;
    if (typeof b.type !== 'string') shapeOk = false;
    if (!b.props || typeof b.props !== 'object' || Array.isArray(b.props)) shapeOk = false;
    if (!Array.isArray(b.children)) shapeOk = false;
    if (!Array.isArray(b.content)) shapeOk = false;
  }
  check(`${spec.id} block shape {id,type,props,children,content}`, shapeOk);
  const back = blocksToTree(blocks);
  check(`${spec.id} round-trip (no ids)`, same(back, tree), same(back, tree) ? '' : `${JSON.stringify(back)} !== ${JSON.stringify(tree)}`);

  // Round-trip with ids assigned.
  resetIdCounter();
  const idTree = assignIds(tree);
  const blocks2 = treeToBlocks(idTree);
  const back2 = blocksToTree(blocks2);
  check(`${spec.id} round-trip (with ids)`, same(back2, idTree));
}

// blocksToTree accepts { blocks } wrapper too.
resetIdCounter();
const t = assignIds({ component: 'Card', props: { title: 'T' }, children: [{ component: 'Text', props: { content: 'a' }, children: [] }] });
const b = treeToBlocks(t);
check('wrapper input supported', same(blocksToTree({ blocks: b }), t));

console.log('');
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
