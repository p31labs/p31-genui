/**
 * @p31ca/genui — Planning Step ("reason free, constrain late")
 *
 * The model first describes the UI in natural language (unconstrained),
 * then emits the JSON spec under constraint (given the plan).
 *
 * This recovers semantic accuracy that the constraint tax steals.
 */

import type { Catalog } from './catalog.ts';

export interface Plan {
  description: string;
  components: string[];
  order: string;
  content: Record<string, string>;
}

export function buildPlanPrompt(userPrompt: string, componentNames: string[]): string {
  return `You are a UI planner. Describe the interface in plain language, step by step.
Do NOT emit JSON. Just describe the plan.

Available components: ${componentNames.join(', ')}

User request: ${userPrompt}

Plan (describe what components, in what order, with what content):`;
}

/**
 * The prop CONTRACT — what each component actually accepts.
 *
 * The strict decoder forces every key in the schema's flat props bag to be
 * present, so the model has to decide ON ITS OWN which of the bag's 14 keys
 * belong to the component it is emitting. It cannot: the bag is the union over
 * all components, and the decoder cannot express a per-component schema
 * (Groq rejects oneOf/anyOf at the top level — proved 2026-10-21, HTTP 400
 * "schema must have type 'object' and not have 'oneOf'/'anyOf'"). The trees
 * that did come through died on the per-component compiler: every one of the
 * 11 trees that reached the model in the first strict arm failed with
 * `missing_required_prop` (the model put a prop in the wrong key, or left a
 * required one null).
 *
 * So the contract goes in the PROMPT, where the model can read it. This is
 * data from the catalog, never a hand-written list.
 */
export function buildPropContract(catalog: Catalog): string {
  const lines: string[] = [];
  for (const [name, entry] of Object.entries(catalog.components)) {
    const _shape = (entry.props as any)?._def?.shape; const shape = (typeof _shape === 'function' ? _shape() : _shape) ?? {};
    const parts: string[] = [];
    for (const [key, schema] of Object.entries(shape as Record<string, any>)) {
      const { node, chain } = unwrapProp(schema);
      const typeName = node?._def?.typeName;
      const values = node?._def?.values ?? node?._def?.entries ?? node?._def?.options;
      const kind = Array.isArray(values)
        ? values.join('|')
        : typeName === 'ZodNumber'
          ? 'number'
          : typeName === 'ZodBoolean'
            ? 'true|false'
            : 'text';
      const required = !chain.includes('ZodOptional');
      parts.push(`${key}${required ? '*' : ''} (${kind})`);
    }
    // The component's OWN EXAMPLE, verbatim from the catalog.
    //
    // Measured 2026-10-22 on the rejected trees: the model's mistakes were
    // not random. It used `title` on a StatCard (a Card prop) and
    // `spacing: "medium"` on a Stack (the catalog says `gap`, and the
    // values are md|sm|lg) — it was reaching for a plausible prop name
    // from the wrong component, because the contract listed the KEYS but
    // never showed what a correct node of that component looks like.
    // The catalog already carries an example per component; putting it
    // next to the keys makes the rule concrete at the point of use, and
    // it changes nothing about the metric.
    const example = Array.isArray(entry.examples) && entry.examples.length ? entry.examples[0] : null;
    lines.push(
      `- ${name}: ${parts.join(', ')}` + (example ? `\n    correct: ${example}` : ''),
    );
  }
  return lines.join('\n');
}

/** Read a Zod prop through its wrapper chain (optional/default/nullable). */
function unwrapProp(value: any): { node: any; chain: string[] } {
  let node = value;
  const chain: string[] = [];
  for (let i = 0; i < 6 && node; i++) {
    const name = node?._def?.typeName;
    chain.push(name ?? '?');
    if (name && !['ZodOptional', 'ZodNullable', 'ZodDefault'].includes(name)) break;
    node = node?._def?.innerType;
  }
  return { node, chain };
}

/**
 * Where the CONTRACT (the shape, the slot table, the prop table) travels.
 *
 * 'user' — the historical placement: the contract is part of the single user
 * message. 'system' — the contract is its own SYSTEM message and the user
 * message carries only the task.
 *
 * The placement is a MEASURED question, not a preference: a study of local
 * models found that embedding the system instructions in the user message
 * raised first-attempt invalid output from 1.7% to 7.9% versus keeping the
 * two roles separate. The pipeline cannot assume that finding holds for this
 * model on this route, so the harness measures it (--contract-role) instead of
 * asserting it. The default stays 'user' so every existing arm keeps its
 * fingerprint and resumes.
 */
