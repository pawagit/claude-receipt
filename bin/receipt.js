#!/usr/bin/env node
// claude-receipt — generate a Markdown + HTML receipt for a Claude Code session.
//
// Usage:
//   node bin/receipt.js                 # the current session (inside Claude Code), else the latest
//   node bin/receipt.js --latest        # the most recent session anywhere
//   node bin/receipt.js --session <id>  # a specific session (full id or unique prefix)
//   node bin/receipt.js --project <dir> # latest session whose cwd matches <dir>
//   node bin/receipt.js --file <path>   # a specific transcript .jsonl
//   node bin/receipt.js --hook          # read a hook payload on stdin (for SessionEnd)
//   node bin/receipt.js --list          # list available sessions
//   node bin/receipt.js --out <dir>     # output directory (default: the session's own project)
//   node bin/receipt.js --no-subagents  # exclude nested sub-agent token spend
//   node bin/receipt.js --no-index      # don't update the folder index.html
//   node bin/receipt.js --index [dir]   # rebuild a folder's index.html, then exit
//   node bin/receipt.js --rebuild [dir] # regenerate every receipt in a folder (new prices)
//   node bin/receipt.js --open          # open the HTML when done
//   node bin/receipt.js --version       # print the version

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs as parseCli } from 'node:util';

import { listSessions, findLatest, findBySessionId, findSession, projectsRoot } from '../src/discover.js';
import { parseSessionFile, findSubagentFiles } from '../src/parse.js';
import { aggregate, extractMeta, mergeAggregates } from '../src/aggregate.js';
import { buildView, renderMarkdown, renderHtml, fmtDateTime } from '../src/render.js';
import { updateIndex, rebuildIndex, loadManifest } from '../src/index-page.js';

// A mistake on the command line: reported with a pointer to --help, exit code 2.
class UsageError extends Error {}

