// @p31ca/genui — MCP Apps host contract test (stdio, no host UI required)
//
// Proves the local design MCP server serves the `ui://p31/layout` MCP App
// resource correctly over the real MCP stdio transport:
//
//   initialize -> tools/list -> resources/list -> resources/read ui://p31/layout
//
// Asserts:
//   - the resource exists and declares a text/html MCP App mime type
//   - the returned HTML is a complete document with the P31 layout root
//   - the declared (deny-by-default) CSP travels in contents[]._meta.ui.csp
//   - the ChatGPT alias (layout_generate._meta["openai/outputTemplate"])
//     resolves to the same URI and returns the same resource body
//   - the child process is cleaned up even when an assertion fails
//
// Usage: node packages/genui/scripts/mcp-apps-host.test.mjs
// Exit 0 when the contract holds; exit 1 otherwise.
//
// NOTE: this environment has per-package installs. The CLI package
// (cli/package.json) is not installed in this workspace, so dependency
// resolution points NODE_PATH at the design worker's installed deps
// (`yaml` + `@modelcontextprotocol/server`). The server itself is unchanged.

import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SERVER = path.join(ROOT, 'cli', 'design-mcp-server.js');
const LAYOUT_URI = 'ui://p31/layout';

const RPC_TIMEOUT_MS = 15_000;

const depDirs = [
  process.env.NODE_PATH,
  path.join(ROOT, 'workers', 'design-mcp', 'node_modules'),
  path.join(ROOT, 'cli', 'node_modules'),
].filter(Boolean).filter((dir) => existsSync(dir));

const nodePath = depDirs.join(path.delimiter);

let passed = 0;
function ok(msg) {
  passed += 1;
  console.log(`  \u2713 ${msg}`);
}

function startServer() {
  assert.ok(existsSync(SERVER), `local design-mcp entrypoint missing: ${SERVER}`);
  assert.ok(depDirs.length > 0, 'no dependency directory found (run pnpm install in workers/design-mcp or cli)');

  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Keep tests off the production governance ledger.
      P31_NO_LEDGER: '1',
      NODE_PATH: nodePath,
    },
  });

  const pending = new Map();
  let nextId = 0;
  let stdoutBuffer = '';
  let stderr = '';
  let closed = false;

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        continue; // non-JSON stdout noise (none expected, but do not hang)
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    }
  });

  child.on('exit', (code, signal) => {
    closed = true;
    for (const [id, { reject, timer }] of pending) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error(`server exited early (code=${code}, signal=${signal}) before response ${id}; stderr: ${stderr.trim()}`));
    }
  });

  function request(method, params) {
    assert.ok(!closed, `cannot send ${method}: server already exited`);
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${RPC_TIMEOUT_MS}ms; stderr: ${stderr.trim()}`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async function stop() {
    if (closed) return;
    child.stdin.end();
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const force = setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
        resolve();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
    });
  }

  return { child, request, notify, stop, stderr: () => stderr };
}

async function main() {
  console.log('MCP Apps host contract — design-mcp ui://p31/layout over real stdio\n');

  const server = startServer();
  try {
    // 1. initialize (legacy handshake is still served by the v2 SDK entry).
    const init = await server.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'genui-mcp-apps-host-test', version: '0.0.0' },
    });
    assert.ok(init && init.serverInfo, 'initialize returned serverInfo');
    assert.equal(init.serverInfo.name, 'p31-design-system');
    ok(`initialize negotiated with ${init.serverInfo.name} (protocol ${init.protocolVersion})`);
    server.notify('notifications/initialized');

    // 2. tools/list — layout_generate advertises the MCP App + ChatGPT alias.
    const tools = await server.request('tools/list', {});
    const layoutTool = (tools.tools || []).find((t) => t.name === 'layout_generate');
    assert.ok(layoutTool, 'tools/list includes layout_generate');
    ok('tools/list includes layout_generate');

    const meta = layoutTool._meta || {};
    assert.equal(meta?.ui?.resourceUri, LAYOUT_URI, 'layout_generate._meta.ui.resourceUri points at the layout resource');
    assert.equal(meta['openai/outputTemplate'], LAYOUT_URI, 'layout_generate._meta["openai/outputTemplate"] points at the layout resource');
    ok('layout_generate declares ui.resourceUri and the openai/outputTemplate alias');

    // 3. resources/list — the declared resource exists with the MCP App mime.
    const listed = await server.request('resources/list', {});
    const resource = (listed.resources || []).find((r) => r.uri === LAYOUT_URI);
    assert.ok(resource, `resources/list includes ${LAYOUT_URI}`);
    assert.match(resource.mimeType || '', /^text\/html(;|$)/, 'layout resource declares a text/html mime type');
    ok(`resources/list includes ${LAYOUT_URI} (${resource.mimeType})`);

    // 4. resources/read — complete document + P31 layout root + CSP metadata.
    const read = await server.request('resources/read', { uri: LAYOUT_URI });
    const content = read.contents?.[0];
    assert.ok(content, 'resources/read returned contents[0]');
    assert.equal(content.uri, LAYOUT_URI, 'content uri matches the requested resource');
    assert.match(content.mimeType || '', /^text\/html/, 'content mimeType is text/html');
    assert.equal(content.type ?? 'text', 'text');

    const html = content.text || '';
    assert.match(html, /^<!DOCTYPE html>/i, 'payload is a complete HTML document');
    assert.match(html, /<main\s+id="p31-layout-root"/, 'payload contains the P31 layout root');
    assert.match(html, /data-p31-layout-root="true"/, 'layout root is marked with data-p31-layout-root');
    assert.match(html, /data-mcp-app="true"/, 'document is marked as an MCP App');
    assert.match(html, /P31 Layout/, 'payload renders the canonical P31 Layout hero');
    ok('resources/read returns a complete HTML document with the P31 layout root');

    const csp = content._meta?.ui?.csp;
    assert.ok(csp, 'content carries _meta.ui.csp');
    assert.deepEqual(csp, {
      connectDomains: [],
      resourceDomains: ["'unsafe-inline'"],
      frameDomains: [],
      baseUriDomains: [],
    });
    ok('content declares the deny-by-default MCP App CSP');

    // 5. ChatGPT alias resolves to the same resource body.
    const aliasUri = layoutTool._meta['openai/outputTemplate'];
    const aliasRead = await server.request('resources/read', { uri: aliasUri });
    assert.equal(aliasRead.contents?.[0]?.text, html, 'alias read returns the same HTML as the canonical resource');
    assert.equal(aliasRead.contents?.[0]?.mimeType, content.mimeType, 'alias read returns the same mime type');
    ok(`${aliasUri} (ChatGPT alias) resolves to the same resource`);

    console.log(`\nPASS — ${passed} checks`);
  } finally {
    await server.stop();
    const stderr = server.stderr().trim();
    if (stderr) console.log(`\nserver stderr:\n${stderr}`);
  }
}

main().catch((err) => {
  console.error(`\nFAIL — ${err.message}`);
  process.exitCode = 1;
});
