// Where Claude Code keeps its config and transcripts: $CLAUDE_CONFIG_DIR, else
// ~/.claude. Read on every call, so the installer and tests can redirect it.

import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}