const OPTIONS = {
  session: { type: 'string' },
  project: { type: 'string' },
  file: { type: 'string' },
  latest: { type: 'boolean' },
  hook: { type: 'boolean' },
  list: { type: 'boolean' },
  out: { type: 'string' },
  'no-subagents': { type: 'boolean' },
  'no-index': { type: 'boolean' },
  index: { type: 'boolean' },
  rebuild: { type: 'boolean' },
  open: { type: 'boolean' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
};

// Strict: an unknown flag or a flag missing its value is an error, never a
// silent fallback to some other session. Only --index/--rebuild take a [dir].
function parseArgs(argv) {
  let parsed;
  try {
    parsed = parseCli({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    // Node's unknown-option text goes on about '--'; the first sentence is enough.
    throw new UsageError(err.message.replace(/\. To specify a positional[\s\S]*/, ''));
  }
  const { values: v, positionals } = parsed;
  const takesDir = v.index || v.rebuild;
  if (positionals.length > (takesDir ? 1 : 0)) {
    throw new UsageError(`Unexpected argument "${positionals[takesDir ? 1 : 0]}"`);
  }
  const selectors = ['file', 'session', 'project', 'latest'].filter((k) => v[k] !== undefined);
  if (selectors.length > 1) {
    throw new UsageError(`Pick one session: ${selectors.map((k) => `--${k}`).join(', ')} can't be combined`);
  }
  return {
    session: v.session ?? null,
    project: v.project ?? null,
    file: v.file ?? null,
    latest: !!v.latest,
    hook: !!v.hook,
    list: !!v.list,
    out: v.out ?? null,
    subagents: !v['no-subagents'],
    noIndex: !!v['no-index'],
    index: !!v.index,
    rebuild: !!v.rebuild,
    dir: positionals[0] ?? null,
    open: !!v.open,
    version: !!v.version,
    help: !!v.help,
  };
}

function printHelp() {
  console.log(`claude-receipt — receipts for Claude Code sessions

  (no args)            the current session when run inside Claude Code,
                       else the latest session anywhere
  --latest             the latest session anywhere
  --session <id>       a specific session (full id or a unique prefix)
  --project <dir>      latest session whose cwd matches <dir>
  --file <path>        receipt a specific transcript .jsonl
  --hook               read a Claude Code hook payload on stdin (for SessionEnd)
  --list               list available sessions
  --out <dir>          output directory (default: the session's own project)
  --no-subagents       exclude nested sub-agent token spend
  --no-index           don't update the folder index.html
  --index [dir]        rebuild index.html for a receipts folder, then exit
  --rebuild [dir]      regenerate every receipt in a receipts folder from its
                       transcript (e.g. after a price change), keeping file names
                       [dir] defaults to the current session's .claude-receipts
  --open               open the generated HTML
  --version            print the version
  --help`);
}

function version() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}

function pickSession(opts) {
  if (opts.file) {
    const f = resolve(opts.file);
    if (!existsSync(f)) throw new Error(`File not found: ${f}`);
    return { file: f, sessionId: basename(f).replace(/\.jsonl$/, '') };
  }
  if (opts.session) {
    const s = findSession(opts.session);
    if (!s) throw new Error(`No session found with id "${opts.session}" under ${projectsRoot()}.`);
    return s;
  }
  if (opts.project) {
    const target = resolve(opts.project).toLowerCase();
    const match = listSessions().find((s) => {
      const { records } = parseSessionFile(s.file);
      const cwd = records.find((r) => r.cwd)?.cwd;
      return cwd && resolve(cwd).toLowerCase() === target;
    });
    if (!match) throw new Error(`No session found for project "${opts.project}".`);
    return match;
  }
  // Inside Claude Code (a slash command, or Claude's own shell) the current
  // session is the one meant — not whichever transcript changed last, which may
  // be another session running in parallel.
  const current = process.env.CLAUDE_CODE_SESSION_ID;
  if (current && !opts.latest) {
    const s = findBySessionId(current);
    if (s) return s;
    console.error(`Note: current session ${current} not found under ${projectsRoot()}; using the latest session.`);
  }
  const latest = findLatest();
  if (!latest) throw new Error(`No Claude Code sessions found under ${projectsRoot()}.`);
  return latest;
}

// Without a [dir], --index and --rebuild work on the current session's receipts
// folder inside Claude Code (whose shell may have cd'd into a subfolder), else
// on ./.claude-receipts.
function defaultReceiptsDir() {
  const current = process.env.CLAUDE_CODE_SESSION_ID && findBySessionId(process.env.CLAUDE_CODE_SESSION_ID);
  const cwd = current && parseSessionFile(current.file).records.find((r) => r.cwd)?.cwd;
  return join(cwd || process.cwd(), '.claude-receipts');
}

function openFile(path) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', path] : [path];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}

const fmtCost = (n) => '$' + ((n || 0) >= 1 ? (n || 0).toFixed(2) : (n || 0).toFixed(4));

// Human-readable, scannable filename: 2026-05-31_run-nightly-sync_2482b37c
function receiptBasename(meta, view, sessionId) {
  const d = new Date(view.startedAt ?? view.generatedAt);
  const pad = (x) => String(x).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const slug =
    (meta.title || 'session')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'session';
  return `${date}_${slug}_${sessionId.slice(0, 8)}`;
}

// A receipt's file name as index.json records it: a plain name, never a path,
// so an edited index.json can't make us write outside the folder.
const RECEIPT_FILE = /^[\w.-]+\.html$/;

// The file name this session's receipt already has in `dir`, if any — so a
// session renamed later keeps (and overwrites) its files instead of orphaning them.
function existingBase(dir, sessionId) {
  const file = loadManifest(dir)[sessionId]?.htmlFile;
  return RECEIPT_FILE.test(file ?? '') ? file.replace(/\.html$/, '') : null;
}

// Build one session's receipt and write it (plus its index entry). `outDir` and
// `base` override the session's own folder and the title-based file name.
function writeReceipt(session, opts, { outDir, base } = {}) {
  const { records, parseErrors } = parseSessionFile(session.file);
  const meta = extractMeta(records, session.sessionId);

  const mainAgg = aggregate(records);

  // Optionally roll up nested sub-agent transcripts as a separate line + total.
  let subagentView = null;
  let agg = mainAgg;
  if (opts.subagents) {
    const subFiles = findSubagentFiles(session.file);
    if (subFiles.length) {
      const subAggs = subFiles.map((f) => aggregate(parseSessionFile(f).records));
      const subMerged = mergeAggregates(subAggs);
      const subV = buildView({ ...meta, title: 'sub-agents' }, subMerged);
      subagentView = { totalTokens: subV.totalTokens, totalCost: subV.totalCost };
      agg = mergeAggregates([mainAgg, subMerged]);
    }
  }

  const view = buildView(meta, agg, { subagent: subagentView });
  const md = renderMarkdown(view);
  const html = renderHtml(view);

  // Per-project by default: write into the folder of the project the session
  // belongs to (its recorded cwd), regardless of where this command runs from.
  outDir ??= opts.out
    ? resolve(opts.out)
    : join(meta.cwd || process.cwd(), '.claude-receipts');
  mkdirSync(outDir, { recursive: true });
  base ??= existingBase(outDir, session.sessionId) ?? receiptBasename(meta, view, session.sessionId);
  const mdPath = join(outDir, `${base}.md`);
  const htmlPath = join(outDir, `${base}.html`);
  writeFileSync(mdPath, md, 'utf8');
  writeFileSync(htmlPath, html, 'utf8');

  if (!opts.noIndex) {
    updateIndex(outDir, {
      sessionId: session.sessionId,
      title: meta.title,
      project: meta.project,
      startedAt: view.startedAt,
      durationMs: view.durationMs,
      totalTokens: view.totalTokens,
      totalCost: view.totalCost,
      htmlFile: `${base}.html`,
      mdFile: `${base}.md`,
      generatedAt: view.generatedAt,
    });
  }

  return { meta, view, parseErrors, mdPath, htmlPath };
}

// Regenerate every receipt listed in a folder's index.json, in place. Sessions
// whose transcript is gone (Claude Code prunes old ones) keep their receipt.
function rebuildReceipts(dir, opts) {
  const entries = Object.values(loadManifest(dir));
  const sessions = new Map(listSessions().map((s) => [s.sessionId, s]));
  let rebuilt = 0;
  for (const e of entries) {
    if (!RECEIPT_FILE.test(e.htmlFile)) {
      console.log(`  skipped  ${JSON.stringify(e.htmlFile)} (invalid file name)`);
      continue;
    }
    const session = sessions.get(e.sessionId);
    if (!session) {
      console.log(`  kept     ${e.htmlFile} (transcript not found)`);
      continue;
    }
    const { view } = writeReceipt(session, opts, { outDir: dir, base: e.htmlFile.replace(/\.html$/, '') });
    console.log(`  rebuilt  ${e.htmlFile}  ${fmtCost(e.totalCost)} → ${fmtCost(view.totalCost)}`);
    rebuilt++;
  }
  return { rebuilt, total: entries.length };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return printHelp();
  if (opts.version) return console.log(version());

  // SessionEnd hook: read the payload Claude Code pipes on stdin. It includes
  // `transcript_path` pointing at the exact .jsonl for the session that ended.
  if (opts.hook) {
    let payload = {};
    try {
      payload = JSON.parse(readFileSync(0, 'utf8'));
    } catch {}
    if (payload.transcript_path) opts.file = payload.transcript_path;
    if (!opts.file || !existsSync(opts.file)) process.exit(0); // nothing to do
  }

  if (opts.index) {
    const dir = resolve(opts.dir || defaultReceiptsDir());
    if (!existsSync(dir)) throw new Error(`No receipts folder at ${dir}`);
    const n = rebuildIndex(dir);
    console.log(`Rebuilt index for ${n} receipt(s): ${join(dir, 'index.html')}`);
    return;
  }

  if (opts.rebuild) {
    const dir = resolve(opts.dir || defaultReceiptsDir());
    if (!existsSync(dir)) throw new Error(`No receipts folder at ${dir}`);
    const { rebuilt, total } = rebuildReceipts(dir, { ...opts, noIndex: false });
    console.log(`Rebuilt ${rebuilt} of ${total} receipt(s): ${join(dir, 'index.html')}`);
    return;
  }

  if (opts.list) {
    const sessions = listSessions();
    if (!sessions.length) return console.log(`No sessions found under ${projectsRoot()}.`);
    const shown = sessions.slice(0, 50);
    console.log(`Found ${sessions.length} session(s)${shown.length < sessions.length ? `, showing the ${shown.length} most recent` : ''}:\n`);
    for (const s of shown) {
      const { records } = parseSessionFile(s.file);
      const meta = extractMeta(records, s.sessionId);
      console.log(`  ${fmtDateTime(s.mtimeMs)}  ${meta.project ?? '?'}  —  ${meta.title}`);
      console.log(`                    ${s.sessionId}`);
    }
    return;
  }

  const session = pickSession(opts);
  const { meta, view, parseErrors, mdPath, htmlPath } = writeReceipt(session, opts);

  if (opts.hook) {
    console.log(`claude-receipt: ${meta.title} → ${htmlPath}`);
  } else {
    console.log(`Receipt for: ${meta.title}  [${session.sessionId.slice(0, 8)}]`);
    console.log(`  ${view.totalTokens.toLocaleString('en-US')} tokens · est. ${fmtCost(view.totalCost)}`);
    if (parseErrors) console.log(`  (skipped ${parseErrors} unparseable line(s) — session may be live)`);
    console.log(`  ${mdPath}`);
    console.log(`  ${htmlPath}`);
  }

  if (opts.open) openFile(htmlPath);
}

try {
  main();
} catch (err) {
  if (process.argv.includes('--hook')) process.exit(0); // never disrupt session end
  console.error(`Error: ${err.message}`);
  if (err instanceof UsageError) {
    console.error('Run with --help to see the options.');
    process.exit(2);
  }
  process.exit(1);
}
