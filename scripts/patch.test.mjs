#!/usr/bin/env node
import { applyPatch, applyPatches, resolveTemplatePlaceholders, applyIdPatch, applyIdPatches, assignIds, resetIdCounter } from '../src/patch.ts';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
function throws(fn) { try { fn(); return false; } catch { return true; } }

const base = { component: 'Card', props: { title: 'T' }, children: [ { component: 'Text', props: { content: 'a' }, children: [] } ] };

// add child
const child = { component: 'Button', props: { label: 'X' }, children: [] };
const outAdd = applyPatch(base, { op: 'add', path: '/children/1', value: child });
check('add child increases count', outAdd.children.length === 2);
check('add child placed at index', outAdd.children[1].component === 'Button');
check('add child does not mutate input', base.children.length === 1);

// modify prop
const outMod = applyPatch(base, { op: 'modify', path: '/props/title', value: 'New' });
check('modify prop updates value', outMod.props.title === 'New');
check('modify prop original unchanged', base.props.title === 'T');

// remove child
const outRem = applyPatch(base, { op: 'remove', path: '/children/0' });
check('remove child decreases count', outRem.children.length === 0);
check('remove original unchanged', base.children.length === 1);

// invalid path handling
check('invalid path throws (missing prop)', throws(() => applyPatch(base, { op: 'modify', path: '/props/nope', value: 1 })));
check('invalid path throws (bad segment)', throws(() => applyPatch(base, { op: 'modify', path: '/children/x', value: 1 })));
check('invalid op throws', throws(() => applyPatch(base, { op: 'frob', path: '/props/title', value: 1 })));

// out of bounds
check('oob modify throws', throws(() => applyPatch(base, { op: 'modify', path: '/children/5', value: 1 })));
check('oob remove throws', throws(() => applyPatch(base, { op: 'remove', path: '/children/5', value: 1 })));
check('oob add throws', throws(() => applyPatch(base, { op: 'add', path: '/children/5', value: 1 })));

// applyPatches multiple
const outMulti = applyPatches(base, [
  { op: 'modify', path: '/props/title', value: 'Multi' },
  { op: 'add', path: '/children/1', value: { component: 'Badge', props: { label: 'B' }, children: [] } },
]);
check('applyPatches applies all', outMulti.props.title === 'Multi' && outMulti.children.length === 2);

// resolveTemplatePlaceholders
const tree = { component: 'Card', props: { title: 'Hi {{user.name}}', subtitle: 'no placeholder' }, children: [ { component: 'Text', props: { content: 'Value: {{count}}' }, children: [] } ] };
const data = { user: { name: 'Alice' }, count: 42 };
const bound = resolveTemplatePlaceholders(tree, data);
check('resolveTemplatePlaceholders replaces nested placeholder', bound.props.title === 'Hi Alice');
check('resolveTemplatePlaceholders leaves non-placeholder', bound.props.subtitle === 'no placeholder');
check('resolveTemplatePlaceholders replaces in children', bound.children[0].props.content === 'Value: 42');
check('resolveTemplatePlaceholders does not mutate input', tree.props.title === 'Hi {{user.name}}');
const bound2 = resolveTemplatePlaceholders(tree, {});
check('resolveTemplatePlaceholders keeps unresolved', bound2.props.title === 'Hi {{user.name}}');

// append via -
const t = { component: 'Stack', children: [ { component: 'Text', props: { content: 'a' }, children: [] } ] };
const outAppend = applyPatch(t, { op: 'add', path: '/children/-', value: { component: 'Text', props: { content: 'b' }, children: [] } });
check('append via -', outAppend.children.length === 2 && outAppend.children[1].props.content === 'b');

// object add/remove property
const t2 = { component: 'Card', props: { title: 'T' }, children: [] };
const out1 = applyPatch(t2, { op: 'add', path: '/props/subtitle', value: 'S' });
check('object add property', out1.props.subtitle === 'S');
const out2 = applyPatch(out1, { op: 'remove', path: '/props/subtitle' });
check('object remove property', !('subtitle' in out2.props));

console.log('');
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);

// --- id-based patch tests ---

resetIdCounter();
const idBase = assignIds({ component: 'Card', props: { title: 'T' }, children: [ { component: 'Text', props: { content: 'a' }, children: [] } ] });
const origId = idBase.children[0].id;

// index-shift regression: insert at 0, then update original node by id
const shifted = applyIdPatches(idBase, [
  { op: 'insert', parentId: idBase.id, position: 'start', block: { component: 'Button', props: { label: 'X' }, children: [] } },
  { op: 'update', targetId: origId, props: { content: 'updated' } },
]);
check('index-shift: button inserted first', shifted.children[0].component === 'Button');
check('index-shift: original text still at index 1', shifted.children[1].component === 'Text');
check('index-shift: update hit original node, not inserted one', shifted.children[1].props.content === 'updated');

// stale-id rejection (all-or-nothing)
resetIdCounter();
const idBase2 = assignIds({ component: 'Card', props: { title: 'T' }, children: [] });
let threw = false;
try { applyIdPatches(idBase2, [{ op: 'remove', targetIds: ['nonexistent'] }]); } catch { threw = true; }
check('stale-id rejected', threw);

// id-based remove
resetIdCounter();
const idBase3 = assignIds({ component: 'Stack', props: {}, children: [ { component: 'Text', props: { content: 'a' }, children: [] }, { component: 'Text', props: { content: 'b' }, children: [] } ] });
const removed = applyIdPatches(idBase3, [{ op: 'remove', targetIds: [idBase3.children[0].id] }]);
check('id-remove decreases count', removed.children.length === 1);
check('id-remove keeps correct child', removed.children[0].props.content === 'b');

// id-based update
resetIdCounter();
const idBase4 = assignIds({ component: 'Card', props: { title: 'T' }, children: [] });
const updated = applyIdPatches(idBase4, [{ op: 'update', targetId: idBase4.id, props: { title: 'New' } }]);
check('id-update changes prop', updated.props.title === 'New');
check('id-update original unchanged', idBase4.props.title === 'T');

// all-or-nothing: unknown id in batch rejects whole
resetIdCounter();
const idBase5 = assignIds({ component: 'Card', props: { title: 'T' }, children: [] });
let threw2 = false;
try { applyIdPatches(idBase5, [{ op: 'update', targetId: idBase5.id, props: { title: 'X' } }, { op: 'remove', targetIds: ['ghost'] }]); } catch { threw2 = true; }
check('all-or-nothing rejects whole batch', threw2);
check('all-or-nothing no mutation', idBase5.props.title === 'T');
