/**
 * @p31ca/genui — the PROVIDER registry.
 *
 * The fidelity harness must not be welded to one vendor. Measured
 * 2026-10-21, the three providers an account can actually use:
 *
 *   groq        api.groq.com/openai/v1      key in the env
 *               A DAILY per-model token cap (TPD 200 000) that frees ~500
 *               tokens/minute. One 50-prompt arm costs ~150 000 tokens, so
 *               an arm can be larger than a day's allowance.
 *   openrouter  openrouter.ai/api/v1        key in the env
 *               Free models answer with cost 0. The free pool is small and
 *               each model enforces `response_format` differently: some
 *               accept the strict schema, some reject it (400), some ignore
 *               it and answer free-form. Free accounts also carry a
 *               requests-per-day budget, so arm size is a budget question.
 *   kilo        api.kilo.ai/api/gateway/v1  key in opencode's auth store
 *               The same free pool behind a router (`kilo-auto/free` picks a
 *               model per request). A ROUTER means the model that answers is
 *               not the model that was asked for — the harness records the
 *               model the provider says it SERVED, so an arm can never claim
 *               a model it did not run on.
 *
 * A key never appears in a command line: it is read from the environment
 * (`keyEnv`) or from a key FILE by path+field (`keyJson`). The harness
 * prints the key's NAME, never its value.
 */

export interface ProviderSpec {
  /** The name used on the command line: --provider=<id>. */
  id: string;
  /** Human label for the report. */
  label: string;
  /** OpenAI-compatible base URL (the adapter appends /chat/completions). */
  baseUrl: string;
  /** Environment variable that holds the API key. */
  keyEnv: string;
  /**
   * A key file: path + the field inside it. Used where the key does not
   * live in the estate's env (opencode keeps its own providers' keys in
   * its auth store).
   */
  keyJson?: { file: string; field: string };
  /** Extra request headers (OpenRouter asks for an attribution pair). */
  headers?: Record<string, string>;
  /**
   * Extra request-body fields, merged under the caller's own body.
   *
   * OpenRouter's `provider.require_parameters: true` is the important
   * one: without it the router may hand the request to an upstream that
   * IGNORES `response_format`, which is how a "strict" arm silently
   * measures an unconstrained model.
   */
  body?: Record<string, unknown>;
  /**
   * The provider's model id is a ROUTER: it picks a model per request, so
   * the model that answers is not the one that was asked for. The harness
   * records the SERVED model on every response, so the router's variance
   * becomes per-model data instead of noise, and the repair step pins the
   * model that served the first emission.
   */
  routed?: boolean;
  /** The router's model id (the default for a routed provider). */
  defaultModel?: string;
  /** What the provider's limits are, for the report's budget note. */
  budgetNote: string;
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  groq: {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    budgetNote:
      'daily per-model token cap (TPD 200 000; ~500 tokens/minute of refill) + 8 000 tokens/minute',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    headers: {
      'HTTP-Referer': 'https://p31labs.org',
      'X-Title': 'P31 genui fidelity harness',
    },
    body: {
      // Keep the router away from the upstreams that ignore
      // `response_format` — a strict arm must not be served by a model
      // that does not implement the strict decoder.
      provider: { require_parameters: true },
    },
    budgetNote:
      'free models (cost 0) with a per-account requests-per-day budget (MEASURED 2026-10-21: 50/day with no credits; 10 credits buys 1000/day); 20 requests/minute per model',
  },
  'openrouter-free': {
    id: 'openrouter-free',
    label: 'OpenRouter (free router)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    headers: {
      'HTTP-Referer': 'https://p31labs.org',
      'X-Title': 'P31 genui fidelity harness',
    },
    body: {
      provider: { require_parameters: true },
    },
    routed: true,
    defaultModel: 'openrouter/free',
    budgetNote:
      'the free ROUTER picks a model per request (that is a filter, not a guarantee); 50 requests/day with no credits',
  },
  kilo: {
    id: 'kilo',
    label: 'Kilo',
    baseUrl: 'https://api.kilo.ai/api/gateway/v1',
    keyEnv: 'KILO_API_KEY',
    keyJson: { file: '/home/p31/.local/share/opencode/auth.json', field: 'kilo.key' },
    budgetNote: 'free model pool behind a router; the model that answers may differ from the one asked for',
  },
  'kilo-free': {
    id: 'kilo-free',
    label: 'Kilo (free router)',
    baseUrl: 'https://api.kilo.ai/api/gateway/v1',
    keyEnv: 'KILO_API_KEY',
    keyJson: { file: '/home/p31/.local/share/opencode/auth.json', field: 'kilo.key' },
    routed: true,
    defaultModel: 'kilo-auto/free',
    budgetNote:
      'the free ROUTER picks a model per request; the served model is recorded on every response and the repair step pins it',
  },
  cerebras: {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyEnv: 'CEREBRAS_API_KEY',
    body: {},
    budgetNote:
      'free trial: 14,400 req/day, 1M tokens/day, 30 RPM, 60K TPM; qwen-3.8-27b has 64K context free, 32K max output; strict JSON schema enforced via constrained decoding',
  },
  local: {
    id: 'local',
    label: 'Local (llama.cpp)',
    baseUrl: 'http://localhost:8090/v1',
    keyEnv: 'LOCAL_API_KEY',
    body: { chat_template_kwargs: { enable_thinking: false } },
    budgetNote:
      'local inference on Intel Iris Xe via llama.cpp SYCL/Vulkan; ~3-20 t/s; no rate limits; sovereign path',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (fallback)',
    baseUrl: 'http://localhost:11434/v1',
    keyEnv: 'LOCAL_API_KEY',
    body: { chat_template_kwargs: { enable_thinking: false } },
    budgetNote:
      'Ollama fallback on CPU; ~1.4 t/s for qwen3.5 on Iris Xe; use only if llama.cpp unavailable',
  },
};

/** The provider spec, or a clear error naming the ones that exist. */
export function getProvider(id: string): ProviderSpec {
  const spec = PROVIDERS[id];
  if (!spec) {
    throw new Error(
      `unknown provider "${id}" — known providers: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return spec;
}

