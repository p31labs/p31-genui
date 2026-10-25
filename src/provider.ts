/**
 * @p31ca/genui — Provider adapter with retry + rate-limit backoff.
 *
 * A provider client is the ONLY place that knows about HTTP, retries and
 * rate limits. The pipeline above it (plan → constrain → compile → repair)
 * sees a ModelFn and nothing else.
 *
 * Why the timeout lives HERE and not around the ModelFn:
 *   A 429 from a metered provider comes with an explicit reset hint
 *   ("budget resets in 44s"). Bounding the whole ModelFn call with a
 *   60s timeout kills the backoff mid-sleep and the run dies. The correct
 *   bound is per-HTTP-attempt (AbortSignal), with a generous outer backstop
 *   for callers that supply a ModelFn with no signal of its own.
 */

export interface ProviderOptions {
  /** Model identifier as the provider knows it. */
  model: string;
  /** API key. Read at call time so a rotated key is picked up without a redeploy. */
  apiKey: string;
  /** Base URL, default Groq's OpenAI-compatible endpoint. */
  baseUrl?: string;
  /** Response format: undefined = free-form, or {type:'json_object'} etc. */
  responseFormat?: object;
  /** Per-HTTP-attempt timeout in ms. */
  attemptTimeoutMs?: number;
  /** Maximum attempts for a rate-limited or transiently failing call. */
  maxAttempts?: number;
  /** Extra body fields (temperature, max_tokens, ...). */
  body?: Record<string, unknown>;
  /** Extra request headers (OpenRouter's attribution pair, for one). */
  headers?: Record<string, string>;
  /** Called when a call is retried (rate limit, transport error). */
  onRetry?: (info: { reason: 'rate_limit' | 'transport'; attempt: number; waitMs: number }) => void;
}

export interface ModelResult {
  text: string;
  tokens: number;
  /**
   * The model the provider says it SERVED.
   *
   * A router (`kilo-auto/free`, `openrouter/free`) picks a model per
   * request, so the model asked for is not the model that answered. An arm
   * that reports the requested model would be reporting a fiction; this is
   * what the harness records instead.
   */
  servedModel?: string;
}

export class RateLimitError extends Error {
  transient = true;
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class ProviderRequestError extends Error {
  transient = false;
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProviderRequestError';
    this.status = status;
  }
}

const DEFAULT_ATTEMPT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 6;

/**
 * How many attempts a 429 gets when the provider says NOTHING about when
 * the window opens.
 *
 * A blind retry is a guess. Ten of them cost 2.5 minutes per prompt and
 * all ten land in the same exhausted window (measured 2026-10-22: Kilo
 * answers a spent budget with `{"error":"Rate limit exceeded",
 * "message":"Model usage limit reached. Please try again later."}` — no
 * hint, no header, no reset time). Three is enough to ride out a transient
 * per-minute limit and short enough that a budget-capped arm does not
 * spend its whole wall clock being told no.
 */
export const MAX_ATTEMPTS_NO_HINT = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Parse a rate-limit reset hint to milliseconds.
 *
 * Handles the compound forms Groq actually sends: "44.28s", "7m12s",
 * "1h1m55.2s", "1ms". A compound hint is the DAILY budget saying when it
 * frees ("x-ratelimit-reset-requests: 7h29m16.8s"), so reading it wrong
 * means retrying into a window that will not open for hours.
 *
 * It also handles the ABSOLUTE form another provider sends: OpenRouter
 * answers a daily-cap 429 with `x-ratelimit-reset: 1792627200000` — an
 * epoch timestamp in milliseconds, not a duration. Read as a duration that
 * number is 1.79e15 ms (about 57 years), so it has to be converted to the
 * DELTA from now, and a delta that is still in the past must be 0, not a
 * negative wait.
 */
export function parseReset(header: string | null, now: number = Date.now()): number {
  if (!header) return 0;
  const text = String(header).trim();
  // Absolute epoch: a bare integer with no unit.
  if (/^\d{10,}$/.test(text)) {
    const raw = Number(text);
    // >= 1e11 is milliseconds; 1e9..1e11 is seconds.
    const epochMs = raw >= 1e11 ? raw : raw * 1000;
    return Math.max(0, epochMs - now);
  }
  const simple = text.match(/^([\d.]+)\s*(ms|s|m|h)?$/i);
  if (simple) {
    const n = parseFloat(simple[1]);
    switch ((simple[2] || 's').toLowerCase()) {
      case 'ms': return n;
      case 'm': return n * 60_000;
      case 'h': return n * 3_600_000;
      default: return n * 1000;
    }
  }
  // Compound: 1h1m55.2s / 7m12s / 29m
  const compound = text.match(/(\d+(?:\.\d+)?)\s*(h|m|s|ms)/gi);
  if (!compound) return 0;
  let total = 0;
  for (const part of compound) {
    const m = /^(\d+(?:\.\d+)?)\s*(h|m|s|ms)$/i.exec(part);
    if (!m) continue;
    const n = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === 'h') total += n * 3_600_000;
    else if (unit === 'm') total += n * 60_000;
    else if (unit === 'ms') total += n;
    else total += n * 1000;
  }
  return total;
}

