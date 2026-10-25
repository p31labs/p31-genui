#!/usr/bin/env node
/**
 * @p31ca/genui — Artifact Bundle Publisher
 *
 * Publishes a P31 UI tree as a multi-file Artifact Server bundle:
 *   index.html  — rendered HTML (via emitMcpApp)
 *   tree.json   — the source tree (for deterministic edits)
 *
 * The tree.json is the source of truth: an agent can download it,
 * apply a JSON patch, and republish without reverse-engineering HTML.
 *
 * Usage:
 *   node publish-bundle.mjs --tree fixtures/sample.json --name "Bundle Test"
 *   node publish-bundle.mjs --tree fixtures/sample.json --artifact art_xxxx
 *     [--patch '[{"op":"update","blockId":"heading-1","props":{"title":"New"}}]']
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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

async function run() {
  console.log('P31 GenUI — Artifact Bundle Publisher\n');

  const treePath = arg('tree');
  assert(treePath, `--tree is required (got: ${treePath})`);
  const tree = JSON.parse(readFileSync(treePath, 'utf8'));
  assert(tree && tree.component, 'tree must be a valid P31 UI tree');

  // Import the emitter
  const { emitMcpApp } = await import('../src/mcp-apps.ts');
  const catalog = (await import('../src/catalog.ts')).getCatalog();
  const emission = emitMcpApp(tree, catalog, {
    title: arg('name', 'P31 GenUI Bundle'),
  });

  const treeJson = JSON.stringify(tree, null, 2);
  const html = emission.html;

  // 1. Create an upload - use correct schema
  const idemp = `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const treeSha = createHash('sha256').update(Buffer.from(treeJson, 'utf8')).digest('hex');
  const htmlSha = createHash('sha256').update(Buffer.from(html, 'utf8')).digest('hex');
  
  const uploadRes = await request('POST', '/api/v1/uploads', {
    entryPath: 'index.html',
    files: [
      { path: 'index.html', mediaType: 'text/html; charset=utf-8', sha256: htmlSha, size: Buffer.byteLength(html) },
      { path: 'tree.json', mediaType: 'application/json', sha256: treeSha, size: Buffer.byteLength(treeJson) },
    ],
    projectId: PROJECT_ID,
  }, { 'Idempotency-Key': idemp });
  assert(uploadRes.ok, `upload created (${uploadRes.data?.uploadId})`);

  const upload = uploadRes.data;
  const files = upload.files;

  // 2. PUT each file
  for (let i = 0; i < files.length; i++) {
    const content = i === 0 ? html : treeJson;
    const putRes = await fetch(files[i].uploadUrl, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': files[i].mediaType },
      body: content,
    });
    assert(putRes.ok, `file ${i + 1} uploaded (${files[i].path})`);
  }

  // 3. Commit
  const artifactId = arg('artifact');
  const commitBody = artifactId
    ? {
        target: { kind: 'new_version', artifactId, expectedCurrentVersionId: arg('expectedVersion') || null },
      }
    : {
        target: {
          kind: 'new_artifact',
          name: arg('name', 'P31 GenUI Bundle'),
          accessSetting: 'account_required',
          tags: ['genui', 'bundle'],
        },
      };

  // commitUrl is a full URL from the server
  const commitFetch = await fetch(upload.commitUrl, {
    method: 'POST',
    headers: { ...HEADERS, 'Idempotency-Key': `commit-${Date.now()}-${Math.random().toString(36).slice(2)}` },
    body: JSON.stringify(commitBody),
  });
  const commitText = await commitFetch.text();
  const commitData = JSON.parse(commitText);
  if (!commitFetch.ok) { console.error(commitText); process.exit(1); }
  const result = commitData;
  const newArtifactId = result.artifact?.id ?? artifactId;
  const newVersionId = result.version?.id ?? result.currentVersionId;

  console.log(`\n  artifact: ${newArtifactId}`);
  console.log(`  version:  ${newVersionId}`);
  console.log(`  review:   ${SERVER}/review?artifact=${newArtifactId}&project=${PROJECT_ID}&version=${newVersionId}&view=focus`);
  console.log(`\n  files: index.html, tree.json`);
  console.log(`  tree size: ${Buffer.byteLength(treeJson)} bytes`);
  console.log(`  html size: ${Buffer.byteLength(html)} bytes`);
}

run().catch(e => { console.error(e); process.exit(1); });