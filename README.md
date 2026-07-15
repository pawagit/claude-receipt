# claude-receipt

Generate a **receipt** (Markdown + HTML) for a Claude Code session — tokens, models,
tool calls, duration, and estimated cost. Works for sessions run in the **official
Claude Code VS Code extension** and the terminal CLI, on Windows/macOS/Linux.

Inspired by [chrishutchinson/claude-receipts](https://github.com/chrishutchinson/claude-receipts).
Printing is out of scope; the output is a `.md` + a self-contained `.html`.

<p align="center">
  <img src="assets/receipt-example.png" alt="Example Claude Code receipt — brand mark, per-model token line items, total cost, and a scannable QR code" width="360">
  <br><em>Example HTML receipt (sample data).</em>
</p>

## How it works

Claude Code (both the extension and the CLI — same engine) stores every session as a
JSONL transcript under `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. This tool
reads that file directly, so it needs no API key and works offline.

```
~/.claude/projects/**.jsonl → discover → parse → aggregate(dedup) → price → render → .md + .html
```

The one subtlety it handles: a single assistant API response is written as **multiple
JSONL lines** that each repeat the full `usage` object, so usage is deduped by
`message.id` before summing (otherwise tokens are counted 3–4×).

## Install

From zero to your first receipt:

**1. Install Node.js 20 or newer.** Check with `node --version`. That's the only
prerequisite — this tool has **no dependencies and no build step** (it uses only
Node's built-in modules).

**2. Get the code.**

```bash
git clone https://github.com/<your-username>/claude-receipt.git
cd claude-receipt
```

**3. Confirm it can see your sessions.**

```bash
node bin/receipt.js --list
```

You should see a list of your recent Claude Code sessions. No API key is needed —
the tool reads the local transcripts under `~/.claude/projects/`.

**4. Generate your first receipt.**

```bash
node bin/receipt.js --open
```

This receipts your most recent session, writes a `.md` + `.html` into that
session's project folder, and opens the HTML.

**5. (Optional) Wire it into Claude Code.** For a receipt automatically at the
end of every session, plus a `/receipt` slash command, run the installer:

```bash
npm run setup          # or: node scripts/install.js
```

It adds a `SessionEnd` hook and a `/receipt` command to your global `~/.claude/`
config, filling in this clone's absolute path for you — no manual path editing.
It merges into any existing `settings.json` (writing a `.bak` first), is safe to
re-run, and undoes cleanly with `node scripts/install.js --uninstall`. Open
`/hooks` once (or restart) to load the hook into a running session. See
**Auto-generate on every session** for exactly what it configures, or to set it
up by hand.

For a shorter `claude-receipt` command instead of `node …/bin/receipt.js`, see
**Optional: install as a terminal command**.

## Usage

```bash
node bin/receipt.js                  # latest session anywhere
node bin/receipt.js --session <id>   # a specific session id
node bin/receipt.js --project <dir>  # latest session whose cwd matches <dir>
node bin/receipt.js --list           # list available sessions
node bin/receipt.js --open           # also open the HTML when done
```

| Flag | Meaning |
|---|---|
| `--session <id>` | Receipt a specific session id |
| `--project <dir>` | Latest session whose recorded `cwd` matches `<dir>` |
| `--list` | List discoverable sessions (date · project · title · id) |
| `--out <dir>` | Output directory (default: the session's own `<project>/.claude-receipts`) |
| `--no-subagents` | Exclude nested workflow/Task sub-agent token spend |
| `--no-index` | Don't update the folder's `index.html` |
| `--index [dir]` | Rebuild `index.html` for a receipts folder, then exit |
| `--open` | Open the generated HTML |

Output is written to the **session's own project folder**:
`<project>/.claude-receipts/<date>_<title-slug>_<shortid>.{md,html}` — e.g.
`.claude-receipts/2026-05-31_run-nightly-sync-script_2482b37c.html`. Override the
location with `--out <dir>`. Add `.claude-receipts/` to each repo's `.gitignore`.

Each folder also gets an **`index.html`** listing all its receipts with running
totals (backed by an `index.json` manifest), rebuilt on every run — or on demand
with `--index [dir]`.

### Optional: install as a terminal command

The auto-receipt hook and `/receipt` **don't need this** — they call `node` with
the full path. `npm link` is only so you can type `claude-receipt` in a terminal
instead of `node /path/to/claude-receipt/bin/receipt.js`.

```bash
cd <this-project>     # the folder containing package.json
npm link              # creates a global `claude-receipt` command on your PATH
```

It symlinks to your source, so edits take effect immediately. Open a **new**
terminal afterwards so PATH refreshes, then `claude-receipt --list`. Undo with
`npm rm -g claude-receipt`. (Windows: needs npm's global bin dir on PATH — it
usually already is; `npm config get prefix` shows the folder.)

No-npm alternative — add a PowerShell function to your `$PROFILE`:

```powershell
function claude-receipt { node C:\path\to\claude-receipt\bin\receipt.js @args }
```

## Auto-generate on every session (installed globally)

Two pieces wire receipts into your global `~/.claude/` config so they work in every
new conversation. **The installer sets up both for you** (recommended):

```bash
npm run setup                        # add the hook + /receipt command
node scripts/install.js --uninstall  # remove them
```

It merges into your existing `settings.json` (writing a `.bak` first), never
duplicates on re-run, and fills in this clone's absolute path automatically. By
default it targets `~/.claude/` (override with the `CLAUDE_CONFIG_DIR`
environment variable). The rest of this section documents what it configures —
do it by hand instead if you prefer.

**1. Automatic — `SessionEnd` hook** in `~/.claude/settings.json` (replace
`/path/to/claude-receipt` with the absolute path to your clone — on Windows use
forward slashes, e.g. `C:/tools/claude-receipt/...`):

```json
"hooks": {
  "SessionEnd": [
    { "hooks": [
      { "type": "command", "command": "node /path/to/claude-receipt/bin/receipt.js --hook", "timeout": 30 }
    ] }
  ]
}
```

When any session ends (exit, `/clear`, logout) Claude Code pipes a JSON payload
containing `transcript_path` to the command; `--hook` reads it and writes the
receipt into **that session's own project folder** (`<project>/.claude-receipts/`),
with a readable filename. It always exits 0, so it never disrupts session end.
Applies to **new** sessions — open `/hooks` once or restart to load it into a
running session.

**2. On-demand — `/receipt` slash command** in `~/.claude/commands/receipt.md`:
type `/receipt` in any conversation to generate the receipt for the current
session and open the HTML.

Manage or disable the hook anytime via `/hooks`.

## What's on the receipt

- Session title (from Claude Code's `ai-title`), project, git branch, CC version
- Start time and duration
- Prompts · assistant turns · tool calls; web search/fetch counts
- Per-model line items: input / output / cache-write / cache-read tokens + subtotal
- Sub-agent token rollup (separate line; toggle with `--no-subagents`)
- **Total tokens** and **estimated equivalent API cost**
- A scannable **QR code** (HTML receipt) encoding the session summary, plus the Claude Code brand mark

## Cost & accuracy notes

- Cost is computed from a bundled price table ([models.json](models.json)) — the transcript
  stores token counts only, never cost. Prices change over time; edit `models.json` freely.
- Cache pricing uses the standard multipliers (read 0.1×, 5-min write 1.25×, 1-hour write 2×),
  using the 5m/1h split from `usage.cache_creation` when present.
- On a **Pro/Max subscription you don't pay per token** — the figure is labelled
  *estimated equivalent API cost*, i.e. what it would cost on the API.
- Receipting a **live** session is fine: a half-written final line is skipped (and reported).

## Project layout

```
bin/receipt.js     CLI entry point
scripts/install.js install / remove the SessionEnd hook + /receipt command
src/discover.js    find session files under ~/.claude/projects
src/parse.js       read JSONL (tolerant) + locate nested sub-agent transcripts
src/aggregate.js   dedup usage by message.id, group by model, counts, duration
src/pricing.js     token → cost via models.json
src/render.js      view-model + Markdown and HTML renderers
src/qrcode.js      dependency-free QR encoder (SVG output) for the receipt
src/index-page.js  folder index.html + index.json manifest
models.json        editable price table
assets/            brand source art (claudecode-color.svg) — not loaded at runtime
```

## About the Claude Code mark

"Claude" and "Claude Code" are products of [Anthropic](https://www.anthropic.com);
the robot mark (`assets/claudecode-color.svg`, inlined into the HTML receipt) is
Anthropic's. This is an independent, unofficial utility — not affiliated with,
sponsored by, or endorsed by Anthropic — and the mark is used only to identify
what the tool is for.

## Roadmap ideas

- `SessionEnd` hook for auto-generation, and/or a `/receipt` slash command
- Per-day / per-project roll-up receipts
- "Cache saved you X" stat
