import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { costFor, rateFor } from '../src/pricing.js';

const M = 1_000_000;
const bucket = (model, tier, fields) => ({
  model, tier, input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, webSearch: 0, ...fields,
});
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('cost components by hand: Opus 5.5 with its own cache-read rate, plus web search', () => {
  const c = costFor('claude-opus-5-5', bucket('claude-opus-5-5', '', {
    input: M, output: M, cacheWrite5m: M, cacheWrite1h: M, cacheRead: M, webSearch: 1000,
  }));
  assert.equal(c.known, true);
  close(c.input, 4);
  close(c.output, 20);
  close(c.cacheWrite, 4 * 1.25 + 4 * 2);
  close(c.cacheRead, 4 * 0.05);
  close(c.webSearch, 10);
  close(c.total, 4 + 20 + 13 + 0.2 + 10);
});

test('fast and long-context tiers use their own rates', () => {
  close(costFor('k', bucket('claude-opus-4-8', 'fast', { output: M })).total, 50);
  close(costFor('k', bucket('claude-opus-5-5', 'fast', { input: M })).total, 8);
  close(costFor('k', bucket('claude-haiku-5-5', 'long', { input: M, output: M })).total, 0.5 + 2.5);
  assert.equal(costFor('k', bucket('claude-sonnet-5-5', 'fast', { output: M })).known, false); // no fast rate
});

test('model ids: exact, date suffix, hosted-provider spellings; never a near miss', () => {
  const opus41 = rateFor('claude-opus-4-1');
  for (const id of [
    'claude-opus-4-1-20250805',
    'claude-opus-4-1@20250805',
    'anthropic.claude-opus-4-1-20250805-v1:0',
    'us.anthropic.claude-opus-4-1-20250805-v1:0',
    'global.anthropic.claude-opus-4-1-20250805-v1',
  ]) {
    assert.equal(rateFor(id), opus41, id);
  }
  assert.equal(rateFor('claude-opus-5-5[1m]'), rateFor('claude-opus-5-5'));
  assert.equal(rateFor('claude-sonnet-9'), null);
  assert.equal(rateFor('claude-sonnet-5-5-preview'), null);
  assert.equal(rateFor(undefined), null);
});

test('models.json rows are well-formed', () => {
  const table = JSON.parse(readFileSync(new URL('../models.json', import.meta.url), 'utf8'));
  assert.match(table._ratesAsOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(table.webSearchPer1000 > 0);
  const rates = (r) => typeof r?.input === 'number' && r.input > 0 && typeof r.output === 'number' && r.output > 0;
  for (const [id, row] of Object.entries(table.models)) {
    assert.match(id, /^claude-[a-z0-9-]+$/, id);
    assert.ok(rates(row), `${id}: input/output`);
    if (row.fast) assert.ok(rates(row.fast), `${id}: fast`);
    if (row.longContext) assert.ok(rates(row.longContext) && row.longContext.above > 0, `${id}: longContext`);
    for (const k of Object.keys(row.cacheMultipliers ?? {})) assert.ok(['read', 'write5m', 'write1h'].includes(k), `${id}: ${k}`);
  }
});
