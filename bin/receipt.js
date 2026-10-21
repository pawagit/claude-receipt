#!/usr/bin/env node
// claude-receipt — generate a Markdown + HTML receipt for a Claude Code session.
//
// Usage:
//   node bin/receipt.js                 # latest session anywhere
//   node bin/receipt.js --session <id>  # a specific session id
//   node bin/receipt.js --project <dir> # latest session whose cwd matches <dir>
//   node bin/receipt.js --list          # list available sessions
//   node bin/receipt.js --out <dir>     # output directory (default ./.claude-receipts)
//   node bin/receipt.js --no-subagents  # exclude nested sub-agent token spend
//   node bin/receipt.js --open          # open the HTML when done
//   node bin/receipt.js --rebuild [dir] # regenerate every receipt in a folder (new prices)

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';

import { listSessions, findLatest, findBySessionId } from '../src/discover.js';
import { parseSessionFile, findSubagentFiles } from '../src/parse.js';
import { aggregate, extractMeta, mergeAggregates } from '../src/aggregate.js';
import { buildView, renderMarkdown, renderHtml } from '../src/render.js';
import { updateIndex, rebuildIndex, loadManifest } from '../src/index-page.js';

function parseArgs(argv) {
  const opts = { out: null, open: false, list: false, subagents: true, session: null, project: null, file: null, hook: false, index: false, indexDir: null, rebuild: false, rebuildDir: null, noIndex: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--open') opts.open = true;
    else if (a === '--no-subagents') opts.subagents = false;
    else if (a === '--latest') {} // default
    else if (a === '--session') opts.session = argv[++i];
    else if (a === '--project') opts.project = argv[++i];
    else if (a === '--file') opts.file = argv[++i];
    else if (a === '--hook') opts.hook = true;
    else if (a === '--index') { opts.index = true; if (argv[i + 1] && !argv[i + 1].startsWith('-')) opts.indexDir = argv[++i]; }
    else if (a === '--rebuild') { opts.rebuild = true; if (argv[i + 1] && !argv[i + 1].startsWith('-')) opts.rebuildDir = argv[++i]; }
    else if (a === '--no-index') opts.noIndex = true;
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '-h' || a === '--help') opts.help = true;
    else console.error(`Unknown argument: ${a}`);
  }
  return opts;
}

function printHelp() {
  console.log(`claude-receipt — receipts for Claude Code sessions

  (no args)            latest session anywhere
  --session <id>       a specific session id
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
  --open               open the generated HTML
  --help`);
}

function pickSession(opts) {
  if (opts.file) {
    const f = resolve(opts.file);
    if (!existsSync(f)) throw new Error(`File not found: ${f}`);
    return { file: f, sessionId: basename(f).replace(/\.jsonl$/, '') };
  }
  if (opts.session) {
    const s = findBySessionId(opts.session);
    if (!s) throw new Error(`No session found with id "${opts.session}".`);
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
  const latest = findLatest();
  if (!latest) throw new Error('No Claude Code sessions found under ~/.claude/projects.');
  return latest;
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
  base ??= receiptBasename(meta, view, session.sessionId);
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

// A receipt's file name as index.json records it: a plain name, never a path,
// so an edited index.json can't make --rebuild write outside the folder.
const RECEIPT_FILE = /^[\w.-]+\.html$/;

// Regenerate every receipt listed in a folder's index.json, in place. Sessions
// whose transcript is gone (Claude Code prunes old ones) keep their receipt.
function rebuildReceipts(dir, opts) {
  const entries = Object.values(loadManifest(dir));
  let rebuilt = 0;
  for (const e of entries) {
    if (!RECEIPT_FILE.test(e.htmlFile)) {
      console.log(`  skipped  ${JSON.stringify(e.htmlFile)} (invalid file name)`);
      continue;
    }
    const session = findBySessionId(e.sessionId);
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
    const dir = resolve(opts.indexDir || '.claude-receipts');
    if (!existsSync(dir)) throw new Error(`No receipts folder at ${dir}`);
    const n = rebuildIndex(dir);
    console.log(`Rebuilt index for ${n} receipt(s): ${join(dir, 'index.html')}`);
    return;
  }

  if (opts.rebuild) {
    const dir = resolve(opts.rebuildDir || '.claude-receipts');
    if (!existsSync(dir)) throw new Error(`No receipts folder at ${dir}`);
    const { rebuilt, total } = rebuildReceipts(dir, { ...opts, noIndex: false });
    console.log(`Rebuilt ${rebuilt} of ${total} receipt(s): ${join(dir, 'index.html')}`);
    return;
  }

  if (opts.list) {
    const sessions = listSessions();
    if (!sessions.length) return console.log('No sessions found under ~/.claude/projects.');
    console.log(`Found ${sessions.length} session(s):\n`);
    for (const s of sessions.slice(0, 50)) {
      const { records } = parseSessionFile(s.file);
      const meta = extractMeta(records, s.sessionId);
      const when = new Date(s.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
      console.log(`  ${when}  ${meta.project ?? '?'}  —  ${meta.title}`);
      console.log(`            ${s.sessionId}`);
    }
    return;
  }

  const session = pickSession(opts);
  const { meta, view, parseErrors, mdPath, htmlPath } = writeReceipt(session, opts);

  if (opts.hook) {
    console.log(`claude-receipt: ${meta.title} → ${htmlPath}`);
  } else {
    console.log(`Receipt for: ${meta.title}`);
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
  process.exit(1);
}
