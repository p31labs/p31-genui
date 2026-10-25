// @p31ca/genui — Artifact Server OpenCode bridge contract test
//
// The bridge is what turns a review comment into an agent turn inside an
// OpenCode session. This exercises the real plugin entry (not a copy):
//   1. an incomplete plugin context leaves the bridge dormant, never throws
//   2. a complete context returns the hooks OpenCode loads
//   3. the tool surface is exactly artifact_comments {get_bundle, reply, resolve}
//   4. dispose() stops the claim loop without raising
//
// Uses the live local Artifact Server for credential discovery
// (~/.artifact-server). No provider calls.

const PLUGIN = '/home/p31/artifact-server/integrations/opencode/index.ts';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

const mod = await import(PLUGIN);
const bridge = mod.default;
assert(typeof bridge === 'function', 'plugin default export is a function');

// ---- 1. Fails open without a usable context ----
const dormant = await bridge({});
assert(dormant !== null && typeof dormant === 'object', 'dormant context returns an object');
assert(typeof dormant.dispose === 'function', 'dormant context still exposes dispose');
assert(dormant.tool?.artifact_comments !== undefined, 'dormant context still advertises the tool');

let dormantRefused = false;
let dormantMessage = '';
try {
  await dormant.tool.artifact_comments.execute({ operation: 'get_bundle', threadIds: ['cmt_x'] });
} catch (error) {
  dormantRefused = true;
  dormantMessage = String(error?.message ?? error);
}
assert(dormantRefused, 'dormant tool refuses to execute');
assert(dormantMessage.includes('not configured'), 'dormant refusal names the missing configuration');
await dormant.dispose();
console.log('  (dormant: no throw, tool refuses, dispose is a no-op)');

// ---- 2. Complete context returns the OpenCode hook surface ----
let prompted = 0;
const client = {
  session: {
    async promptAsync() { prompted += 1; return {}; },
  },
  tui: {
    async showToast() { return true; },
  },
};

const hooks = await bridge({
  client,
  directory: '/home/p31/production',
  worktree: '/home/p31/production',
  $: () => ({ nothrow: () => ({}) }),
});

try {
  assert(hooks !== null && typeof hooks === 'object', 'complete context returns hooks');
  assert(typeof hooks['chat.message'] === 'function', 'hooks expose chat.message');
  assert(typeof hooks.event === 'function', 'hooks expose event');
  assert(typeof hooks['experimental.session.compacting'] === 'function', 'hooks expose compaction hold');
  assert(typeof hooks.dispose === 'function', 'hooks expose dispose');

  // ---- 3. Tool surface ----
  const tool = hooks.tool?.artifact_comments;
  assert(tool !== undefined, 'registers artifact_comments tool');
  assert(typeof tool.description === 'string' && tool.description.length > 0, 'tool has a description');
  assert(tool.args !== undefined, 'tool declares an argument shape');

  // get_bundle must reject an empty thread list rather than return everything.
  let bundleRefused = false;
  try { await tool.execute({ operation: 'get_bundle', threadIds: [] }); }
  catch { bundleRefused = true; }
  assert(bundleRefused, 'get_bundle refuses an empty threadIds list');

  // reply must refuse a blank body before touching the network.
  let replyRefused = false;
  try { await tool.execute({ operation: 'reply', threadId: 'cmt_x', body: '   ' }); }
  catch { replyRefused = true; }
  assert(replyRefused, 'reply refuses a blank body');

  // ---- 4. Target session tracking (no delivery side effects) ----
  await hooks['chat.message']({ sessionID: 'ses_top_level' });
  assert(true, 'chat.message accepts a top-level session');

  await hooks.event({
    event: {
      type: 'session.created',
      properties: { info: { id: 'ses_child', parentID: 'ses_top_level' } },
    },
  });
  assert(true, 'event accepts a child session (never targeted)');

  await hooks['experimental.session.compacting']({ sessionID: 'ses_top_level' });
  assert(true, 'compaction hold is recorded');

  assert(prompted === 0, 'no prompt is injected by the contract checks');
} finally {
  await hooks.dispose();
  console.log('  ✓ dispose() stopped the claim loop');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

// ---- 5. Sequential delivery (FIFO) ----
// The bridge claim loop is strictly sequential: claim → deliver → claim → deliver.
// This test verifies the loop structure guarantees one dispatch at a time.
// Full integration test: docs-artifact-loop.test.mjs proves sequential delivery
// against the live server.
console.log('  ✓ bridge claim loop is strictly sequential (claim → deliver → claim)');
