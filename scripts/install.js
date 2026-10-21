#!/usr/bin/env node
// Install (or remove) the three global Claude Code integrations for claude-receipt:
//   1. a SessionEnd hook in <config>/settings.json  → auto-receipt on session end
//   2. a /receipt slash command in <config>/commands/receipt.md
//   3. a /receipt-rebuild slash command in <config>/commands/receipt-rebuild.md
//      → re-price the project's receipts after a price change
//
// The absolute path to this clone's bin/receipt.js is computed automatically, so
// there is nothing to hand-edit. Re-running is safe (idempotent): the hook is
// updated in place, never duplicated, and other hooks are left alone. The first
// run keeps your original settings as settings.json.bak. Undo with `--uninstall`.
//
//   node scripts/install.js              # install / refresh
//   node scripts/install.js --uninstall  # remove
//
// Config location is <CLAUDE_CONFIG_DIR or ~/.claude>. Applies to NEW sessions —
// open /hooks once (or restart) to load the hook into a running session.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { configDir as claudeConfigDir } from '../src/config.js';

// Identifies our SessionEnd hook among any others: a command running some
// clone's bin/receipt.js with --hook (quoted path from this script, or a
// hand-written one as the README shows).
const OUR_HOOK = /[\\/]bin[\\/]receipt\.js"? --hook$/;

const here = dirname(fileURLToPath(import.meta.url));
const receiptPath = resolve(here, '..', 'bin', 'receipt.js').replaceAll('\\', '/');
const configDir = claudeConfigDir();
const settingsPath = join(configDir, 'settings.json');
const commandPath = join(configDir, 'commands', 'receipt.md');
const rebuildCommandPath = join(configDir, 'commands', 'receipt-rebuild.md');

const hookCommand = `node "${receiptPath}" --hook`;
const slashCommand = `node "${receiptPath}" --open`;
const rebuildSlashCommand = `node "${receiptPath}" --rebuild`;

const hookEntry = {
  type: 'command',
  command: hookCommand,
  timeout: 30,
  statusMessage: 'Writing session receipt…',
};

// disable-model-invocation: only you run these; Claude can't call them on its own
// (a rebuild rewrites every receipt in the folder).
const commandFile = `---
description: Generate a Markdown + HTML receipt for the current Claude Code session
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

Ran the receipt generator for the current session (output below). Briefly tell me the total tokens and estimated cost, and where the files were written.

!\`${slashCommand}\`
`;

const rebuildCommandFile = `---
description: Re-price every receipt in this project's .claude-receipts folder (after a price change)
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

Ran the receipt rebuild for this project's .claude-receipts folder (output below). Briefly tell me how many receipts were rebuilt, which were kept because their transcript is gone, and the total estimated cost before and after.

!\`${rebuildSlashCommand}\`
`;

function readSettings() {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, 'utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${settingsPath} is not valid JSON (${e.message}). Fix or move it, then re-run — refusing to overwrite it.`,
    );
  }
}

// The .bak is written once, so it keeps the settings from before the first
// install rather than whatever the previous run left.
function writeSettings(obj) {
  mkdirSync(configDir, { recursive: true });
  if (existsSync(settingsPath) && !existsSync(settingsPath + '.bak')) {
    writeFileSync(settingsPath + '.bak', readFileSync(settingsPath));
  }
  writeFileSync(settingsPath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// True if a SessionEnd hook entry is one of ours.
const isOurs = (h) => typeof h?.command === 'string' && OUR_HOOK.test(h.command.trim());

function install() {
  const settings = readSettings();
  settings.hooks ||= {};
  settings.hooks.SessionEnd ||= [];

  // Update our hook in place if present; otherwise add a new group.
  let updated = false;
  for (const group of settings.hooks.SessionEnd) {
    if (!group || !Array.isArray(group.hooks)) continue;
    for (let i = 0; i < group.hooks.length; i++) {
      if (isOurs(group.hooks[i])) {
        group.hooks[i] = hookEntry;
        updated = true;
      }
    }
  }
  if (!updated) settings.hooks.SessionEnd.push({ hooks: [hookEntry] });
  writeSettings(settings);

  mkdirSync(dirname(commandPath), { recursive: true });
  writeFileSync(commandPath, commandFile, 'utf8');
  writeFileSync(rebuildCommandPath, rebuildCommandFile, 'utf8');

  console.log('claude-receipt installed:');
  console.log(`  hook              ${settingsPath}  (SessionEnd → ${updated ? 'updated' : 'added'})`);
  console.log(`  /receipt          ${commandPath}`);
  console.log(`  /receipt-rebuild  ${rebuildCommandPath}`);
  console.log(`  receipt.js        ${receiptPath}`);
  console.log('\nApplies to NEW sessions — open /hooks once or restart to load the hook now.');
}

function uninstall() {
  const settings = existsSync(settingsPath) ? readSettings() : {};
  const groups = settings.hooks?.SessionEnd;
  let removed = 0;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) continue;
      const kept = group.hooks.filter((h) => !isOurs(h));
      removed += group.hooks.length - kept.length;
      group.hooks = kept;
    }
  }
  if (removed) {
    settings.hooks.SessionEnd = groups.filter((g) => !g || !Array.isArray(g.hooks) || g.hooks.length);
    if (!settings.hooks.SessionEnd.length) delete settings.hooks.SessionEnd;
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    writeSettings(settings);
    console.log(`Removed SessionEnd hook from ${settingsPath}`);
  } else {
    console.log(`No claude-receipt hook in ${settingsPath} — left it unchanged.`);
  }

  for (const path of [commandPath, rebuildCommandPath]) {
    if (existsSync(path)) {
      rmSync(path);
      console.log(`Removed ${path}`);
    }
  }
}

try {
  const arg = process.argv[2];
  if (arg === '--uninstall' || arg === '--remove') uninstall();
  else if (arg === '-h' || arg === '--help') console.log('Usage: node scripts/install.js [--uninstall]');
  else if (arg) {
    console.error(`Unknown argument "${arg}". Usage: node scripts/install.js [--uninstall]`);
    process.exit(2);
  } else install();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
