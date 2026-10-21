import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { updateIndex } from '../src/index-page.js';
import { fakeClaude, runCli, tempDir } from './helpers.js';

const entriesIn = (dir) => JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')).entries;
const ids = ['a1', 'b2', 'c3'].map((p) => `${p}000000-0000-4000-8000-000000000000`);

test('a corrupt index.json is set aside and rebuilt from the receipt files', () => {
  const c = fakeClaude();
  ids.forEach((id, i) => c.addSession(id, { title: `S${i}` }));
  for (const id of ids.slice(0, 2)) assert.equal(runCli(['--session', id], { config: c.config }).status, 0);
  writeFileSync(join(c.receipts, 'index.json'), '{"entries": {"half-writ');

  const r = runCli(['--session', ids[2]], { config: c.config });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(Object.keys(entriesIn(c.receipts)).sort(), ids);
  assert.equal(readdirSync(c.receipts).filter((f) => f.startsWith('index.json.corrupt-')).length, 1);
});

test('eight processes updating the index at once leave eight entries and no temp or lock files', async () => {
  const dir = tempDir();
  const mod = new URL('../src/index-page.js', import.meta.url).href;
  const runs = Array.from({ length: 8 }, (_, i) => new Promise((done, fail) => {
    const code = `import(${JSON.stringify(mod)}).then((m) => m.updateIndex(${JSON.stringify(dir)}, { sessionId: 's${i}', htmlFile: 's${i}.html', totalCost: 1 }))`;
    const child = spawn(process.execPath, ['-e', code], { stdio: 'inherit' });
    child.on('exit', (status) => (status === 0 ? done() : fail(new Error(`writer ${i} exited ${status}`))));
  }));
  await Promise.all(runs);
  assert.equal(Object.keys(entriesIn(dir)).length, 8);
  assert.deepEqual(readdirSync(dir).sort(), ['index.html', 'index.json']);
});

test('--index drops entries whose receipt is gone and restores receipts the index lost', () => {
  const c = fakeClaude();
  ids.slice(0, 2).forEach((id) => c.addSession(id));
  for (const id of ids.slice(0, 2)) runCli(['--session', id], { config: c.config });
  const before = entriesIn(c.receipts);
  rmSync(join(c.receipts, before[ids[0]].htmlFile)); // receipt A deleted by hand
  const { [ids[1]]: lost, ...rest } = before; // entry B lost from the index
  writeFileSync(join(c.receipts, 'index.json'), JSON.stringify({ entries: rest }));

  const r = runCli(['--index', c.receipts], { config: c.config });
  assert.match(r.stdout, /Rebuilt index for 1 receipt/);
  assert.deepEqual(Object.keys(entriesIn(c.receipts)), [ids[1]]);
  assert.equal(entriesIn(c.receipts)[ids[1]].htmlFile, lost.htmlFile);
});

test('a stale lock left by a crash is taken over', () => {
  const dir = tempDir();
  const lock = join(dir, 'index.lock');
  writeFileSync(lock, '');
  const old = Date.now() / 1000 - 60;
  utimesSync(lock, old, old);
  updateIndex(dir, { sessionId: 's', htmlFile: 's.html' });
  assert.deepEqual(Object.keys(entriesIn(dir)), ['s']);
});
