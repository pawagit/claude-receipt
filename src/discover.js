// Locating Claude Code session transcripts on disk.
//
// Both the terminal CLI and the official VS Code extension write to the same
// store: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// (the folder name is the project path with non-alphanumerics replaced by '-',
// but we never need to decode it — each record carries the real `cwd`).

import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function projectsRoot() {
  return join(homedir(), '.claude', 'projects');
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
