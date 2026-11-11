# Changelog

## Unreleased

**After updating:** run `node bin/receipt.js --rebuild --all` to re-price the
receipts you already have — Claude Fable 5.2 sessions showed no price, and
Claude Sonnet 5.5 cache reads were priced too high.

### Fixed

- **Claude Sonnet 5.5 cache reads cost twice the real price.** They were
  priced at the standard 0.1x ($0.20 / MTok) instead of 0.05x ($0.10 / MTok).

### Added

- Prices for Claude Fable 5.2 and Claude Mythos 5.2 ($8 / $40 per MTok, cache
  reads at 0.025x, fast mode $16 / $80).

## 1.1.0 — 2026-10-21

**After updating:** run `npm run setup` once to refresh the slash commands, and
`node bin/receipt.js --rebuild --all` to re-price the receipts you already have —
receipts of sessions with sub-agents were too low, and Claude Opus 5.5 sessions
showed $0.00.

### Fixed

- **Sub-agent output tokens were undercounted.** Sub-agent transcripts write
  mid-stream snapshots of a response before its final row, and the first row was
  the one counted. Each response now counts from its final row; on real data that
  added up to $14 to a single receipt.
- **Current models had no price.** Claude Opus 5.5 (and other current models) had
  no row in `models.json`, so their receipts showed $0.00. Claude Sonnet 5 was
  priced at $3/$15 instead of $2/$10.
- **`/receipt` could receipt the wrong session.** It took the most recently changed
  transcript anywhere; with sessions running in parallel that was often another one.
  Inside Claude Code it now takes the session it runs in (`CLAUDE_CODE_SESSION_ID`).
- **Sessions closed without ending never got a receipt.** The hook now also catches
  up the project's sessions that have none (see `--missing`).
- **Prompt counts** included Claude Code's injected messages, task notifications,
  interrupts and every sub-agent's task prompt — about half the count on real data.
- **Duration** was wall time, including nights a session sat open. It is now active
  time, with the wall time alongside when idle time dominates.
- **`index.json` could be lost**: a corrupt file was silently replaced by a
  one-entry index, and sessions ending at the same moment could overwrite each
  other's entries.
- An emoji at the title cut-off crashed receipt generation (QR encoder).
- `--open` crashed where no browser opener exists (SSH, WSL), and a Windows path
  containing `&` split the command.
- Unknown or incomplete command-line flags were ignored, so a typo like
  `--sesion <id>` silently receipted the latest session.
- `CLAUDE_CONFIG_DIR` was ignored when looking for transcripts.
- Installer: failed when the config folder didn't exist; could replace or remove
  someone else's hook mentioning `receipt.js`; overwrote `settings.json.bak` on
  every run.

### Added

- Prices for the current models, per-model cache rates (Opus 5.5 and Fable 5.1 read
  cache cheaper), fast-mode rates (Opus 5.5, Opus 5, Opus 4.8) and long-context rates
  (Haiku 5.5), each on its own line item.
- Web search pricing ($10 per 1,000 searches) and Bedrock/Vertex model ids.
- `--rebuild [dir]` and `--rebuild --all` to re-price existing receipts, and a
  `/receipt-rebuild` slash command.
- `--missing [dir]` to receipt a project's sessions that have none yet.
- `--latest`, `--session <prefix>`, `--version`.
- Hook errors are logged to `<config>/claude-receipt.log`.
- Each receipt embeds its index entry; `--index` rebuilds a damaged or incomplete
  index from the receipt files.
- A name set with `/rename` becomes the receipt title.
- A test suite (`npm test`) and CI on Linux, macOS and Windows.

### Changed

- Requires Node.js 22 or newer (Node 20 is end-of-life).
- Command-line mistakes exit with code 2.
- The slash commands set `disable-model-invocation: true`: only you can run them.

## 1.0.0

First release: Markdown + HTML receipts from Claude Code transcripts, the
`SessionEnd` hook, the `/receipt` command, and per-folder `index.html`.