export type ContractRole = 'user' | 'system';

export interface ConstrainedPromptOptions {
  /** Give the model the per-component prop contract (see buildPropContract). */
  propContract?: boolean;
  /** The decoder is the strict one: every schema key must be present. */
  strict?: boolean;
  /**
   * State the node SHAPE explicitly.
   *
   * Measured 2026-10-21 on the free-tier models: every one of them put the
   * props NEXT TO "component" instead of inside "props" —
   * `{"component":"Card","title":"Status Overview","children":[...]}` — and
   * the compile failed with `invalid_structure` on 100% of prompts. A
   * stronger model (qwen3.8-27b on Groq) infers the shape from the rules;
   * the shape was never written down. This block writes it down.
   */
  nodeShape?: boolean;
  /**
   * The decoder speaks the ADJACENCY dialect: a flat node list instead of a
   * nested tree. The prompt has to say so, or the model emits a tree and
   * the decoder rejects it.
   */
  adjacency?: boolean;
  /**
   * Where the contract travels: in the user message (default, historical) or
   * in its own system message. See ContractRole.
   */
  contractRole?: ContractRole;
}

/** The node shape, written out. */
export const NODE_SHAPE_BLOCK = `OUTPUT SHAPE (every node has exactly this shape):
{"component": "<component name>", "props": { "<prop>": "<value>" }, "children": [ <child nodes> ], "id": "<id>"}
- "props" is an OBJECT that holds that component's props. A prop NEVER sits next to "component".
- "children" is an ARRAY of nodes (empty array for a leaf).
- EVERY node, at EVERY depth, has exactly this shape — a child node is a full node, not a loose prop.
- The TOP-LEVEL JSON object IS the root node. Never wrap it in a "root" key.`;

/** The ADJACENCY output shape (the flat node list the per-component dialect
 *  decodes). */
export const ADJACENCY_SHAPE_BLOCK = `OUTPUT SHAPE (a FLAT LIST of nodes, not a nested tree):
{"nodes": [ { "id": "n1", "component": "<component name>", "props": { "<prop>": "<value>" }, "childIds": [ "n2" ] }, ... ]}
- "nodes" is an ARRAY of node objects. Every node appears EXACTLY ONCE.
- "id" is a string you choose; it must be unique. Use "n1", "n2", "n3"…
- "childIds" is an ARRAY of the ids of this node's children (empty array for a leaf).
- The FIRST node in the list is the root. A node's id must never appear in its own childIds.
- "props" is an OBJECT that holds that component's props. A prop NEVER sits next to "component".`;

/**
 * The SLOT contract, per component.
 *
 * Measured 2026-10-22: `slot_mismatch` was the third most common compile
 * failure, and the rule it enforces was stated in ONE line of an
 * eight-line list ("Children must be allowed in parent slots (leaf
 * components like Button/Text/Badge/StatCard/Alert have NO children)"). A
 * model that reads a list once and then writes a tree from a mental
 * template does not apply one line of it consistently — so the rule is
 * now a TABLE, which is checkable at the point of use.
 */
export function buildSlotContract(catalog: Catalog): string {
  const containers: string[] = [];
  const leaves: string[] = [];
  for (const [name, entry] of Object.entries(catalog.components)) {
    if (!entry.slots || entry.slots.length === 0) leaves.push(name);
    else containers.push(`${name} (accepts: ${entry.slots.join(', ')})`);
  }
  return [
    `CONTAINERS — only these may have children: ${containers.join('; ')}`,
    `LEAVES — these NEVER have children, their "children" array is always empty: ${leaves.join(', ')}`,
  ].join('\n');
}

/**
 * The CONTRACT blocks, in the order they are read.
 *
 * The SAME text in every placement: the 'user' placement carries it inside
 * the user message, the 'system' placement carries it as the system message.
 * Only the placement changes — the words do not — so an A/B between the two
 * measures the ROLE, not the content.
 */
