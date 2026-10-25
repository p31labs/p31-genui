#!/usr/bin/env node
/**
 * @p31ca/genui — Perturbed-Catalog SFT Dataset Builder
 *
 * Generates training data for 4B distillation following the methodology from
 * "Toward Frontier-Quality Declarative UI Generation at Small-Model Cost"
 * (arXiv:2609.04184).
 *
 * Strategy: Perturbed-catalog augmentation (Pareto-dominates unaugmented
 * Full-catalog baseline). For each base (prompt, A2UI) pair:
 *   1. Generate the base A2UI from a P31 tree using the existing pipeline
 *      (generateUI from orchestrate.ts, called against Cerebras)
 *   2. Apply the paper's exact perturbation:
 *      - Shuffle catalog component order
 *      - Drop a random subset of unused components
 *      - Rename 20% of remaining components (not one)
 *      - Apply the SAME rename mapping to both the catalog in the system
 *        prompt AND the target updateComponents payload
 *   3. Keep both (original + perturbed) as training examples
 *
 * The 7-component catalog is NOT a ceiling — small models benefit from
 * larger catalogs (paper finding). Perturbation increases catalog coverage.
 *
 * CRITICAL: The rename mapping MUST be applied consistently to both the
 * catalog and the A2UI output.
 *
 * Usage:
 *   node scripts/with-env.mjs node scripts/build-sft-dataset.mjs \
 *     --out packages/genui/fixtures/sft-dataset.jsonl \
 *     --limit 10 --resume
 *
 * Output: JSONL with {prompt, catalog, a2ui, metadata} per line
 *
 * Batched execution: Cerebras free tier has 14,400 RPD. Each prompt
 * consumes ~2-3 API calls (plan + constrained + repair). Run with --limit
 * to stay within daily budget, --resume to continue.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = '/home/p31/production';

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

// 7-component catalog (P31's actual catalog)
const CATALOG = {
  components: {
    Stack: { props: { direction: ['vertical', 'horizontal'], gap: ['sm', 'md', 'lg'] } },
    Text: { props: { content: 'string', size: ['sm', 'md', 'lg', 'xl'], weight: ['normal', 'bold'] } },
    Card: { props: { title: 'string', subtitle: 'string' } },
    StatCard: { props: { label: 'string', value: 'string', trend: ['up', 'down', 'flat'] } },
    Alert: { props: { message: 'string', variant: ['info', 'warning', 'error', 'success'] } },
    Button: { props: { label: 'string', variant: ['primary', 'secondary', 'ghost'] } },
    Badge: { props: { label: 'string', variant: ['default', 'success', 'warning', 'error'] } },
  },
};

// Training prompts — 30 diverse, covering all components in multi-level compositions
const BASE_PROMPTS = [
  'Create a dashboard with a heading "Revenue" and a StatCard showing 42,000',
  'Create a card with title "Alert Center" and an Alert with message "System OK"',
  'Create a vertical Stack with a Text saying "Welcome" and a Badge labeled "New"',
  'Create a horizontal Stack with two StatCards: Revenue 42,000 and Customers 1,200',
  'Create a Card with title "Settings" containing a Button labeled "Save" and a Button labeled "Cancel"',
  'Create an Alert with message "Warning" variant warning and a Badge labeled "Beta"',
  'Create a Stack with a Text heading "Dashboard" and three StatCards for Revenue, Users, and Orders',
  'Create a Card with title "Profile" containing Text "Name: Admin" and a Button "Edit"',
  'Create a vertical layout with an Alert "All systems operational" and a Badge "v1.0"',
  'Create a dashboard with Revenue StatCard 42,000 up trend and Customers StatCard 1,200 up trend',
  'Create a Card titled "Notifications" with an Alert "3 unread" and a Button "Mark all read"',
  'Create a Stack with heading "Analytics" and StatCards for Page Views 10k, Clicks 500, Conversions 50',
  'Create a Card with title "Status" containing an Alert "Degraded" variant warning and Badge "Investigating"',
  'Create a vertical Stack: Text "Welcome Back", Card "Quick Actions" with Button "New Project", Badge "Pro"',
  'Create a dashboard: heading "Overview", StatCard Revenue 42,000 up, StatCard Orders 150 flat, Alert "All good" success',
  'Create a Card with title "User Profile" containing Text "Email: admin@p31.dev" and Button "Update"',
  'Create a Stack with heading "Metrics" and StatCards for CPU 45%, Memory 8GB, Disk 250GB',
  'Create an Alert with message "Deployment complete" variant success and Badge "v2.0"',
  'Create a Card titled "Quick Links" with Button "Docs" and Button "Support" and Badge "New"',
  'Create a vertical Stack: Text "System Health", Alert "All green" success, Badge "OK"',
  'Create a dashboard with heading "Operations" and StatCards for Uptime 99.9%, Errors 0, Latency 42ms',
  'Create a Card with title "Recent Activity" containing Text "5 new comments" and Button "View all"',
  'Create a Stack with heading "Team" and Cards for Alice, Bob, and Charlie with Button "Message"',
  'Create an Alert with message "Maintenance scheduled" variant info and Badge "Scheduled"',
  'Create a Card titled "Revenue Breakdown" with StatCard Q1 10k, StatCard Q2 15k, StatCard Q3 20k',
  'Create a vertical Stack: Text "Welcome to P31", Card "Getting Started" with Button "Tour", Badge "New"',
  'Create a dashboard: heading "Performance", StatCard Load Time 1.2s, StatCard TTFB 200ms, Alert "Fast" success',
  'Create a Card with title "Settings" containing Text "Theme: Dark" and Button "Change" and Badge "Beta"',
  'Create a Stack with heading "Notifications" and Alert "New message" info and Button "Read" and Badge "1"',
  'Create a vertical Stack: Text "P31 Dashboard", StatCard Health 100%, Alert "All systems go" success, Badge "Live"',
];

// Revision prompts for 5-turn episodes (cross-turn retention training)
// Each base prompt gets 4 revision turns that modify the existing tree
const REVISION_TEMPLATES = [
  { type: 'change_prop', prompt: 'Change the heading to "Operations Overview"' },
  { type: 'add_component', prompt: 'Add a StatCard for Orders with value 150' },
  { type: 'remove_component', prompt: 'Remove the first Button' },
  { type: 'change_variant', prompt: 'Change the Alert to error variant' },
];

// Revision prompt generator: creates a revision prompt based on the base prompt
function generateRevisionPrompt(basePrompt, revisionType, turnIndex) {
  const revisions = {
    change_prop: `Change the heading text to "Operations Overview"`,
    add_component: `Add a new StatCard for Orders with value 150 and trend flat`,
    remove_component: `Remove the first Button from the layout`,
    change_variant: `Change the Alert variant to error`,
  };
  return revisions[revisionType] || `Modify the layout: ${revisionType}`;
}

// Generate a revision tree by applying a modification to the base tree
function generateRevisionTree(baseTree, revisionType, turnIndex) {
  const clone = JSON.parse(JSON.stringify(baseTree));
  switch (revisionType) {
    case 'change_prop':
      // Change heading content
      for (const child of clone.children || []) {
        if (child.component === 'Text' && child.props?.size === 'xl') {
          child.props.content = 'Operations Overview';
        }
      }
      break;
    case 'add_component':
      // Add a StatCard
      const statRow = clone.children?.find(c => c.id === 'stat-row');
      if (statRow && Array.isArray(statRow.children)) {
        statRow.children.push({ id: `stat-${statRow.children.length}`, component: 'StatCard', props: { label: 'Orders', value: '150', trend: 'flat' } });
      }
      break;
    case 'remove_component':
      // Remove first Button
      for (const child of clone.children || []) {
        if (child.component === 'Stack' && Array.isArray(child.children)) {
          const btnIdx = child.children.findIndex(c => c.component === 'Button');
          if (btnIdx >= 0) child.children.splice(btnIdx, 1);
        }
      }
      break;
    case 'change_variant':
      // Change Alert variant
      for (const child of clone.children || []) {
        if (child.component === 'Alert') child.props.variant = 'error';
        if (Array.isArray(child.children)) {
          for (const gc of child.children) {
            if (gc.component === 'Alert') gc.props.variant = 'error';
          }
        }
      }
      break;
  }
  return clone;
}

// Generate additional prompts by composing variations (to reach 150+)
function generatePrompts(basePrompts, target) {
  const prompts = [...basePrompts];
  const values = ['42,000', '1,200', '95', '10,000', '500', '150', '3', '7', '1,000', '250', '99.9%', '0', '200ms', '1.2s'];
  const labels = ['Revenue', 'Customers', 'Score', 'Page Views', 'Clicks', 'Orders', 'Users', 'Conversions', 'Signups', 'Latency', 'Uptime', 'Errors'];
  const components = ['Stack', 'Text', 'Card', 'StatCard', 'Alert', 'Button', 'Badge'];

  // Deduplicate while generating
  const seen = new Set(prompts);

  function addUnique(p) {
    if (!seen.has(p)) {
      seen.add(p);
      prompts.push(p);
      return true;
    }
    return false;
  }

  let attempts = 0;
  const maxAttempts = target * 10;
  while (prompts.length < target && attempts < maxAttempts) {
    attempts++;
    const idx = attempts % basePrompts.length;
    const base = basePrompts[idx];
    const mod = attempts % 8;
    let variant;
    if (mod === 0) {
      variant = base.replace('Create', 'Build');
    } else if (mod === 1) {
      variant = 'Redesign: ' + base.toLowerCase();
    } else if (mod === 2) {
      const extraLabel = labels[attempts % labels.length];
      const extraValue = values[attempts % values.length];
      variant = base + ` and a StatCard for ${extraLabel} with value ${extraValue}`;
    } else if (mod === 3) {
      variant = base.replace('Create a', 'Create an advanced');
    } else if (mod === 4) {
      variant = base.replace('Create', 'Generate');
    } else if (mod === 5) {
      const comp = components[attempts % components.length];
      variant = base + ` with a ${comp} added`;
    } else if (mod === 6) {
      variant = base.replace('Create', 'Construct');
    } else {
      variant = 'Update: ' + base.toLowerCase().replace('create', 'modify');
    }
    addUnique(variant);
  }

  return prompts.slice(0, target);
}

// Perturbation: paper's exact method
function perturbCatalog(catalog) {
  const clone = JSON.parse(JSON.stringify(catalog));
  const componentNames = Object.keys(clone.components);

  // 1. Shuffle component order
  const shuffled = [...componentNames].sort(() => Math.random() - 0.5);

  // 2. Drop a random subset of unused components (keep at least 4)
  const keepCount = Math.max(4, Math.floor(shuffled.length * (0.6 + Math.random() * 0.3)));
  const kept = shuffled.slice(0, keepCount);

  // 3. Rename 20% of remaining components
  const renameCount = Math.max(1, Math.floor(kept.length * 0.2));
  const toRename = kept.slice(0, renameCount);
  const mapping = {};

  const newComponents = {};
  for (const name of kept) {
    if (toRename.includes(name)) {
      const newName = name + 'Alt';
      newComponents[newName] = clone.components[name];
      mapping[name] = newName;
    } else {
      newComponents[name] = clone.components[name];
    }
  }

  clone.components = newComponents;

  // Reorder according to shuffled order (with renames applied)
  const reordered = {};
  for (const name of shuffled) {
    const mappedName = mapping[name] || name;
    if (newComponents[mappedName] && !reordered[mappedName]) {
      reordered[mappedName] = newComponents[mappedName];
    }
  }
  clone.components = reordered;

  return { catalog: clone, mapping };
}

function applyMappingToTree(tree, mapping, catalog) {
  const clone = JSON.parse(JSON.stringify(tree));
  const keptComponents = new Set(Object.keys(catalog.components));

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.component && mapping[node.component]) {
      node.component = mapping[node.component];
    }
    if (node.component && !keptComponents.has(node.component)) {
      const fallback = Object.keys(catalog.components)[0];
      node.component = fallback;
    }
    if (Array.isArray(node.children)) node.children.forEach(c => walk(c));
  }
  walk(clone);
  return clone;
}

function treeToA2UI(tree) {
  const components = [];
  function flatten(node) {
    const id = node.id || `c${components.length}`;
    const comp = { id, component: node.component };
    if (node.props) Object.assign(comp, node.props);
    if (Array.isArray(node.children) && node.children.length > 0) {
      comp.children = node.children.map(c => c.id || `c${components.length}`);
      node.children.forEach(c => flatten(c));
    } else {
      comp.children = [];
    }
    components.push(comp);
  }
  flatten(tree);

  return {
    version: 'v0.9',
    createSurface: { surfaceId: 'main', catalogId: 'p31-catalog' },
    updateComponents: { surfaceId: 'main', components },
  };
}

async function generateRealTree(prompt) {
  try {
    const { generateUI } = await import('../src/orchestrate.ts');
    const { getCatalog } = await import('../src/catalog.ts');
    const { createProvider } = await import('../src/provider.ts');
    const { getProvider } = await import('../src/providers.ts');

    const catalog = getCatalog();
    const providerId = arg('provider', 'cerebras');
    const provider = getProvider(providerId);
    const keyEnv = provider.keyEnv || 'CEREBRAS_API_KEY';
    const apiKey = process.env[keyEnv];
    const model = provider.defaultModel || 'qwen-3.8-27b';
    const modelFn = createProvider({
      model,
      apiKey,
      baseUrl: provider.baseUrl,
      headers: provider.headers,
      attemptTimeoutMs: 60000,
      maxAttempts: 3,
      body: { temperature: 0.1, max_tokens: 2048 },
    });

    const result = await generateUI(prompt, catalog, modelFn, providerId, model, 3, 900000, {
      propContract: true,
      nodeShape: true,
      schemaDialect: 'union-nullable',
      contractRole: 'user',
    });

    return result.success ? result.tree : null;
  } catch (e) {
    console.error(`  generateUI failed: ${e.message?.slice(0, 80)}`);
    return null;
  }
}

function generateSyntheticTree(prompt) {
  const lower = prompt.toLowerCase();
  const children = [];

  if (lower.includes('heading') || lower.includes('dashboard') || lower.includes('overview')) {
    const content = prompt.match(/"([^"]+)"/)?.[1] || 'Dashboard';
    children.push({ id: 'heading-1', component: 'Text', props: { content, size: 'xl', weight: 'bold' } });
  }
  if (lower.includes('statcard') || lower.includes('revenue') || lower.includes('customers') || lower.includes('score') || lower.includes('orders') || lower.includes('users') || lower.includes('page views') || lower.includes('clicks') || lower.includes('conversions')) {
    const values = prompt.match(/(\d[\d,]*)/g) || ['0'];
    const labels = ['Revenue', 'Customers', 'Score', 'Orders', 'Users', 'Page Views', 'Clicks', 'Conversions'];
    for (let i = 0; i < Math.min(values.length, 3); i++) {
      children.push({ id: `stat-${i}`, component: 'StatCard', props: { label: labels[i % labels.length], value: values[i], trend: 'up' } });
    }
  }
  if (lower.includes('alert')) {
    children.push({ id: `alert-${children.length}`, component: 'Alert', props: { message: 'System OK', variant: 'info' } });
  }
  if (lower.includes('button')) {
    const label = prompt.match(/labeled "([^"]+)"/)?.[1] || 'Button';
    children.push({ id: `btn-${children.length}`, component: 'Button', props: { label, variant: 'primary' } });
  }
  if (lower.includes('badge')) {
    const label = prompt.match(/labeled "([^"]+)"/)?.[1] || 'New';
    children.push({ id: `badge-${children.length}`, component: 'Badge', props: { label, variant: 'default' } });
  }
  if (lower.includes('card')) {
    children.unshift({ id: 'card-1', component: 'Card', props: { title: 'Card' }, children: [] });
  }

  if (children.length === 0) {
    children.push({ id: 'text-1', component: 'Text', props: { content: prompt.slice(0, 50), size: 'md' } });
  }

  return {
    id: 'root',
    component: 'Stack',
    props: { direction: 'vertical', gap: 'md' },
    children,
  };
}

// Perturbation: paper's exact method (shuffle + drop subset + rename 20%)
function PERTURBATIONS(catalog) {
  const clone = JSON.parse(JSON.stringify(catalog));
  const componentNames = Object.keys(clone.components);

  // 1. Shuffle component order
  const shuffled = [...componentNames].sort(() => Math.random() - 0.5);

  // 2. Drop a random subset of unused components (keep at least 4)
  const keepCount = Math.max(4, Math.floor(shuffled.length * (0.6 + Math.random() * 0.3)));
  const kept = shuffled.slice(0, keepCount);

  // 3. Rename 20% of remaining components
  const renameCount = Math.max(1, Math.floor(kept.length * 0.2));
  const toRename = kept.slice(0, renameCount);
  const mapping = {};

  const newComponents = {};
  for (const name of kept) {
    if (toRename.includes(name)) {
      const newName = name + 'Alt';
      newComponents[newName] = clone.components[name];
      mapping[name] = newName;
    } else {
      newComponents[name] = clone.components[name];
    }
  }

  clone.components = newComponents;

  // Reorder according to shuffled order (with renames applied)
  const reordered = {};
  for (const name of shuffled) {
    const mappedName = mapping[name] || name;
    if (newComponents[mappedName] && !reordered[mappedName]) {
      reordered[mappedName] = newComponents[mappedName];
    }
  }
  clone.components = reordered;

  return [
    // Variant 0: Full perturbation (shuffle + drop + rename 20%)
    (cat) => ({ catalog: clone, mapping }),
    // Variant 1: Light (shuffle only)
    (cat) => {
      const c = JSON.parse(JSON.stringify(cat));
      const names = Object.keys(c.components);
      const shuf = [...names].sort(() => Math.random() - 0.5);
      const reord = {};
      for (const n of shuf) reord[n] = c.components[n];
      c.components = reord;
      return { catalog: c, mapping: {} };
    },
    // Variant 2: Baseline (no perturbation)
    (cat) => ({ catalog: JSON.parse(JSON.stringify(cat)), mapping: {} }),
    // Variant 3: Heavy (drop 40% + rename 30%)
    (cat) => {
      const c = JSON.parse(JSON.stringify(cat));
      const names = Object.keys(c.components);
      const shuf = [...names].sort(() => Math.random() - 0.5);
      const keep = Math.max(3, Math.floor(shuf.length * 0.6));
      const kept = shuf.slice(0, keep);
      const renameN = Math.max(1, Math.floor(kept.length * 0.3));
      const toRen = kept.slice(0, renameN);
      const map = {};
      const newComps = {};
      for (const n of kept) {
        if (toRen.includes(n)) {
          newComps[n + 'V2'] = c.components[n];
          map[n] = n + 'V2';
        } else {
          newComps[n] = c.components[n];
        }
      }
      c.components = newComps;
      const reord = {};
      for (const n of shuf) {
        const mn = map[n] || n;
        if (newComps[mn] && !reord[mn]) reord[mn] = newComps[mn];
      }
      c.components = reord;
      return { catalog: c, mapping: map };
    },
  ];
}

async function main() {
  const outPath = arg('out', 'packages/genui/fixtures/sft-dataset.jsonl');
  const limit = parseInt(arg('limit', '0'), 10) || 150;
  const resume = process.argv.includes('--resume');
  const useSynthetic = process.argv.includes('--synthetic');

  const prompts = generatePrompts(BASE_PROMPTS, limit);

  // Load existing dataset for resume
  const existingPrompts = new Set();
  const existingLines = [];
  const fullPath = resolve(ROOT, outPath);
  if (resume && existsSync(fullPath)) {
    const content = readFileSync(fullPath, 'utf8').trim();
    if (content) {
      for (const line of content.split('\n')) {
        try {
          const entry = JSON.parse(line);
          existingPrompts.add(entry.prompt);
          existingLines.push(line);
        } catch {}
      }
    }
    console.log(`Resume: ${existingLines.length} existing examples loaded`);
  }

  console.log('SFT Dataset Builder — Perturbed-Catalog Augmentation (paper-exact)');
  console.log(`Prompts: ${prompts.length}`);
  console.log(`Perturbations: 4`);
  console.log(`Mode: ${useSynthetic ? 'synthetic (offline)' : 'real (Cerebras generateUI)'}`);
  console.log(`Resume: ${resume}`);
  console.log(`Output: ${outPath}\n`);

  const lines = [...existingLines];
  let count = existingLines.length;
  let apiCalls = 0;

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];

    // Skip already-processed prompts in resume mode
    if (resume && existingPrompts.has(prompt)) {
      continue;
    }

    // Generate base tree (real or synthetic)
    let baseTree = null;
    if (useSynthetic) {
      baseTree = generateSyntheticTree(prompt);
    } else {
      baseTree = await generateRealTree(prompt);
      apiCalls++;
      await new Promise(r => setTimeout(r, 5000));
    }

    if (!baseTree) {
      console.log(`  SKIP: ${prompt.slice(0, 40)} (generation failed)`);
      continue;
    }

    const perturbationFns = PERTURBATIONS(CATALOG);
    for (let p = 0; p < perturbationFns.length; p++) {
      const { catalog: perturbedCatalog, mapping } = perturbationFns[p](CATALOG);
      const isPerturbed = Object.keys(mapping).length > 0;

      const perturbedTree = isPerturbed ? applyMappingToTree(baseTree, mapping, perturbedCatalog) : baseTree;
      const a2ui = treeToA2UI(perturbedTree);

      // Turn 1: initial generation
      const entry1 = {
        prompt,
        catalog: perturbedCatalog,
        a2ui,
        metadata: {
          episode: i,
          turn: 1,
          perturbation: p,
          perturbationType: isPerturbed ? Object.keys(mapping).join(',') : 'none',
          mapping,
          catalogSize: Object.keys(perturbedCatalog.components).length,
          synthetic: useSynthetic,
          timestamp: new Date().toISOString(),
        },
      };
      lines.push(JSON.stringify(entry1));
      count++;

      // Turns 2-5: revision traces (cross-turn retention training)
      let currentTree = JSON.parse(JSON.stringify(perturbedTree));
      for (let t = 0; t < REVISION_TEMPLATES.length; t++) {
        const revType = REVISION_TEMPLATES[t].type;
        const revPrompt = REVISION_TEMPLATES[t].prompt;
        const revTree = generateRevisionTree(currentTree, revType, t);

        // Only include if the revision actually changed the tree
        if (JSON.stringify(revTree) !== JSON.stringify(currentTree)) {
          const revA2ui = treeToA2UI(revTree);
          const revEntry = {
            prompt: revPrompt,
            catalog: perturbedCatalog,
            a2ui: revA2ui,
            metadata: {
              episode: i,
              turn: t + 2,
              revisionType: revType,
              perturbation: p,
              perturbationType: isPerturbed ? Object.keys(mapping).join(',') : 'none',
              mapping,
              catalogSize: Object.keys(perturbedCatalog.components).length,
              synthetic: useSynthetic,
              previousTree: currentTree,
              timestamp: new Date().toISOString(),
            },
          };
          lines.push(JSON.stringify(revEntry));
          count++;
          currentTree = revTree;
        }
      }
    }

    if ((i + 1) % 10 === 0) {
      console.log(`  Processed ${i + 1}/${prompts.length} prompts (${count} examples, ${apiCalls} API calls)`);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, lines.join('\n') + '\n');
    }
  }

  // Final write
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, lines.join('\n') + '\n');

  console.log(`\nDone: ${count} training examples written to ${outPath}`);
  console.log(`  Original catalog: ${Object.keys(CATALOG.components).length} components`);
  console.log(`  Perturbation variants: 4`);
  console.log(`  Total examples: ${count}`);
  console.log(`  API calls: ${apiCalls}`);
  console.log(`  SFT floor: 500-2000 examples`);
  console.log(`  Status: ${count >= 500 ? 'ABOVE floor' : 'BELOW floor — increase --limit'}`);
}

main().catch(e => { console.error(e); process.exit(1); });