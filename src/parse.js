// Reading a JSONL transcript into records, tolerant of a partially-written
// final line (which happens when receipting a session that is still live).

import { readFileSync, existsSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';

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

// How a session was started ('cli', 'claude-vscode', 'sdk-py', …), read from
// the first 64 KB only, so checking many sessions stays cheap. Null if unknown.
export function peekEntrypoint(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      try {
        const rec = JSON.parse(line);
        if (rec.entrypoint) return rec.entrypoint;
      } catch {}
    }
    return null;
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