function buildContractBlocks(options: ConstrainedPromptOptions & { catalog?: Catalog }): string[] {
  const extra: string[] = [];
  if (options.adjacency) {
    extra.push(ADJACENCY_SHAPE_BLOCK, '');
  } else if (options.nodeShape) {
    extra.push(NODE_SHAPE_BLOCK, '');
    if (options.catalog) {
      extra.push(buildSlotContract(options.catalog), '');
    }
  }
  if (options.propContract && options.catalog) {
    extra.push(
      'PROPS BY COMPONENT (use ONLY these keys on the component you emit; a * marks a REQUIRED key):',
      buildPropContract(options.catalog),
      '',
    );
    if (options.strict) {
      extra.push(
        'SCHEMA RULES (the strict decoder requires EVERY catalog prop key to be present on EVERY node):',
        '- Emit every key of the props bag, and set a key to null when it does not apply to the component you are emitting.',
        '- Never give a component a prop it does not accept, and never leave a required prop (marked *) null.',
      );
    }
  }
  return extra;
}

/** The task half of the prompt: what to build, and from which components. */
function promptHead(plan: string, componentNames: string[]): string {
  return `You are a UI spec emitter. Given this plan, emit ONLY a JSON object.

PLAN:
${plan}

AVAILABLE COMPONENTS: ${componentNames.join(', ')}`;
}

/** The rules half of the prompt. */
function promptTail(): string {
  return `RULES:
- Use "component" (not "type") for the component name field
- Use "content" (not "text") for Text props
- Use "label" for Button props
- Output ONLY valid JSON, no markdown, no explanation
- Only use components from the allowed list
- Props must match the schema (Button needs "label", Text needs "content", Card can have "title")
- Children must be allowed in parent slots (leaf components like Button/Text/Badge/StatCard/Alert have NO children)
- Use BFS order: root first, then all depth-1, then all depth-2

JSON spec:`;
}

/**
 * The constrained prompt, as ONE string.
 *
 * This is the historical form: the contract sits inside the user message.
 * It is what every arm measured before the role A/B, so it must not change —
 * the golden prompt in scripts/contract-role.test.mjs pins its bytes.
 */
export function buildConstrainedPrompt(
  plan: string,
  componentNames: string[],
  options: ConstrainedPromptOptions & { catalog?: Catalog } = {},
): string {
  const extra = buildContractBlocks(options);
  const block = extra.length ? `\n${extra.join('\n')}\n` : '';
  return `${promptHead(plan, componentNames)}\n${block}\n${promptTail()}`;
}

/**
 * The contract's TEXT, on its own.
 *
 * The prompt text is what an arm's numbers depend on, and the arm
 * fingerprint does NOT cover it: two runs with the same flags but different
 * contract text are the same ARM by fingerprint and are NOT the same
 * measurement. This is the text the harness hashes, so a change to the
 * contract is visible in the arm's provenance instead of being silent.
 */
export function buildContractText(
  options: ConstrainedPromptOptions & { catalog?: Catalog },
): string {
  const extra = buildContractBlocks(options);
  return extra.length ? extra.join('\n').replace(/\n+$/, '') : '';
}

/** The constrained prompt, split by ROLE. */
export interface ConstrainedMessages {
  /**
   * The contract as its own system message, or undefined when the placement
   * is 'user' (or when there is no contract to move).
   */
  system?: string;
  /** The task: the plan, the components and the rules. */
  user: string;
}

/**
 * The constrained prompt, split by role.
 *
 * 'user' (default) returns exactly the string buildConstrainedPrompt returns
 * — the same bytes, in the same message. 'system' moves the contract into
 * its own system message and leaves the task in the user message; the
 * contract's WORDS are unchanged, so the two placements differ only in the
 * role the contract travels in.
 */
export function buildConstrainedMessages(
  plan: string,
  componentNames: string[],
  options: ConstrainedPromptOptions & { catalog?: Catalog } = {},
): ConstrainedMessages {
  const extra = buildContractBlocks(options);
  const head = promptHead(plan, componentNames);
  const tail = promptTail();
  const role = options.contractRole ?? 'user';

  if (role !== 'system' || extra.length === 0) {
    const block = extra.length ? `\n${extra.join('\n')}\n` : '';
    return { user: `${head}\n${block}\n${tail}` };
  }

  // The system half: the contract, verbatim, and nothing else. The trailing
  // blank lines of the block are dropped so the system message is the
  // contract itself.
  const system = extra.join('\n').replace(/\n+$/, '');
  return { system, user: `${head}\n\n${tail}` };
}

export function extractPlan(response: string): string {
  // Extract the plan text (everything before any JSON)
  const jsonMatch = response.match(/(\{[\s\S]*\})/);
  if (jsonMatch) {
    return response.slice(0, jsonMatch.index).trim();
  }
  return response.trim();
}
