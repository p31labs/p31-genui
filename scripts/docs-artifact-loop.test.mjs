// @p31ca/genui — Docs artifact review loop (end-to-end)
// Full cycle against the local Artifact Server (localhost:8787, SQLite + local
// storage): render DocEditor document to HTML -> publish artifact -> block-anchored
// comment -> register agent + dispatch -> claim + read bundle -> map anchor to block
// op -> apply op -> republish as new version -> verify updated block -> reply -> resolve.
// No provider API calls. No Cloudflare. No R2.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { treeToBlocks, blocksToTree } from '../src/blocks.ts';

const TOKEN = readFileSync('/home/p31/.artifact-server/local-api-token', 'utf8').trim();
const SERVER = 'http://localhost:8787';
const PROJECT_ID = 'prj_default';
const HEADERS = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  OK ${msg}`); }
  else { failed++; console.error(`  FAIL ${msg}`); }
}

async function request(method, url, body = null, extra = {}) {
  const full = url.startsWith('http') ? url : `${SERVER}${url}`;
  const opts = { method, headers: { ...HEADERS, ...extra } };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(full, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { data, ok: res.ok, status: res.status };
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(tree) {
  const blocks = treeToBlocks(tree);
  const items = blocks
    .filter((b) => b.id !== 'root')
    .map((b) => {
      const title = b.props && (b.props.title ?? b.props.content ?? b.id);
      return `<div data-block-id="${b.id}">${escapeHtml(title)}</div>`;
    });
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Docs</title></head><body><main>${items.join('\n')}</main></body></html>`;
}

