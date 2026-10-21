import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregate, extractMeta } from '../src/aggregate.js';
import { buildView, renderHtml, renderMarkdown } from '../src/render.js';
import { assistant, user } from './helpers.js';

const view = (records, meta = {}) =>
  buildView({ ...extractMeta(records, 'sess-1'), ...meta }, aggregate(records));

test('an emoji at the title cut-off, or a lone surrogate, does not break rendering', () => {
  for (const title of ['y'.repeat(59) + '🎉 party', 'broken \ud83d surrogate']) {
    const v = view([user('hi'), assistant({ usage: { output_tokens: 3 } })], { title });
    assert.doesNotThrow(() => renderHtml(v));
    assert.doesNotThrow(() => renderMarkdown(v));
  }
});

test('Markdown escapes | in table cells', () => {
  const v = view([user('hi'), assistant()], { project: 'a|b', gitBranch: 'feat|x' });
  const md = renderMarkdown(v);
  assert.match(md, /\| \*\*Project\*\* \| a\\|b \(feat\\|x\) \|/);
});

test('duration shows active time, and wall time when idle pauses dominate', () => {
  const busy = view([user('a', { min: 0 }), assistant({ min: 20 })]);
  assert.match(renderMarkdown(busy), /\| \*\*Duration\*\* \| 20m 0s \|/);

  const idle = view([user('a', { min: 0 }), assistant({ min: 10 }), user('b', { min: 600 }), assistant({ min: 605 })]);
  assert.match(renderMarkdown(idle), /\| \*\*Duration\*\* \| 15m 0s active \(wall 10h 5m\) \|/);
});
