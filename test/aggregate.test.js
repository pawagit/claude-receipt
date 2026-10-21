import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregate, mergeAggregates, activeTime, extractMeta } from '../src/aggregate.js';
import { assistant, user } from './helpers.js';

test('rows of one response count once', () => {
  const usage = { input_tokens: 5, output_tokens: 300, cache_read_input_tokens: 1000 };
  const rows = [1, 2, 3].map(() => assistant({ id: 'msg_a', requestId: 'req_a', usage }));
  const { models, assistantResponses } = aggregate(rows);
  const b = models['claude-opus-5-5'];
  assert.equal(assistantResponses, 1);
  assert.deepEqual([b.responses, b.input, b.output, b.cacheRead], [1, 5, 300, 1000]);
});

test('mid-stream snapshot rows lose to the final row, whatever the order', () => {
  const row = (output_tokens, stop) =>
    assistant({ id: 'msg_s', requestId: 'req_s', usage: { input_tokens: 2, output_tokens }, stop });
  for (const rows of [
    [row(8, null), row(8, null), row(1500, 'tool_use')],
    [row(1500, 'tool_use'), row(8, null)],
  ]) {
    const b = aggregate(rows).models['claude-opus-5-5'];
    assert.equal(b.output, 1500);
    assert.equal(b.input, 2);
  }
});

test('synthetic rows and rows without usage are not billed', () => {
  const rows = [
    assistant({ model: '<synthetic>', usage: { output_tokens: 50 } }),
    { type: 'assistant', message: { id: 'x', model: 'claude-opus-5-5', content: [] } },
  ];
  const agg = aggregate(rows);
  assert.deepEqual(agg.models, {});
  assert.equal(agg.assistantResponses, 0);
});

test('fast and long-context responses get their own bucket', () => {
  const agg = aggregate([
    assistant({ usage: { output_tokens: 10 } }),
    assistant({ usage: { output_tokens: 20, speed: 'fast' } }),
    assistant({ model: 'claude-haiku-5-5', usage: { input_tokens: 100_001, output_tokens: 1 } }),
    assistant({ model: 'claude-haiku-5-5', usage: { input_tokens: 100_000, output_tokens: 1 } }),
  ]);
  assert.deepEqual(Object.keys(agg.models).sort(), [
    'claude-haiku-5-5',
    'claude-haiku-5-5 · long context',
    'claude-opus-5-5',
    'claude-opus-5-5 · fast',
  ]);
  assert.equal(agg.models['claude-opus-5-5 · fast'].tier, 'fast');
});

test('cache writes split into 5-minute and 1-hour, else count as 5-minute', () => {
  const agg = aggregate([
    assistant({ usage: { cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, cache_creation_input_tokens: 30 } }),
    assistant({ usage: { cache_creation_input_tokens: 7 } }),
  ]);
  const b = agg.models['claude-opus-5-5'];
  assert.deepEqual([b.cacheWrite5m, b.cacheWrite1h], [17, 20]);
});

test('tool calls are counted once per tool_use id', () => {
  const content = [{ type: 'tool_use', id: 'toolu_1', name: 'Bash' }];
  const agg = aggregate([
    assistant({ id: 'msg_t', requestId: 'req_t', content }),
    assistant({ id: 'msg_t', requestId: 'req_t', content }),
  ]);
  assert.equal(agg.toolCalls, 1);
});

test('mergeAggregates sums buckets by key', () => {
  const a = aggregate([assistant({ usage: { output_tokens: 10 } })]);
  const b = aggregate([assistant({ usage: { output_tokens: 5 } }), assistant({ usage: { output_tokens: 1, speed: 'fast' } })]);
  const m = mergeAggregates([a, b]);
  assert.equal(m.models['claude-opus-5-5'].output, 15);
  assert.equal(m.models['claude-opus-5-5 · fast'].output, 1);
  assert.equal(m.assistantResponses, 3);
});

test('prompts: only what a person typed and Claude answered', () => {
  const records = [
    user('hello'),
    assistant(),
    user('<command-message>wp</command-message>\n<command-name>/wp</command-name>\n<command-args>3.3</command-args>'),
    assistant(),
    user('injected context', { isMeta: true }),
    user('<task-notification>\n<summary>done</summary>\n</task-notification>'),
    user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }]),
    assistant(),
    user('[Request interrupted by user]'),
    user('queued one'),
    user([{ type: 'text', text: 'queued two' }]),
    assistant({ model: '<synthetic>' }),
    assistant(),
    user('never answered'),
  ];
  assert.equal(aggregate(records).userPrompts, 4); // hello, /wp, queued one, queued two
});

test("a sub-agent's task prompt is not a prompt", () => {
  const agg = aggregate([user('Explore the repo', { isSidechain: true }), assistant({ isSidechain: true })]);
  assert.equal(agg.userPrompts, 0);
});

test('active time skips pauses over 30 minutes; sub-agent records can bridge them', () => {
  const main = aggregate([user('a', { min: 0 }), assistant({ min: 10 }), user('b', { min: 130 }), assistant({ min: 135 })]);
  const min = 60_000;
  assert.deepEqual(activeTime(main.timestamps), { activeMs: 15 * min, wallMs: 135 * min });

  const sub = aggregate([35, 60, 85, 110].map((m) => assistant({ min: m, isSidechain: true })));
  const merged = mergeAggregates([main, sub]);
  assert.deepEqual(activeTime(merged.timestamps), { activeMs: 135 * min, wallMs: 135 * min });
});

test('title: /rename beats the AI title, which beats the last prompt', () => {
  const ai = { type: 'ai-title', aiTitle: 'AI title' };
  const custom = { type: 'custom-title', customTitle: 'My name' };
  const last = { type: 'last-prompt', lastPrompt: 'fix   the\nbug' };
  assert.equal(extractMeta([ai, custom, last], 's').title, 'My name');
  assert.equal(extractMeta([ai, last], 's').title, 'AI title');
  assert.equal(extractMeta([last], 's').title, 'fix the bug');
  assert.equal(extractMeta([], 's').title, '(untitled session)');
});

test('a long last-prompt title is cut without splitting an emoji', () => {
  const lastPrompt = 'x'.repeat(58) + '🚀🚀🚀';
  const { title } = extractMeta([{ type: 'last-prompt', lastPrompt }], 's');
  assert.equal(title, 'x'.repeat(58) + '🚀…');
  assert.equal(Array.from(title).length, 60);
});
