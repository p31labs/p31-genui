// Field-ordering probe for Structure Tax hypothesis
// Tests whether {props, children, component, id} ordering improves results
// over current {component, props, children, id} ordering.

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// Configuration
const PROMPT_LIST = [
  'L4', 'L8', 'L9', 'L12', 'L15', 'L35',  // 6 hard prompts
  'L1', 'L2', 'L3', 'L5'                      // 4 easy prompts
];

const PROVIDER = 'kilo';
const MODEL = 'qwen3.8-27b';
const HERE = resolve(import.meta.dirname);
const PROBE_OUT = resolve(HERE, '../fixtures/live-results-probe.json');

function main() {
  console.log('=== Field-Ordering Probe ===');
  console.log('Testing: 6 hard prompts + 4 easy prompts = 10 total');
  console.log('Schema: strict mode with REORDERED properties (component last)');
  console.log('Provider: Kilo (anonymous access via opencode auth)');
  console.log('Model: qwen3.8-27b');
  console.log('Protocol: --contract-role=user (default)');
  console.log('');

  // Build a custom prompt file with only our test prompts
  const allPrompts = JSON.parse(readFileSync(resolve(HERE, '../fixtures/live-prompts.json'), 'utf8'));
  const testPrompts = allPrompts.filter(p => PROMPT_LIST.includes(p.id));
  const tempPromptFile = resolve(HERE, '../fixtures/probe-prompts.json');
  writeFileSync(tempPromptFile, JSON.stringify(testPrompts, null, 2));
  console.log('Created probe prompt file with', testPrompts.length, 'prompts');
  
  // Run the evaluation with the reordered schema already in effect
  console.log('\nRunning eval-live.mjs with strict mode and reordered schema...');
  
  const result = spawnSync('node', [
    'scripts/eval-live.mjs',
    '--mode=strict',
    `--provider=${PROVIDER}`,
    `--model=${MODEL}`,
    `--base-url=https://api.kilo.ai/api/gateway/v1`,
    `--key-env=KILO_API_KEY`,
    '--prop-contract',
    '--no-node-shape',
    `--prompts=${tempPromptFile}`,
    `--out=${PROBE_OUT}`,
    '--max-prompts=10'
  ], { cwd: HERE, timeout: 300000, encoding: 'utf8' });
  
  console.log('Exit code:', result.status);
  if (result.stdout) console.log('\n=== OUTPUT ===\n', result.stdout);
  if (result.stderr) console.error('\n=== STDERR ===\n', result.stderr);
  
  // If successful, show summary
  if (result.status === 0) {
    try {
      const results = JSON.parse(readFileSync(PROBE_OUT, 'utf8'));
      const compiled = (results.compilePassRate * 100).toFixed(1);
      const requirementRate = (results.requirementPassRate * 100).toFixed(1);
      const firstPass = (results.firstPassRate * 100).toFixed(1);
      console.log('\n=== PROBE RESULTS ===');
      console.log(`First-pass rate: ${firstPass}%`);
      console.log(`Compile pass rate: ${compiled}%`);
      console.log(`Requirement pass rate: ${requirementRate}%`);
      console.log('Served models:', JSON.stringify(results.servedModels, null, 2));
    } catch (e) {
      console.error('Could not parse results:', e.message);
    }
  } else {
    console.error('Probe failed to run successfully.');
    console.error('You may need to check if the schema compiles and if the provider accepts the request.');
  }
}

main();