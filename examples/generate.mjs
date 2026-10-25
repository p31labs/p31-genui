import { getCatalog } from '/home/p31/production/packages/genui/src/catalog.ts';
import { compile, formatErrorsForRepair } from '/home/p31/production/packages/genui/src/compile.ts';

const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
const MODEL = 'qwen2.5:1.5b';

const catalog = getCatalog();
const componentNames = Object.keys(catalog.components);

const systemPrompt = 'Output ONLY JSON. Components: ' + componentNames.join(',') + '. Shape: {"component":"Name","props":{...},"children":[...]}. Button needs "label".';

async function generate(prompt) {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 120000);
  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: systemPrompt + '\n' + prompt + '\nJSON:',
      stream: false,
      options: { temperature: 0.1, num_predict: 256 },
    }),
    signal: controller.signal,
  });
  clearTimeout(to);
  const data = await res.json();
  return data.response || '';
}

async function main() {
  const prompt = process.argv.slice(2).join(' ') || 'card title Hello';
  console.log('Prompt:', prompt);

  const raw = await generate(prompt);
  console.log('Raw:', raw.slice(0, 300));
  console.log('---');

  let spec;
  try {
    const match = raw.match(/(\{[\s\S]*\})/);
    spec = JSON.parse(match ? match[1] : raw);
  } catch (e) {
    console.log('JSON parse failed:', e.message);
    return;
  }

  const result = compile(spec, catalog);
  console.log('Compile:', result.ok ? 'PASS' : 'FAIL');
  if (!result.ok) {
    console.log('Errors:', formatErrorsForRepair(result.errors));
  } else {
    console.log('Tree:', JSON.stringify(result.tree).slice(0, 300));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
