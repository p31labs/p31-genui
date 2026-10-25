---
name: p31-genui-review-loop
description: >
  Use this skill when the user asks to review, edit, or update a GenUI artifact
  via the Artifact Server review loop. Triggers on: "send review", "address comments",
  "apply patch", "republish artifact", "edit the UI", "update the design",
  "fix the component", "change the heading". Handles the full lifecycle:
  fetch bundle → apply patch → republish → reply → resolve.
license: MIT
metadata:
  version: "1.0"
  category: genui-review
  source: "P31 GenUI pipeline 2026-10-23"
---

# P31 GenUI Review Loop Skill

## When to Use

When an Artifact Server dispatch arrives (via the OpenCode bridge or MCP), it
carries comment threads on a GenUI artifact. This skill describes the exact
sequence to address them: read the bundle, generate a patch, apply it, republish,
reply, and resolve.

## Architecture

```
Human comments in review UI
        │
        ▼
Artifact Server dispatch (queued → claimed → delivered)
        │
        ▼
OpenCode session receives follow-up prompt
        │
        ▼
Agent reads threads via artifact_comments {get_bundle}
        │
        ▼
Agent fetches tree.json from artifact bundle
        │
        ▼
Agent generates JSON patch (update/insert/remove/move)
        │
        ▼
Agent runs: node apply-patch.mjs --artifact <id> --thread <id> --patch '[...]'
        │
        ▼
Patch applied → recompiled → republished as new version
        │
        ▼
Agent replies to thread + resolves it
        │
        ▼
Dispatch transitions to "addressed"
```

## Tools Available

### artifact_comments
- `get_bundle` — Read threads from a dispatch (requires threadIds[])
- `reply` — Reply to a thread with what was done
- `resolve` — Mark thread as resolved (idempotent)

### apply-patch.mjs
Deterministic edit + republish:
```bash
node packages/genui/scripts/apply-patch.mjs \
  --artifact <artifact-id> \
  --thread <thread-id> \
  --patch '[{"op":"update","blockId":"heading-1","props":{"content":"New Title"}}]'
```

Supported patch ops:
- `update` — change props or children of a block (by blockId)
- `insert` — insert a new block into a parent
- `remove` — remove a block by ID
- `move` — move a block to a new parent

### publish-bundle.mjs
Publish a new GenUI artifact from a tree:
```bash
node packages/genui/scripts/publish-bundle.mjs \
  --tree <path-to-tree.json> \
  --name "Artifact Name"
```

## Step-by-Step Workflow

### 1. Receive the dispatch
When a dispatch arrives, you'll see a message like:
```
Artifact Server: Local sent N annotation(s) to address.
[Artifact Name · version X]
  comment body
  (thread cmt_xxx)
```

### 2. Read the bundle
Use `artifact_comments {get_bundle, threadIds: [...]}` to read all threads.

### 3. Fetch the tree
The artifact is a bundle with `index.html` + `tree.json`. Fetch the tree:
```
GET /api/v1/artifacts/{artifactId}/versions/{versionId}/file?path=tree.json
```

### 4. Generate the patch
For each open thread, determine the appropriate edit:
- "add color" → update props with color/style changes
- "change heading" → update the heading block's props
- "add a component" → insert a new block
- "remove X" → remove the block

### 5. Apply the patch
```bash
node packages/genui/scripts/apply-patch.mjs \
  --artifact <artifact-id> \
  --thread <thread-id> \
  --patch '[{"op":"update","blockId":"heading-1","props":{"content":"Operations Overview"}}]'
```

### 6. Reply and resolve
The apply-patch script auto-replies and resolves the thread. If not using apply-patch:
```
artifact_comments {reply, threadId, body: "what you did"}
artifact_comments {resolve, threadId}
```

### 7. Confirm
The dispatch auto-transitions to "addressed" when all threads resolve.

## Component Catalog

The P31 catalog includes these components (use in patches):

