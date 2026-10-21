// Locating Claude Code session transcripts on disk.
//
// Both the terminal CLI and the official VS Code extension write to the same
// store: <config>/projects/<encoded-cwd>/<session-id>.jsonl, where <config> is
// $CLAUDE_CONFIG_DIR or ~/.claude (the folder name is the project path with
// non-alphanumerics replaced by '-', but we never need to decode it — each
// record carries the real `cwd`).

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { configDir } from './config.js';

export function projectsRoot() {
  return join(configDir(), 'projects');
}

// All top-level session files: <root>/<project>/<session-id>.jsonl
// (Nested subagent transcripts under <session>/subagents/** are excluded here.)
export function listSessions(root = projectsRoot()) {
  if (!existsSync(root)) return [];
  const sessions = [];
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const projectDir = join(root, project.name);
    let entries;
    try {
      entries = readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = join(projectDir, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      sessions.push({
        file,
        sessionId: entry.name.replace(/\.jsonl$/, ''),
        projectDirName: project.name,
        mtimeMs,
      });
    }
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function findLatest(root = projectsRoot()) {
  return listSessions(root)[0] ?? null;
}

export function findBySessionId(id, root = projectsRoot()) {
  return listSessions(root).find((s) => s.sessionId === id) ?? null;
}

// A session by full id or by a unique prefix (receipt file names show the first
// 8 characters). Throws when a prefix matches more than one session.
export function findSession(idOrPrefix, root = projectsRoot()) {
  const sessions = listSessions(root);
  const exact = sessions.find((s) => s.sessionId === idOrPrefix);
  if (exact) return exact;
  const matches = sessions.filter((s) => s.sessionId.startsWith(idOrPrefix));
  if (matches.length > 1) {
    throw new Error(`Session id "${idOrPrefix}" matches ${matches.length} sessions; give more characters.`);
  }
  return matches[0] ?? null;
}
