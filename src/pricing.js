// Estimating cost from token counts. The transcript stores tokens only — never
// cost — so we apply a bundled price table. Cache rates derive from the input
// price via standard Anthropic multipliers.
//
// NOTE: on a Pro/Max subscription you don't pay per token; treat this as the
// "estimated equivalent API cost".

import { readFileSync } from 'node:fs';

const table = JSON.parse(
  readFileSync(new URL('../models.json', import.meta.url), 'utf8'),
);
const MULT = table.cacheMultipliers;
const PER_TOKEN = 1 / 1_000_000;

// Find the price row for a model id (exact, then a forgiving prefix match).
export function rateFor(model) {
  if (table.models[model]) return table.models[model];
  for (const [name, rate] of Object.entries(table.models)) {
    if (model && (model.startsWith(name) || name.startsWith(model))) return rate;
  }
  return null;
}

// Cost (USD) for one model bucket. Returns per-component costs + a `known` flag.
export function costFor(model, bucket) {
  const rate = rateFor(model);
  if (!rate) {
    return { known: false, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };
  }
  const input = bucket.input * rate.input * PER_TOKEN;
  const output = bucket.output * rate.output * PER_TOKEN;
  const cacheWrite =
    bucket.cacheWrite5m * rate.input * MULT.write5m * PER_TOKEN +
    bucket.cacheWrite1h * rate.input * MULT.write1h * PER_TOKEN;
  const cacheRead = bucket.cacheRead * rate.input * MULT.read * PER_TOKEN;
  return {
    known: true,
    input,
    output,
    cacheWrite,
    cacheRead,
    total: input + output + cacheWrite + cacheRead,
  };
}
