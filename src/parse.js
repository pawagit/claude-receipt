// Reading a JSONL transcript into records, tolerant of a partially-written
// final line (which happens when receipting a session that is still live).

import { readFileSync, existsSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export function parseSessionFile(file) {
  const text = readFileSync(file, 'utf8');
  const records = [];
  let parseErrors = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      parseErrors++; // typically only the last line of a live session
    }
  }
  return { records, parseErrors };
}

// The first value of a record field such as `cwd` or `entrypoint` ('cli',
// 'claude-vscode', 'sdk-py', …). Reads only as far as the first record that
// has it, so checking many sessions stays cheap — but not a fixed number of
// bytes: a transcript can open with 100 KB+ of queued-message records first.
export function peekField(file, key) {
  const fd = openSync(file, 'r');
  try {
    const decoder = new StringDecoder('utf8'); // keeps characters split across chunks whole
    const buf = Buffer.alloc(256 * 1024);
    const needle = `"${key}"`;
    let pos = 0;
    let rest = '';
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      pos += n;
      const lines = (rest + (n ? decoder.write(buf.subarray(0, n)) : decoder.end())).split('\n');
      rest = n ? lines.pop() : '';
      for (const line of lines) {
        if (!line.includes(needle)) continue;
        try {
          const value = JSON.parse(line)[key];
          if (value) return value;
        } catch {}
      }
      if (!n) return null;
    }
  } finally {
    closeSync(fd);
  }
}

// Workflow / Task sub-agents are stored as separate transcripts under
// <project>/<session-id>/subagents/**/agent-*.jsonl (journal.jsonl excluded).
// These represent real token spend spawned by the session.
export function findSubagentFiles(sessionFile) {
  const dir = dirname(sessionFile);
  const sessionId = sessionFile
    .slice(dir.length + 1)
    .replace(/\.jsonl$/, '');
  const subRoot = join(dir, sessionId, 'subagents');
  if (!existsSync(subRoot)) return [];
  return walk(subRoot).filter(
    (f) => f.endsWith('.jsonl') && !f.endsWith('journal.jsonl'),
  );
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
