#!/usr/bin/env node
/**
 * @p31ca/genui — Apply Patch & Republish Artifact
 *
 * The deterministic edit loop: given an artifact ID and a JSON patch,
 * fetch the tree, apply the patch (using the tested applyIdPatches from
 * patch.ts), recompile, and publish a new version.
 *
 * Patch format (skill-friendly):
 *   { "op": "update", "blockId": "heading-1", "props": { "content": "New" } }
 *   { "op": "insert", "parentId": "stat-row", "index": 2, "block": { ... } }
 *   { "op": "remove", "blockId": "deprecated-card" }
 *   { "op": "move", "blockId": "stat-2", "parentId": "stat-row", "index": 0 }
 *
 * Internally mapped to applyIdPatches format (targetId, parentId, position, etc.)
 *
 * Usage:
 *   node apply-patch.mjs --artifact art_xxxx --thread cmt_yyyy \
 *     --patch '[{"op":"update","blockId":"heading-1","props":{"content":"New Title"}}]'
 *
 * Or with an inline patch file:
 *   node apply-patch.mjs --artifact art_xxxx --thread cmt_yyyy --patch-file patch.json
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const TOKEN = readFileSync('/home/p31/.artifact-server/local-api-token', 'utf8').trim();
const SERVER = 'http://localhost:8787';
const PROJECT_ID = 'prj_default';
const HEADERS = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

function arg(name, dflt) {
  const raw = process.argv.slice(2);
  const hit = raw.find(a => a === `--${name}`);
  if (hit) {
    const idx = raw.indexOf(hit);
    if (raw[idx + 1]) return raw[idx + 1];
  }
  const eqHit = raw.find(a => a.startsWith(`--${name}=`));
  return eqHit ? eqHit.split('=').slice(1).join('=') : dflt;
}

function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
  console.log(`  ✓ ${msg}`);
}

async function request(method, path, body = null, extra = {}) {
  const opts = { method, headers: { ...HEADERS, ...extra } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SERVER}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { data, ok: res.ok, status: res.status };
}

/**
 * Map skill-friendly patch format to applyIdPatches format.
 * Uses applyIdPatches from patch.ts (tested, all-or-nothing validation).
 */
function mapToIdPatches(skillPatches) {
  return skillPatches.map(p => {
    switch (p.op) {
      case 'update':
        return { op: 'update', targetId: p.blockId, props: p.props || {} };
      case 'insert': {
        // Map index to position
        let position = 'end';
        let refId = null;
        if (p.index === 0) position = 'start';
        else if (p.refId) {
          position = p.position || 'after';
          refId = p.refId;
        }
        return {
          op: 'insert',
          parentId: p.parentId,
          position,
          ...(refId ? { refId } : {}),
          block: p.block,
        };
      }
      case 'remove':
        return { op: 'remove', targetIds: [p.blockId] };
      case 'move':
        // Move is implemented as remove + insert
        return [
          { op: 'remove', targetIds: [p.blockId] },
          { op: 'insert', parentId: p.parentId, position: 'end', block: { id: p.blockId, component: '__placeholder__' } },
        ];
      default:
        throw new Error(`Unknown patch op: ${p.op}`);
    }
  }).flat();
}

