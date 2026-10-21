import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { tempDir } from './helpers.js';

const INSTALL = fileURLToPath(new URL('../scripts/install.js', import.meta.url));
const install = (config, ...args) =>
  spawnSync(process.execPath, [INSTALL, ...args], { env: { ...process.env, CLAUDE_CONFIG_DIR: config }, encoding: 'utf8' });
const settingsOf = (config) => JSON.parse(readFileSync(join(config, 'settings.json'), 'utf8'));
const sessionEndCommands = (config) => (settingsOf(config).hooks?.SessionEnd ?? []).flatMap((g) => g.hooks.map((h) => h.command));

test('installs into a config folder that does not exist yet', () => {
  const config = join(tempDir(), 'fresh');
  const r = install(config);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sessionEndCommands(config).filter((c) => c.endsWith('--hook')).length, 1);
  for (const name of ['receipt.md', 'receipt-rebuild.md']) {
    const text = readFileSync(join(config, 'commands', name), 'utf8');
    assert.match(text, /^disable-model-invocation: true$/m, name);
    assert.match(text, /bin\/receipt\.js" --(open|rebuild)`/, name);
  }
});

test('install twice: one hook; other hooks and the first .bak survive; uninstall removes only ours', () => {
  const config = tempDir();
  const theirs = ['node "/opt/tools/receipt.js" --notify', 'echo bye'];
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ theme: 'dark', hooks: { SessionEnd: [{ hooks: theirs.map((command) => ({ type: 'command', command })) }] } }));
  const original = readFileSync(join(config, 'settings.json'), 'utf8');

  install(config);
  install(config);
  const commands = sessionEndCommands(config);
  assert.deepEqual(commands.filter((c) => !theirs.includes(c)).length, 1);
  assert.ok(theirs.every((c) => commands.includes(c)));
  assert.equal(readFileSync(join(config, 'settings.json.bak'), 'utf8'), original);

  const r = install(config, '--uninstall');
  assert.match(r.stdout, /Removed SessionEnd hook/);
  assert.deepEqual(sessionEndCommands(config), theirs);
  assert.equal(settingsOf(config).theme, 'dark');
  assert.equal(existsSync(join(config, 'commands', 'receipt.md')), false);
  assert.equal(existsSync(join(config, 'commands', 'receipt-rebuild.md')), false);

  const before = readFileSync(join(config, 'settings.json'), 'utf8');
  assert.match(install(config, '--uninstall').stdout, /No claude-receipt hook/);
  assert.equal(readFileSync(join(config, 'settings.json'), 'utf8'), before);
});

test('an unknown installer argument is refused without touching anything', () => {
  const config = join(tempDir(), 'untouched');
  const r = install(config, '--unistall');
  assert.equal(r.status, 2);
  assert.equal(existsSync(config), false);
});

test('a hand-written hook from the README counts as ours', () => {
  const config = tempDir();
  mkdirSync(config, { recursive: true });
  const manual = 'node /path/to/claude-receipt/bin/receipt.js --hook';
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command: manual }] }] } }));
  install(config);
  const commands = sessionEndCommands(config);
  assert.equal(commands.length, 1);
  assert.notEqual(commands[0], manual); // replaced in place by this clone's path
});
