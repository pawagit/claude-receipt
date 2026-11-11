// Estimating cost from token counts. The transcript stores tokens only — never
// cost — so we apply a bundled price table. Cache rates derive from the input
// price via Anthropic's multipliers, which a model may override (Opus 5.5,
// Sonnet 5.5 and Fable 5.1/5.2 read cache cheaper than the standard 0.1x).
//
// NOTE: on a Pro/Max subscription you don't pay per token; treat this as the
// "estimated equivalent API cost".

import { readFileSync } from 'node:fs';

const table = JSON.parse(
  readFileSync(new URL('../models.json', import.meta.url), 'utf8'),
);
const PER_TOKEN = 1 / 1_000_000;
const DATE_SUFFIX = /-\d{8}$/;

// The plain model id behind a hosted-provider spelling: Bedrock
// (us.anthropic.claude-opus-4-1-20250805-v1:0), Vertex (claude-opus-4-1@20250805)
// and a context-window tag (claude-opus-5-5[1m]).
function plainId(model) {
  return model
    .replace(/^(?:[a-z]+\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/\[\w+\]$/, '');
}

// Find the price row for a model id: exact, or after dropping a date suffix
// (claude-haiku-4-5-20251001). No looser prefix match: claude-sonnet-5-5 must
// never borrow claude-sonnet-5's row, so an unknown model stays unpriced.
export function rateFor(model) {
  if (!model) return null;
  const id = plainId(model);
  return table.models[id] ?? table.models[id.replace(DATE_SUFFIX, '')] ?? null;
}

// The price tier of one API response: 'fast' (fast mode), 'long' (prompt above
// the model's long-context threshold) or '' (standard).
export function tierFor(model, usage) {
  if (usage.speed === 'fast') return 'fast';
  const above = rateFor(model)?.longContext?.above;
  if (above != null) {
    const prompt =
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0);
    if (prompt > above) return 'long';
  }
  return '';
}

// Input/output prices and cache multipliers for one model and tier, or null.
function pricesFor(model, tier) {
  const rate = rateFor(model);
  if (!rate) return null;
  const prices = tier === 'fast' ? rate.fast : tier === 'long' ? rate.longContext : rate;
  if (!prices) return null;
  return {
    input: prices.input,
    output: prices.output,
    mult: { ...table.cacheMultipliers, ...rate.cacheMultipliers },
  };
}

// Cost (USD) for one model bucket. Returns per-component costs + a `known` flag.
// Web searches are billed per request on top of tokens (web fetches are free).
export function costFor(model, bucket) {
  const p = pricesFor(bucket.model ?? model, bucket.tier ?? '');
  if (!p) {
    return { known: false, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0, total: 0 };
  }
  const input = bucket.input * p.input * PER_TOKEN;
  const output = bucket.output * p.output * PER_TOKEN;
  const cacheWrite =
    bucket.cacheWrite5m * p.input * p.mult.write5m * PER_TOKEN +
    bucket.cacheWrite1h * p.input * p.mult.write1h * PER_TOKEN;
  const cacheRead = bucket.cacheRead * p.input * p.mult.read * PER_TOKEN;
  const webSearch = ((bucket.webSearch || 0) * (table.webSearchPer1000 || 0)) / 1000;
  return {
    known: true,
    input,
    output,
    cacheWrite,
    cacheRead,
    webSearch,
    total: input + output + cacheWrite + cacheRead + webSearch,
  };
}