/**
 * The retry hint Groq puts in a 429 BODY: "Please try again in 40.6s".
 *
 * This is the only place the DAILY token cap (tokens per day) shows up — the
 * x-ratelimit headers describe the minute window and stay green while the
 * daily cap is spent, so a backoff that trusts the headers alone retries into
 * a wall (measured 2026-10-21: 8 attempts in 16s, every one of them 429).
 */
export function parseRetryHint(body: string): number {
  const m = /try again in\s+([\d.]+)\s*(ms|s|m|h)?/i.exec(body ?? '');
  if (!m) return 0;
  const n = parseFloat(m[1]);
  switch ((m[2] || 's').toLowerCase()) {
    case 'ms': return n;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    default: return n * 1000;
  }
}

/** Read a 429 body (once) and pull the retry hint out of it. */
async function readRetryHint(res: Response): Promise<number> {
  try {
    const text = await res.text();
    return parseRetryHint(text);
  } catch {
    return 0;
  }
}

/**
 * The longest a 429 wait may be. Past this the window is not a retry
 * window — it is a spent daily budget (measured 2026-10-22: OpenRouter's
 * free tier allows 50 requests/day and answers with a reset timestamp hours
 * away).
 */
export const RATE_LIMIT_CEILING_MS = 240_000;

/**
 * How long to wait after a 429.
 *
 * Pure, so the rule can be tested without an HTTP round trip:
 *   - the BODY hint wins when there is one: it names the limit that is
 *     actually exhausted (the daily token cap, which no header describes)
 *   - otherwise the longest header hint wins (Groq's x-ratelimit-reset-*,
 *     OpenRouter's x-ratelimit-reset, or a standard Retry-After)
 *   - with NO hint at all the wait is 15s: a blind retry needs a plausible
 *     window, not the 2s that burned eight attempts inside one exhausted
 *     window (the bug this replaced)
 *   - the ceiling is 240s: a DAILY cap frees tokens slowly (measured: about
 *     500 tokens/minute), so a 60s ceiling never catches up with a request
 *     that needs a couple of thousand tokens. The caller's outer backstop
 *     bounds the total.
 */
export function rateLimitWaitMs(hints: {
  resetTokensMs?: number;
  resetRequestsMs?: number;
  resetGenericMs?: number;
  retryAfterMs?: number;
  bodyHintMs?: number;
}): number {
  const {
    resetTokensMs = 0,
    resetRequestsMs = 0,
    resetGenericMs = 0,
    retryAfterMs = 0,
    bodyHintMs = 0,
  } = hints;
  const longest = Math.max(
    resetTokensMs,
    resetRequestsMs,
    resetGenericMs,
    retryAfterMs,
    bodyHintMs,
  );
  // No hint at all: we do not know the window, so wait a plausible one.
  const floor = longest > 0 ? 5000 : 15_000;
  return Math.min(Math.max(longest, floor), RATE_LIMIT_CEILING_MS);
}

/**
 * The messages array for a chat-completions call.
 *
 * A SYSTEM message, when one is given, is prepended: the provider puts the
 * system role first by contract, and a provider that refuses a system role
 * (some free routes do) fails the call, which the caller's fallback chain
 * handles. The split is what the contract-role A/B measures: the same words,
 * in a different role.
 */
export function buildMessages(
  prompt: string,
  system?: string,
): { role: string; content: string }[] {
  if (system && system.trim().length > 0) {
    return [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ];
  }
  return [{ role: 'user', content: prompt }];
}

/**
 * Build a ModelFn backed by a chat-completions endpoint.
 */