| Component | Key Props |
|-----------|-----------|
| Stack | direction (vertical/horizontal), gap (sm/md/lg) |
| Text | content, size (sm/md/lg/xl), weight (normal/bold) |
| Card | title, subtitle |
| StatCard | label, value, trend (up/down/flat) |
| Alert | message, variant (info/warning/error/success) |
| Button | label, variant (primary/secondary/ghost) |
| Badge | label, variant (default/success/warning/error) |
| Input | label, placeholder, type |
| Select | label, options[] |
| Table | columns[], rows[] |
| Chart | type, data, title |

## Patch Examples

### Change a heading
```json
[{"op":"update","blockId":"heading-1","props":{"content":"Operations Overview"}}]
```

### Add color to a component
```json
[{"op":"update","blockId":"card-1","props":{"style":{"backgroundColor":"#1a1a2e","color":"#e0e0e0"}}}]
```

### Insert a new StatCard
```json
[{"op":"insert","parentId":"stat-row","index":2,"block":{"component":"StatCard","props":{"label":"Users","value":"1,200","trend":"up"}}}]
```

### Remove a block
```json
[{"op":"remove","blockId":"deprecated-card"}]
```

### Move a block
```json
[{"op":"move","blockId":"stat-2","parentId":"stat-row","index":0}]
```

## Constraints

- **No paid model calls** — use Cerebras (free tier, constrained decoding)
- **No Cloudflare/R2** — all artifacts are local SQLite + local blob storage
- **BlockNote without Yjs** — collaboration is disabled
- **No direct commits to main** — all changes go through the review loop
- **Estate gate must pass** before merge

## Multi-Bundle Queue (FIFO)

The dispatch spec guarantees strict FIFO delivery: bundle B is delivered only
after the agent finishes bundle A. The bridge enforces this at the transport
layer. The agent must enforce it at the skill layer:

1. **Never merge two bundles.** Each bundle is an independent review cycle.
2. **Finish bundle A completely** (reply + resolve every thread) before
   starting bundle B.
3. **Call `dispatch_inbox` again** after finishing bundle A to claim bundle B.
4. If a second bundle arrives while you are working, acknowledge it but do
   not start processing it until the current bundle is fully resolved.
5. If you receive two bundles in rapid succession, process them in the order
   they arrived. Do not reorder.


## Multi-Bundle Queue (FIFO)

The dispatch spec guarantees strict FIFO delivery: bundle B is delivered only
after the agent finishes bundle A. The bridge enforces this at the transport
layer. The agent must enforce it at the skill layer:

1. **Never merge two bundles.** Each bundle is an independent review cycle.
2. **Finish bundle A completely** (reply + resolve every thread) before
   starting bundle B.
3. **Call `dispatch_inbox` again** after finishing bundle A to claim bundle B.
4. If a second bundle arrives while you are working, acknowledge it but do
   not start processing it until the current bundle is fully resolved.
5. If you receive two bundles in rapid succession, process them in the order
   they arrived. Do not reorder.

## Error Handling


| Error | Meaning | Fix |
|-------|---------|-----|
| `COMMENT_RESOLVED` (409) | Thread already resolved | Skip reply, proceed to next |
| `NOT_FOUND` | Thread or artifact doesn't exist | Check IDs, re-fetch |
| `INVALID_INPUT` | Malformed request | Check JSON schema |
| Agent not connected | No live agent polling | Check OpenCode V2 plugin loaded |

## Verification

After applying a patch:
1. Check the new version exists: `GET /api/v1/artifacts/{id}/versions/{newVersionId}`
2. Verify the tree changed: `GET .../file?path=tree.json`
3. Verify the HTML updated: `GET .../file?path=index.html`
4. Confirm the thread is resolved: `GET .../comments/{threadId}` → state: resolved
5. Confirm dispatch is addressed: `GET /api/v1/agent-dispatches/{id}` → state: addressed