async function publishHtml(html, opts = {}) {
  const bytes = Buffer.from(html, 'utf8');
  const sha = sha256Bytes(bytes);
  const created = await request('POST', '/api/v1/uploads', {
    entryPath: 'index.html',
    files: [{ path: 'index.html', mediaType: 'text/html', sha256: sha, size: bytes.length }],
    projectId: PROJECT_ID,
  });
  assert(created.ok, `upload created (${created.data?.uploadId})`);
  const upload = created.data;
  const putRes = await fetch(upload.files[0].uploadUrl, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${TOKEN}` },
    body: bytes,
  });
  assert(putRes.ok, 'upload file verified');

  const idemp = `publish-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const commitBody = opts.newVersion
    ? { target: { kind: 'new_version', artifactId: opts.artifactId, expectedCurrentVersionId: opts.expectedCurrentVersionId } }
    : { target: { kind: 'new_artifact', name: opts.name || 'docs-artifact-loop', accessSetting: 'account_required', tags: [] } };

  const committed = await request('POST', upload.commitUrl, commitBody, { 'Idempotency-Key': idemp });
  assert(committed.ok, `publish committed (${committed.status})`);
  return committed.data;
}

async function run() {
  console.log('Docs artifact review loop test\n');

  // 1. Render a DocEditor document to HTML
  const originalTree = {
    component: 'Stack',
    props: { direction: 'vertical', gap: 'md' },
    children: [
      { component: 'Card', props: { title: 'Block A' }, children: [], id: 'block-a' },
      { component: 'Card', props: { title: 'Block B' }, children: [], id: 'block-b' },
      { component: 'Text', props: { content: 'Some text' }, children: [], id: 'text-1' },
    ],
    id: 'root',
  };
  const blocks = treeToBlocks(originalTree);
  assert(blocks.length === 4, 'tree produces 4 blocks');
  const htmlV1 = renderHtml(originalTree);
  assert(htmlV1.includes('data-block-id="block-a"'), 'rendered HTML carries block-a anchor');
  assert(htmlV1.includes('Block A'), 'rendered HTML contains Block A');

  // 2. Publish as an artifact
  const pub = await publishHtml(htmlV1, { name: 'docs-artifact-loop' });
  const artifactId = pub.artifact?.id ?? pub.artifactId;
  const versionId = pub.version?.id ?? pub.versionId;
  const versionNumber = pub.version?.number;
  assert(!!artifactId, `artifact published (${artifactId})`);
  assert(!!versionId, `version created (${versionId})`);

  // 3. Create a block-anchored comment on block-a
  const idempKey = `comment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const commentRes = await request('POST', `/api/v1/artifacts/${artifactId}/versions/${versionId}/comments?project=${PROJECT_ID}`, {
    anchor: { blockId: 'block-a', type: 'block' },
    body: 'Please update the title of Block A to "Updated Block A"',
  }, { 'Idempotency-Key': idempKey });
  assert(commentRes.ok, `block-anchored comment created (${commentRes.data?.thread?.id})`);
  const threadId = commentRes.data?.thread?.id;
  assert(commentRes.data?.thread?.anchor?.blockId === 'block-a', 'comment anchor has blockId');

  // 4. Register agent + create dispatch
  const agentRes = await request('POST', '/api/v1/agents', {
    displayName: 'docs-artifact-loop-agent',
    kind: 'opencode',
    workingDirectory: '/home/p31/production',
  });
  assert(agentRes.ok, `agent registered (${agentRes.data?.agent?.id})`);
  const agentId = agentRes.data?.agent?.id;

  const dispatchRes = await request('POST', '/api/v1/agent-dispatches', {
    agentId,
    threadIds: [threadId],
    projectId: PROJECT_ID,
  }, { 'Idempotency-Key': `disp-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  assert(dispatchRes.ok, 'dispatch created');
  const dispatchId = dispatchRes.data?.dispatch?.id;

  // 5. Claim dispatch, read bundle, map anchor to block op
  const claimRes = await request('POST', `/api/v1/agents/${agentId}/claims?project=${PROJECT_ID}`);
  assert(claimRes.ok, 'dispatch claimed');
  assert(claimRes.data?.dispatch?.id === dispatchId, 'claimed dispatch matches');

  const deliverRes = await request('POST', `/api/v1/agent-dispatches/${dispatchId}/delivered?project=${PROJECT_ID}`, { agentId });
  assert(deliverRes.ok, 'dispatch delivered');

  const bundleRes = await request('GET', `/api/v1/agent-dispatches/${dispatchId}?project=${PROJECT_ID}`);
  assert(bundleRes.ok, 'dispatch bundle read');
  assert(Array.isArray(bundleRes.data?.dispatch?.threadIds) && bundleRes.data.dispatch.threadIds.includes(threadId), 'bundle carries thread');

  const threadRes = await request('GET', `/api/v1/artifacts/${artifactId}/comments/${threadId}?project=${PROJECT_ID}`);
  assert(threadRes.ok, 'thread fetched from bundle');
  const anchor = threadRes.data?.thread?.anchor;
  assert(anchor?.blockId === 'block-a', 'anchor maps to block-a');

  // 6. Apply block op (update block-a title)
  const blockOp = { type: 'update', blockId: anchor.blockId, block: { props: { title: 'Updated Block A' } } };
  assert(blockOp.blockId === 'block-a', 'block op targets block-a');
  const updatedBlocks = blocks.map((b) => {
    if (b.id === 'block-a') {
      return { ...b, props: { ...b.props, title: 'Updated Block A' } };
    }
    return b;
  });
  const updatedTree = blocksToTree(updatedBlocks);
  assert(updatedTree.children[0].props.title === 'Updated Block A', 'block-a title updated');
  assert(updatedTree.children[1].props.title === 'Block B', 'block-b untouched');
  assert(updatedTree.children[2].props.content === 'Some text', 'text-1 untouched');

  // 7. Republish as new version
  const htmlV2 = renderHtml(updatedTree);
  assert(htmlV2.includes('Updated Block A'), 'rendered v2 contains updated title');
  const repub = await publishHtml(htmlV2, {
    newVersion: true,
    artifactId,
    expectedCurrentVersionId: versionId,
  });
  const newVersionId = repub.version?.id ?? repub.versionId;
  const newVersionNumber = repub.version?.number;
  assert(!!newVersionId && newVersionId !== versionId, `new version created (${newVersionId})`);
  assert(newVersionNumber === 2 || newVersionNumber > (versionNumber || 0), `version incremented (${newVersionNumber})`);

  // 8. Verify updated block in new version
  const fileRes = await request('GET', `/api/v1/artifacts/${artifactId}/versions/${newVersionId}/file?path=index.html`);
  const fileText = typeof fileRes.data === 'string' ? fileRes.data : '';
  assert(fileRes.ok, 'new version file readable');
  assert(fileText.includes('Updated Block A'), 'updated block present in new version');
  assert(!fileText.includes('>Block A<'), 'old title not present in new version');

  // 9. Reply and resolve
  const replyRes = await request('POST', `/api/v1/artifacts/${artifactId}/comments/${threadId}/replies?project=${PROJECT_ID}`, {
    body: 'Updated Block A title to "Updated Block A" as requested.',
  }, { 'Idempotency-Key': `reply-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  assert(replyRes.ok, 'reply posted');

  const resolveRes = await request('PATCH', `/api/v1/artifacts/${artifactId}/comments/${threadId}?project=${PROJECT_ID}`, {
    state: 'resolved',
  });
  assert(resolveRes.ok, 'thread resolved');
  assert(resolveRes.data?.thread?.state === 'resolved', 'thread state is resolved');

  // 10. Cleanup: delete the test artifact so repeated gate runs stay idempotent.
  const delRes = await request(
    'DELETE',
    `/api/v1/artifacts/${artifactId}?project=${PROJECT_ID}`,
    { expectedCurrentVersionId: newVersionId },
    { 'Idempotency-Key': `delete-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  );
  assert(delRes.ok, `test artifact deleted (${delRes.status})`);

  // 11. Cleanup: disconnect the test agent so it doesn't appear as "offline" in the UI.
  const discRes = await request('POST', `/api/v1/agents/${agentId}/disconnect`);
  assert(discRes.ok, `agent disconnected (${discRes.status})`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
