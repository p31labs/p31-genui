# P31 GenUI — Compiler-Gated Generative UI Pipeline

> **Models propose, a deterministic compiler validates, nothing executes unchecked.**

## Overview

P31 GenUI is a sovereign, locally-runnable compiler for AI-generated user interfaces. It confines model output to a fixed 7-component catalog, preventing hallucinations from reaching the screen.

Instead of prompting an LLM to write arbitrary HTML/React, P31 GenUI prompts the model to emit a JSON AST (Abstract Syntax Tree). That AST is then passed through a deterministic compiler (`compile()`) which validates the schema, repairs minor JSON syntax errors, and rejects any unknown components or invalid props.

## Architecture

1. **Plan:** The LLM generates a free-form JSON structure.
2. **Constrain:** The output is forced into the P31 dialect (a fixed 7-component catalog: `Stack`, `Text`, `StatCard`, `Card`, `Alert`, `Button`, `Badge`).
3. **Validate:** The `compile()` function validates the AST against a strict Zod schema. Unknown components throw enumerable error codes (e.g., `unknown_component`, `invalid_prop`).
4. **Project:** The `emitA2UIOfficial()` adapter lowers the P31 dialect to the official [A2UI v0.9 basic catalog](https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json), ensuring compatibility with third-party A2UI hosts.
5. **Review (Artifact Server):** The compiled UI is published to the P31 Artifact Server via MCP, where humans and agents can review, comment, and dispatch bounded repair loops.

## Objective Quality Evidence (OQE)

This repository is the source of truth for the following claims:

- **A2UI v0.9 Conformance:** 41/41 tests pass against the official schema.
- **Stateful Eval Harness:** `score-stateful-ui.mjs` runs a 10-episode, multi-turn UI-edit benchmark at `temperature=0`.
- **Model Parity:** A LoRA fine-tune of Qwen 3.5 4B (trained on 750 examples) achieved 50/50 parseable JSON and matched the base model's 60% requirement pass rate without catastrophic forgetting.
- **Estate Gate:** 33/33 internal CI gates pass.

## Components

- `src/a2ui.ts` — The core compiler and A2UI schema projection logic (`emitA2UI`, `emitA2UIOfficial`).
- `src/heal.ts` — Local JSON repair (`jsonrepair`, ~0.6ms vs ~4.8s to re-prompt).
- `src/compile.ts` — The deterministic AST validator.
- `scripts/a2ui-conformance.test.mjs` — Validates `emitA2UI` against the official v0.9 schema.
- `scripts/eval-stateful-ui.py` — Collects model output across multi-turn episodes (forces an empty `<think>` block for Qwen 3.5).
- `scripts/score-stateful-ui.mjs` — Scores the collected output through the real `compile()` and checks state retention.

## Usage

### 1. Run the Conformance Test

Ensure your compiled output perfectly matches the A2UI v0.9 spec.

```bash
npm install
node scripts/a2ui-conformance.test.mjs
# Output: 41 passed, 0 failed
```

### 2. Run the Stateful Evaluation

Evaluate a local GGUF model's ability to retain state across 5 turns of UI editing.

```bash
pip install llama-cpp-python
python scripts/eval-stateful-ui.py --model /path/to/qwen-v2.Q4_K_M.gguf --out outputs.jsonl
npx tsx scripts/score-stateful-ui.mjs --in outputs.jsonl
```

### 3. Connect to the Artifact Server (MCP)

Publish compiled artifacts directly to the P31 Artifact Server for human/agent review.

```json
{
  "mcpServers": {
    "p31-artifacts": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"]
    }
  }
}
```

## License

MIT
