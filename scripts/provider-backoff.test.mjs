#!/usr/bin/env node
/**
 * provider-backoff.test.mjs — the rate-limit backoff contract.
 *
 * The rule this pins, measured 2026-10-21: Groq's x-ratelimit headers
 * describe the MINUTE window only. With the model's DAILY token cap
 * (tokens per day) exhausted, the headers still read "8000 tokens
 * remaining" and the body carries the real hint ("Please try again in
 * 40.6s ... on tokens per day (TPD): Limit 200000, Used 199685"). The old
 * backoff trusted the headers, retried every 2s, burned 8 attempts in 16
 * seconds and killed the prompt — 38 of 50 prompts in the strict arm died
 * that way.
 *
 * The contract: the LONGEST hint wins, the floor is 5s (never retry inside
 * the same exhausted window), the ceiling is 120s.
 */
import {
  parseReset,
  parseRetryHint,
  rateLimitWaitMs,
  MAX_ATTEMPTS_NO_HINT,
} from '../src/provider.ts';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`);
};

// --- header hints -------------------------------------------------------
check(parseReset('44.28s') === 44_280, 'parseReset reads seconds');
check(parseReset('7m12s') === 432_000, 'parseReset reads a compound minute+second hint');
check(parseReset('1h1m55.2s') === 3_715_200, 'parseReset reads a compound hour+minute+second hint');
check(parseReset('7h29m16.8s') === 26_956_800, 'parseReset reads the daily request reset');
check(parseReset(null) === 0, 'parseReset on a missing header is 0');
check(parseReset('1ms') === 1, 'parseReset reads milliseconds');

// --- the body hint (the DAILY cap) -------------------------------------
const tpdBody =
  'Rate limit reached for model `openai/gpt-oss-20b` in organization `org_x` service tier `on_demand` ' +
  'on tokens per day (TPD): Limit 200000, Used 199685, Requested 409. Please try again in 40.608s.';
check(Math.abs(parseRetryHint(tpdBody) - 40_608) < 1, 'parseRetryHint reads the body hint', `${parseRetryHint(tpdBody)}ms`);
check(parseRetryHint('{"error":{"message":"nope"}}') === 0, 'parseRetryHint on a body without a hint is 0');

// --- the wait rule ------------------------------------------------------
check(
  rateLimitWaitMs({ resetTokensMs: 1, resetRequestsMs: 0, bodyHintMs: 40_608 }) === 40_608,
  'the body hint beats a green minute header',
);
check(
  rateLimitWaitMs({ resetTokensMs: 0, resetRequestsMs: 0, bodyHintMs: 0 }) === 15_000,
  'with NO hint at all the wait is 15s — a blind retry needs a plausible window, not 2s',
);
check(
  rateLimitWaitMs({ resetTokensMs: 30_000, resetRequestsMs: 0, bodyHintMs: 0 }) === 30_000,
  'a real header hint is honoured',
);
check(
  rateLimitWaitMs({ resetTokensMs: 0, resetRequestsMs: 0, bodyHintMs: 0, retryAfterMs: 45_000 }) === 45_000,
  'a standard Retry-After header is honoured (OpenRouter/Kilo send one)',
);
check(
  rateLimitWaitMs({ resetTokensMs: 0, resetRequestsMs: 0, bodyHintMs: 0, retryAfterMs: 1_000 }) === 5_000,
  'a hint shorter than the floor is raised to 5s',
);
check(
  rateLimitWaitMs({ resetTokensMs: 0, resetRequestsMs: 0, bodyHintMs: 900_000 }) === 240_000,
  'the ceiling is 240s — a daily cap frees tokens slowly, and the caller\'s outer backstop bounds the total',
);

// --- the ABSOLUTE reset form (measured 2026-10-22) ----------------------
// OpenRouter's free tier answers a spent daily budget with an EPOCH
// timestamp, not a duration:
//   x-ratelimit-reset: 1792627200000
//   {"error":{"message":"Rate limit exceeded: free-models-per-day.
//     Add 10 credits to unlock 1000 free model requests per day", ...}}
// Read as a duration, 1792627200000 is ~57 years — a nonsense wait that
// the ceiling would silently cap, so the arm would retry into a wall for
// 40 minutes and still fail.
const now = 1_792_627_200_000; // the "now" the fake reset is relative to
check(
  parseReset('1792627200000', now) === 0,
  'an epoch-ms reset in the past is 0, not a negative wait',
);
check(
  parseReset(String(now + 3_600_000), now) === 3_600_000,
  'an epoch-ms reset is converted to the DELTA from now',
);
check(
  parseReset(String(now + 7_200_000), now) === 7_200_000,
  'an epoch-ms reset two hours out is two hours',
);
check(
  parseReset('1792627200', now) === 0,
  'an epoch-SECOND reset is read as seconds, not milliseconds',
);
check(
  rateLimitWaitMs({ resetGenericMs: 7_200_000, bodyHintMs: 0 }) === 240_000,
  'the generic x-ratelimit-reset hint is capped like every other hint',
);

// --- a blind 429 is a guess, not a retry plan ----------------------------
// Measured 2026-10-22: Kilo answers a spent budget with
//   {"error":"Rate limit exceeded","error_type":"rate_limit_exceeded",
//    "message":"Model usage limit reached. Please try again later."}
// — no hint, no header, no reset time. Ten blind attempts cost 2.5
// minutes per prompt and all ten land in the same exhausted window.
check(MAX_ATTEMPTS_NO_HINT === 3, 'a hintless 429 gets 3 attempts, not 10');

if (failures > 0) {
  console.log(`\nprovider backoff contract: FAIL — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('\nprovider backoff contract: PASS');