async function run() {
  console.log('P31 GenUI — Apply Patch & Republish\n');

  const artifactId = arg('artifact');
  const threadId = arg('thread');
  const patchArg = arg('patch');
  const patchFile = arg('patch-file');

  assert(artifactId, `--artifact is required`);
  assert(threadId, `--thread is required`);
  assert(patchArg || patchFile, `--patch or --patch-file is required`);

  let skillPatches;
  if (patchFile) {
    skillPatches = JSON.parse(readFileSync(patchFile, 'utf8'));
  } else {
    skillPatches = JSON.parse(patchArg);
  }
  assert(Array.isArray(skillPatches), 'patch must be an array of operations');

  // Map to applyIdPatches format
  const idPatches = mapToIdPatches(skillPatches);

  // 1. Get artifact current version
  const artifactRes = await request('GET', `/api/v1/artifacts/${artifactId}?project=${PROJECT_ID}`);
  assert(artifactRes.ok, `artifact fetched (${artifactRes.data?.artifact?.name})`);
  const versionId = artifactRes.data?.artifact?.currentVersionId;
  assert(versionId, 'artifact has a current version');

  // 2. Download tree.json
  const fileRes = await request('GET', `/api/v1/artifacts/${artifactId}/versions/${versionId}/file?path=tree.json&project=${PROJECT_ID}`);
  if (!fileRes.ok) {
    console.error('Could not fetch tree.json. Artifact may not be a bundle.');
    process.exit(1);
  }
  const tree = typeof fileRes.data === 'string' ? JSON.parse(fileRes.data) : fileRes.data;
  assert(tree && tree.component, 'valid tree downloaded');

  // 3. Apply the patch using applyIdPatches (tested, all-or-nothing)
  const { applyIdPatches } = await import('../src/patch.ts');
  const newTree = applyIdPatches(JSON.parse(JSON.stringify(tree)), idPatches);
  console.log('  ✓ patch applied (applyIdPatches, all-or-nothing)');

  // 4. Compile to HTML
  const { emitMcpApp } = await import('../src/mcp-apps.ts');
  const catalog = (await import('../src/catalog.ts')).getCatalog();
  const emission = emitMcpApp(newTree, catalog, { title: 'P31 GenUI' });
  const treeJson = JSON.stringify(newTree, null, 2);
  const html = emission.html;

  // 5. Create upload
  const idemp = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const htmlSha = createHash('sha256').update(html, 'utf8').digest('hex');
  const treeSha = createHash('sha256').update(treeJson, 'utf8').digest('hex');
  const uploadRes = await request('POST', '/api/v1/uploads', {
    entryPath: 'index.html',
    files: [
      { path: 'index.html', mediaType: 'text/html; charset=utf-8', sha256: htmlSha, size: Buffer.byteLength(html) },
      { path: 'tree.json', mediaType: 'application/json', sha256: treeSha, size: Buffer.byteLength(treeJson) },
    ],
    projectId: PROJECT_ID,
  }, { 'Idempotency-Key': idemp });
  assert(uploadRes.ok, `upload created (${uploadRes.data?.uploadId})`);

  // 6. PUT files
  for (let i = 0; i < uploadRes.data.files.length; i++) {
    const content = i === 0 ? html : treeJson;
    const putRes = await fetch(uploadRes.data.files[i].uploadUrl, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': uploadRes.data.files[i].mediaType },
      body: content,
    });
    assert(putRes.ok, `file ${i + 1} uploaded (${uploadRes.data.files[i].path})`);
  }

  // 7. Commit as new version
  const commitFetch = await fetch(uploadRes.data.commitUrl, {
    method: 'POST',
    headers: { ...HEADERS, 'Idempotency-Key': `commit-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    body: JSON.stringify({ target: { kind: 'new_version', artifactId, expectedCurrentVersionId: versionId } }),
  });
  const commitText = await commitFetch.text();
  if (!commitFetch.ok) { console.error(commitText); process.exit(1); }
  const commitData = JSON.parse(commitText);
  const newVersionId = commitData?.version?.id ?? commitData?.currentVersionId;
  console.log('  ✓ new version: ' + newVersionId);

  // 8. Reply to thread (idempotent)
  const replyBody = `Applied the requested change. Published as version ${newVersionId.slice(0, 8)}.`;
  const replyRes = await request('POST', `/api/v1/artifacts/${artifactId}/comments/${threadId}/replies?project=${PROJECT_ID}`, {
    body: replyBody,
  }, { 'Idempotency-Key': `reply-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  if (replyRes.ok) {
    console.log('  ✓ reply posted');
  } else {
    console.log('  (reply skipped - thread may already be resolved)');
  }

  // 9. Resolve thread (idempotent)
  const resolveRes = await request('PATCH', `/api/v1/artifacts/${artifactId}/comments/${threadId}?project=${PROJECT_ID}`, {
    state: 'resolved',
  });
  if (resolveRes.ok) {
    console.log('  ✓ thread resolved');
  } else {
    console.log('  (thread already resolved)');
  }

  console.log(`\n  artifact: ${artifactId}`);
  console.log(`  old version: ${versionId}`);
  console.log(`  new version: ${newVersionId}`);
  console.log(`  review: ${SERVER}/review?artifact=${artifactId}&project=${PROJECT_ID}&version=${newVersionId}&view=focus`);
  console.log(`  thread: ${threadId} → resolved`);
}

run().catch(e => { console.error(e); process.exit(1); });