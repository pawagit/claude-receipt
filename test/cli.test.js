import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { fakeClaude, runCli } from './helpers.js';

const A = 'aaaa1111-0000-4000-8000-000000000001';
const B = 'bbbb2222-0000-4000-8000-000000000002';

test('inside Claude Code the current session wins over a newer one; --latest takes the newest', () => {
  const c = fakeClaude();
  c.addSession(A, { title: 'Session A', ageMin: 10 });
  c.addSession(B, { title: 'Session B', ageMin: 0 });

  const current = runCli([], { config: c.config, env: { CLAUDE_CODE_SESSION_ID: A } });
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /Receipt for: Session A {2}\[aaaa1111\]/);

  const latest = runCli(['--latest'], { config: c.config, env: { CLAUDE_CODE_SESSION_ID: A } });
  assert.match(latest.stdout, /Receipt for: Session B/);

  const outside = runCli([], { config: c.config });
  assert.match(outside.stdout, /Receipt for: Session B/);
});

test('an unknown current session falls back to the latest, with a note', () => {
  const c = fakeClaude();
  c.addSession(B, { title: 'Session B' });
  const r = runCli([], { config: c.config, env: { CLAUDE_CODE_SESSION_ID: 'gone' } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /current session gone not found/);
  assert.match(r.stdout, /Receipt for: Session B/);
});

test('--session takes a unique prefix and rejects an ambiguous one', () => {
  const c = fakeClaude();
  c.addSession('cafe0001-0000-4000-8000-000000000001', { title: 'One' });
  c.addSession('cafe0002-0000-4000-8000-000000000002', { title: 'Two' });
  assert.match(runCli(['--session', 'cafe0002'], { config: c.config }).stdout, /Receipt for: Two/);
  const ambiguous = runCli(['--session', 'cafe'], { config: c.config });
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /matches 2 sessions/);
});

test('command-line mistakes exit 2 and write nothing', () => {
  const c = fakeClaude();
  c.addSession(A);
  for (const args of [['--sesion', A], ['--session'], ['--session', '--open'], ['--latest', '--session', A], ['stray']]) {
    const r = runCli(args, { config: c.config });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /Run with --help/);
  }
  assert.equal(existsSync(c.receipts), false);
});

test('--version prints the package version', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(runCli(['--version'], {}).stdout.trim(), version);
});

test("--rebuild without a dir rebuilds the current session's folder, wherever the shell is", () => {
  const c = fakeClaude();
  c.addSession(A, { title: 'Session A' });
  const env = { CLAUDE_CODE_SESSION_ID: A };
  assert.equal(runCli([], { config: c.config, env }).status, 0);
  const r = runCli(['--rebuild'], { config: c.config, env, cwd: c.root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Rebuilt 1 of 1 receipt/);
});