export function createProvider(options: ProviderOptions): (prompt: string, opts?: { format?: object; pin?: string; system?: string }) => Promise<ModelResult> {
  const baseUrl = options.baseUrl ?? 'https://api.groq.com/openai/v1';
  const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  return async function call(prompt: string, opts: { format?: object; pin?: string; system?: string } = {}): Promise<ModelResult> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: buildMessages(prompt, opts.system),
      ...(options.body ?? {}),
    };

    // The PINNED model for this call. A router (kilo-auto/free,
    // openrouter/free) picks a model per request, so the repair step asks
    // for the model that SERVED the first emission — otherwise the repair
    // can land on a different model with a different notion of the
    // catalog. The pin is best-effort: a provider that refuses it fails
    // the call, and the caller's fallback chain takes over.
    if (opts.pin) body.model = opts.pin;

    // The response format comes from the CALL SITE, not the provider config.
    // The plan step is free-form by design ("reason free, constrain late");
    // forcing json_object onto it makes the provider reject the request.
    const format = opts.format ?? options.responseFormat;
    if (format) body.response_format = format;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Read the key at call time, not at construction time.
            Authorization: `Bearer ${options.apiKey}`,
            // Provider-specific extras (OpenRouter's attribution pair).
            ...(options.headers ?? {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(attemptTimeoutMs),
          headersTimeout: 600_000,
        });
      } catch (e: any) {
        console.error('TRANSPORT ERROR:', e?.message ?? e, e?.code, e?.cause);
        lastError = new Error(`provider transport error: ${e?.message ?? e}`);
        if (attempt === maxAttempts - 1) throw lastError;
        const waitMs = Math.min(2000 * (attempt + 1), 10_000);
        options.onRetry?.({ reason: 'transport', attempt, waitMs });
        await sleep(waitMs);
        continue;
      }

      if (res.status === 429) {
        const resetTokens = parseReset(res.headers.get('x-ratelimit-reset-tokens'));
        const resetRequests = parseReset(res.headers.get('x-ratelimit-reset-requests'));
        // OpenRouter's daily cap answers with the GENERIC header: an epoch
        // timestamp, not a duration. Read as a duration it is nonsense, so
        // parseReset converts it to a delta.
        const resetGeneric = parseReset(res.headers.get('x-ratelimit-reset'));
        const retryAfter = parseReset(res.headers.get('retry-after'));
        // The headers describe the MINUTE window only. Groq's DAILY cap
        // (tokens per day) is a SEPARATE limit and it is NOT in the headers:
        // with the daily cap exhausted, the headers still read "8000 tokens
        // remaining" and the body carries the real hint ("Please try again in
        // 40.6s ... on tokens per day (TPD): Limit 200000, Used 199685").
        // Reading only the headers made the backoff retry every 2s until it
        // gave up — 8 attempts in 16 seconds, all inside the same exhausted
        // window, and the prompt died for no reason. The body's hint is the
        // one that matters, so it wins.
        const bodyHint = await readRetryHint(res);
        const rawHint = Math.max(
          resetTokens,
          resetRequests,
          resetGeneric,
          retryAfter,
          bodyHint,
        );
        const waitMs = rateLimitWaitMs({
          resetTokensMs: resetTokens,
          resetRequestsMs: resetRequests,
          resetGenericMs: resetGeneric,
          retryAfterMs: retryAfter,
          bodyHintMs: bodyHint,
        });
        // A window further away than the ceiling is not a retry window: it
        // is a spent daily budget (measured 2026-10-22: OpenRouter's
        // free tier allows 50 requests/day and answers with a reset
        // timestamp hours away). Retrying into it burns wall clock and
        // still fails, so the call FAILS FAST and says when the window
        // opens — the arm records it as a provider error and reports
        // "reached the model" honestly.
        if (rawHint > RATE_LIMIT_CEILING_MS) {
          throw new RateLimitError(
            `429 rate limit: the provider's window opens in ${Math.round(rawHint / 60000)} min ` +
              `(further out than the ${RATE_LIMIT_CEILING_MS / 1000}s retry ceiling) — ` +
              'the budget for this window is spent',
          );
        }
        lastError = new RateLimitError('429 rate limit');
        // With NO hint the provider said nothing about when the window
        // opens, so the retry is a guess: three of them ride out a
        // transient limit, ten just burn the wall clock (see
        // MAX_ATTEMPTS_NO_HINT).
        const attemptLimit =
          rawHint > 0 ? maxAttempts : Math.min(maxAttempts, MAX_ATTEMPTS_NO_HINT);
        if (attempt >= attemptLimit - 1) throw lastError;
        options.onRetry?.({ reason: 'rate_limit', attempt, waitMs });
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new ProviderRequestError(
          `provider HTTP ${res.status}: ${text.slice(0, 300)}`,
          res.status
        );
      }

      const data = await res.json();
      // Some gateways answer 200 with an error object in the body: Kilo's
      // free route does exactly that when the upstream model rejects the
      // request mid-stream ("Minimax midstream error: invalid params,
      // Mismatch type string with value array"). Treating that as a success
      // would record an empty generation as a model failure of the pipeline.
      if (data?.error) {
        const message =
          typeof data.error === 'string'
            ? data.error
            : (data.error?.message ?? JSON.stringify(data.error));
        throw new ProviderRequestError(
          `provider returned an error body with HTTP 200: ${String(message).slice(0, 300)}`,
          200
        );
      }
      const tokens = data?.usage?.total_tokens ?? 0;
      const text = data?.choices?.[0]?.message?.content ?? '';
      const servedModel = typeof data?.model === 'string' ? data.model : undefined;
      // An EMPTY completion is a provider failure, not an empty generation.
      // One of the free models answers HTTP 200 with an empty body (the
      // pool is volatile — see src/capability-cache.ts); scoring that as
      // "the pipeline produced nothing" would blame the pipeline for a
      // provider's silence, and the capability cache needs the signal to
      // demote the model.
      if (!text || !text.trim()) {
        throw new ProviderRequestError(
          `provider returned an empty completion (model ${servedModel ?? 'unknown'})`,
          200,
        );
      }
      return { text, tokens, servedModel };
    }

    throw lastError ?? new Error('provider exhausted attempts');
  };
}
