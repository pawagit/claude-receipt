// Builders for synthetic transcript records, so tests never read real sessions.
// Timestamps are minutes after a fixed start; ids are unique per call.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

export function tempDir() {
  return mkdtempSync(join(tmpdir(), 'claude-receipt-test-'));
}

export function writeJsonl(file, records) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
