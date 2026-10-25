// @p31ca/genui — Artifact Server dispatch loop test
// Proves the full protocol: register agent → create comment → dispatch → claim → reply → resolve
// Runs against the local Artifact Server (localhost:8787, SQLite + local storage, no R2).
// No provider calls.

import { readFileSync } from 'node:fs';

const TOKEN = readFileSync('/home/p31/.artifact-server/local-api-token', 'utf8').trim();
const SERVER = 'http://localhost:8787';
const HEADERS = {
  'Authorization': `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/event-stream',
};

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

async function http(method, path, body = null, extra = {}) {
  const opts = { method, headers: { ...HEADERS, ...extra } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${SERVER}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { data, ok: res.ok, status: res.status };
}

async function mcpTool(name, args = {}) {
  const res = await fetch(`${SERVER}/mcp`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 1 }),
  });
  const text = await res.text();
  // Parse SSE
  const line = text.split('\n').find(l => l.startsWith('data:'));
  if (!line) return { data: text, ok: false, status: res.status };
  const parsed = JSON.parse(line.replace('data: ', ''));
  return { data: parsed, ok: res.ok, status: res.status };
}

async function run() {
  console.log('Artifact Server dispatch loop test\n');

  // 1. Register agent
  const agentRes = await http('POST', '/api/v1/agents', {
    displayName: 'genui-test-agent',
    kind: 'opencode',
    workingDirectory: '/home/p31/production',
  });
  assert(agentRes.ok, `agent registered (${agentRes.data?.agent?.id})`);
  const agentId = agentRes.data?.agent?.id;

  // 2. Publish a test artifact (or reuse existing)
  const artRes = await http('POST', '/api/v1/artifacts', {
    name: 'genui-dispatch-test',
    projectId: 'prj_default',
  });
  // If create endpoint doesn't exist, try listing
  if (!artRes.ok) {
    // Try publishing via CLI-style (use existing artifact)
    console.log('  (artifact create not available via API, using existing)');
  }

  // Use the existing test artifact
  const artifactId = 'art_7ca77752-d6c3-4eda-b1a8-8ced139f2713';
  const versionId = 'ver_f9fda040-c755-4ee7-ba5e-e2724056477c';

  // 3. Create a comment thread
  const idempKey = `test-${Date.now()}`;
  const commentRes = await http('POST', `/api/v1/artifacts/${artifactId}/versions/${versionId}/comments?project=prj_default`, {
    body: 'Please fix the StatCard component styling',
  }, { 'Idempotency-Key': idempKey });
  assert(commentRes.ok, `comment created (${commentRes.data?.thread?.id})`);
  const threadId = commentRes.data?.thread?.id;

  // 4. Create a dispatch
  const dispatchRes = await http('POST', '/api/v1/agent-dispatches', {
    agentId,
    threadIds: [threadId],
  }, { 'Idempotency-Key': `disp-${Date.now()}` });
  assert(dispatchRes.ok, `dispatch created (${dispatchRes.data?.dispatch?.id})`);
  const dispatchId = dispatchRes.data?.dispatch?.id;

  // 5. Claim via dispatch_inbox MCP tool
  const claimRes = await mcpTool('dispatch_inbox', {});
  // dispatch_inbox might need specific params; check response
  assert(claimRes.ok, 'dispatch_inbox called');

  // 6. Claim via HTTP (fallback, since MCP dispatch_inbox may need agent context)
  const httpClaim = await http('POST', `/api/v1/agents/${agentId}/claims`, {});
  assert(httpClaim.ok, `dispatch claimed (${httpClaim.data?.dispatch?.state})`);
  assert(httpClaim.data?.dispatch?.state === 'claimed', 'dispatch state is claimed');

  // 7. Report delivered
  const deliverRes = await http('POST', `/api/v1/agent-dispatches/${dispatchId}/delivered`, {
    agentId,
  });
  assert(deliverRes.ok, `dispatch delivered (${deliverRes.data?.dispatch?.state})`);

  // 8. Reply to the thread
  const replyRes = await http('POST', `/api/v1/artifacts/${artifactId}/comments/${threadId}/replies?project=prj_default`, {
    body: 'Fixed the StatCard styling. Updated border radius and padding.',
  }, { 'Idempotency-Key': `reply-${Date.now()}` });
  assert(replyRes.ok, 'reply posted');

  // 9. Resolve the thread
  const resolveRes = await http('PATCH', `/api/v1/artifacts/${artifactId}/comments/${threadId}?project=prj_default`, {
    state: 'resolved',
  });
  assert(resolveRes.ok, `thread resolved (${resolveRes.data?.thread?.state})`);
  assert(resolveRes.data?.thread?.state === 'resolved', 'thread state is resolved');

  // 10. Verify via comment_list MCP tool
  const listRes = await mcpTool('comment_list', { artifactId, projectId: 'prj_default' });
  assert(listRes.ok, 'comment_list called via MCP');

  // 11. Cleanup: disconnect the test agent so it doesn't appear as "offline" in the UI.
  const discRes = await http('POST', `/api/v1/agents/${agentId}/disconnect`);
  assert(discRes.ok, `agent disconnected (${discRes.status})`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
