// Builders for synthetic transcript records, so tests never read real sessions.
// Timestamps are minutes after a fixed start; ids are unique per call.

import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';

const BIN = fileURLToPath(new URL('../bin/receipt.js', import.meta.url));
const tempDirs = [];
after(() => tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

let seq = 0;
const START = Date.UTC(2026, 9, 1, 9, 0);

export const at = (min) => new Date(START + min * 60_000).toISOString();

export function user(content, { min = 0, ...extra } = {}) {
  return { type: 'user', timestamp: at(min), uuid: `u${++seq}`, message: { role: 'user', content }, ...extra };
}

export function assistant({
  id = `msg_${++seq}`,
  requestId = `req_${seq}`,
  model = 'claude-opus-5-5',
  min = 0,
  usage = {},
  content = [{ type: 'text', text: 'ok' }],
  stop = 'end_turn',
  ...extra
} = {}) {
  return {
    type: 'assistant',
    timestamp: at(min),
    uuid: `a${++seq}`,
    requestId,
    message: { id, model, role: 'assistant', content, stop_reason: stop, usage: { input_tokens: 0, output_tokens: 0, ...usage } },
    ...extra,
  };
}

// A temp folder, removed when the test file finishes.
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-receipt-test-'));
  tempDirs.push(dir);
  return dir;
}

export function writeJsonl(file, records) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// A throwaway Claude Code setup: a config dir (what CLAUDE_CONFIG_DIR points
// at) holding transcripts, and a project folder those sessions ran in.
export function fakeClaude() {
  const root = tempDir();
  const config = join(root, 'config');
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  return {
    root,
    config,
    project,
    receipts: join(project, '.claude-receipts'),
    // Write a session transcript; `ageMin` sets how long ago it was last modified.
    // Like Claude Code, the transcript's folder is named after its cwd.
    // `leadingKb` puts that much of record without cwd/entrypoint first, as
    // queued-message records do in real transcripts.
    addSession(id, { title = id, records, ageMin = 0, entrypoint = 'cli', cwd = project, leadingKb = 0 } = {}) {
      const file = join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
      const body = records ?? [user('hi'), assistant({ usage: { input_tokens: 10, output_tokens: 100 } })];
      writeJsonl(file, [
        ...(leadingKb ? [{ type: 'queue-operation', content: 'é'.repeat(leadingKb * 512), sessionId: id }] : []),
        { type: 'ai-title', aiTitle: title, sessionId: id },
        ...body.map((r) => ({ cwd, sessionId: id, entrypoint, ...r })),
      ]);
      const t = Date.now() / 1000 - ageMin * 60;
      utimesSync(file, t, t);
      return file;
    },
  };
}

// Run the CLI against a fake config. CLAUDE_CODE_SESSION_ID is cleared unless
// given, since the tests themselves may run inside a Claude Code session.
export function runCli(args, { config, env = {}, input, cwd } = {}) {
  const fullEnv = { ...process.env, CLAUDE_CONFIG_DIR: config ?? tempDir() };
  delete fullEnv.CLAUDE_CODE_SESSION_ID;
  Object.assign(fullEnv, env);
  return spawnSync(process.execPath, [BIN, ...args], { env: fullEnv, input, cwd, encoding: 'utf8' });
}
