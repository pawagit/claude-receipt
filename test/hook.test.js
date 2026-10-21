import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assistant, fakeClaude, runCli, user } from './helpers.js';

const id = (n) => `${n}0000000-0000-4000-8000-000000000000`.slice(0, 36);
const entries = (dir) => Object.keys(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).entries).sort();
const hookPayload = (file) => JSON.stringify({ hook_event_name: 'SessionEnd', transcript_path: file, reason: 'exit' });

// The session that just ended, plus the kinds of session catch-up must tell apart.
function project() {
  const c = fakeClaude();
  const ended = c.addSession(id(1), { title: 'Ended now' });
  c.addSession(id(2), { title: 'Missed', ageMin: 120 });
  c.addSession(id(3), { title: 'SDK run', ageMin: 120, entrypoint: 'sdk-py' });
  c.addSession(id(4), { title: 'Still open', ageMin: 10 });
  c.addSession(id(5), { title: 'Nothing billed', ageMin: 120, records: [user('hi'), assistant({ model: '<synthetic>' })] });
  c.addSession(id(6), { title: 'Other project', ageMin: 120, cwd: c.root });
  return { c, ended };
}

test('the hook receipts the ended session and catches up missed ones', () => {
  const { c, ended } = project();
  const r = runCli(['--hook'], { config: c.config, input: hookPayload(ended) });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(entries(c.receipts), [id(1), id(2)]);
  assert.match(r.stdout, /caught up Missed/);
  assert.equal(existsSync(join(c.root, '.claude-receipts')), false); // other project untouched
});

test('--missing does the same catch-up by hand (a session active just now is left alone)', () => {
  const { c } = project();
  const r = runCli(['--missing', c.receipts], { config: c.config });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Receipted 1 session\(s\) that had none/);
  assert.deepEqual(entries(c.receipts), [id(2)]);
});

test('the hook exits 0 on garbage input and writes nothing', () => {
  const c = fakeClaude();
  const r = runCli(['--hook'], { config: c.config, input: 'not json' });
  assert.equal(r.status, 0);
  assert.equal(existsSync(c.receipts), false);
});

test('a failing hook exits 0 and logs the error to <config>/claude-receipt.log', () => {
  const c = fakeClaude();
  const r = runCli(['--hook'], { config: c.config, input: hookPayload(c.project) }); // a folder, not a transcript
  assert.equal(r.status, 0);
  assert.match(readFileSync(join(c.config, 'claude-receipt.log'), 'utf8'), /EISDIR/);
});

test('--open without a browser opener still writes the receipt', { skip: process.platform === 'win32' }, () => {
  const c = fakeClaude();
  c.addSession(id(1));
  const r = runCli(['--open'], { config: c.config, env: { PATH: c.root } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Couldn't open the receipt/);
  assert.equal(entries(c.receipts).length, 1);
});
