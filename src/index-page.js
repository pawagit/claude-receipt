// A folder-level index of all receipts. Each receipt run upserts an entry into
// `<dir>/index.json` (keyed by session id) and re-renders `<dir>/index.html`
// from it — so the index is incremental, accurate, and cheap to maintain.
//
// Several sessions can end at once (closing a window with many Claude panels
// runs the hook for each), so updates take a lock file and every write lands
// via a temp file + rename. Each receipt's HTML also embeds its own entry
// (RECEIPT_DATA_ID), so a corrupt or lost index.json can be rebuilt from the
// receipt files instead of being silently replaced.

import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, openSync, closeSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST = 'index.json';
const LOCK = 'index.lock';
// A receipt's file name as index.json records it: a plain name, never a path,
// so an edited index.json can't make us read or write outside the folder.
export const RECEIPT_FILE = /^[\w.-]+\.html$/;
export const RECEIPT_DATA_ID = 'claude-receipt';
const RECEIPT_DATA = new RegExp(`<script type="application/json" id="${RECEIPT_DATA_ID}">([\\s\\S]*?)</script>`);

const fmtInt = (n) => Math.round(n || 0).toLocaleString('en-US');
const fmtMoney = (n) => '$' + ((n || 0) >= 1 ? (n || 0).toFixed(2) : (n || 0).toFixed(4));

function fmtDate(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The folder's entries, and whether index.json was corrupt (then the entries
// come from the receipt files themselves).
function readManifest(dir) {
  const p = join(dir, MANIFEST);
  if (!existsSync(p)) return { entries: {}, corrupt: false };
  try {
    return { entries: JSON.parse(readFileSync(p, 'utf8')).entries || {}, corrupt: false };
  } catch {
    return { entries: entriesFromReceipts(dir), corrupt: true };
  }
}

// Entries keyed by session id. Never an empty stand-in for a corrupt file.
export function loadManifest(dir) {
  return readManifest(dir).entries;
}

// The entries embedded in the folder's receipt files (receipts written by
// v1.1.0 or later carry one).
function entriesFromReceipts(dir) {
  const entries = {};
  for (const file of readdirSync(dir)) {
    if (file === 'index.html' || !RECEIPT_FILE.test(file)) continue;
    const m = readFileSync(join(dir, file), 'utf8').match(RECEIPT_DATA);
    if (!m) continue;
    try {
      const e = JSON.parse(m[1]);
      if (e.sessionId) entries[e.sessionId] = { ...e, htmlFile: file };
    } catch {}
  }
  return entries;
}

// Serialise read-modify-write of index.json across processes. A lock older
// than 30 s is left over from a crash and is taken over.
function withLock(dir, fn) {
  const lock = join(dir, LOCK);
  const deadline = Date.now() + 5000;
  let fd;
  for (;;) {
    try {
      fd = openSync(lock, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST' && err.code !== 'EPERM') throw err; // EPERM: a lock being deleted (Windows)
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error(`${lock} is held by another process; delete it if nothing is running`);
      sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

// Write via a temp file + rename, so a reader never sees half a file. Windows
// refuses the rename for a moment while another process has the target open.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(tmp, file);
    } catch (err) {
      if (attempt >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        rmSync(tmp, { force: true });
        throw err;
      }
      sleep(25);
    }
  }
}

function writeIndex(dir, entries) {
  writeAtomic(join(dir, MANIFEST), JSON.stringify({ entries }, null, 2));
  writeAtomic(join(dir, 'index.html'), renderIndexHtml(Object.values(entries)));
}

// A corrupt index.json is kept beside the new one, never overwritten.
function setAsideIfCorrupt(dir, corrupt) {
  if (corrupt) renameSync(join(dir, MANIFEST), join(dir, `${MANIFEST}.corrupt-${Date.now()}`));
}

// Upsert one session's entry and rewrite index.json + index.html.
export function updateIndex(dir, entry) {
  withLock(dir, () => {
    const { entries, corrupt } = readManifest(dir);
    setAsideIfCorrupt(dir, corrupt);
    entries[entry.sessionId] = entry;
    writeIndex(dir, entries);
  });
}

// Rebuild index.json + index.html from what is in the folder: entries whose
// receipt file is gone are dropped, and receipts the index lost are added back.
export function rebuildIndex(dir) {
  return withLock(dir, () => {
    const { entries, corrupt } = readManifest(dir);
    setAsideIfCorrupt(dir, corrupt);
    const all = { ...entriesFromReceipts(dir), ...entries };
    const kept = Object.fromEntries(
      Object.entries(all).filter(([, e]) => RECEIPT_FILE.test(e.htmlFile ?? '') && existsSync(join(dir, e.htmlFile))),
    );
    writeIndex(dir, kept);
    return Object.keys(kept).length;
  });
}

// The <script> block a receipt's HTML carries its index entry in.
export function receiptDataScript(entry) {
  const json = JSON.stringify(entry).replace(/</g, '\\u003c'); // no "</script>" inside
  return `<script type="application/json" id="${RECEIPT_DATA_ID}">${json}</script>`;
}

export function renderIndexHtml(entries) {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const list = entries.slice().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const totalTokens = list.reduce((s, e) => s + (e.totalTokens || 0), 0);
  const totalCost = list.reduce((s, e) => s + (e.totalCost || 0), 0);

  const rows = list
    .map(
      (e) => `
      <tr>
        <td class="date">${fmtDate(e.startedAt)}</td>
        <td><a href="./${esc(e.htmlFile)}">${esc(e.title)}</a>${e.project ? `<div class="proj">${esc(e.project)}</div>` : ''}</td>
        <td class="num">${fmtDuration(e.durationMs)}</td>
        <td class="num">${fmtInt(e.totalTokens)}</td>
        <td class="num">${fmtMoney(e.totalCost)}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code Receipts</title>
<style>
  body { margin: 0; background: #f3f3f0; color: #1a1a1a; padding: 32px;
    font: 14px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif; }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: #666; margin: 0 0 20px; font-size: 13px; }
  .cards { display: flex; gap: 14px; margin-bottom: 22px; flex-wrap: wrap; }
  .card { background: #fff; border: 1px solid #e3e3df; border-radius: 10px; padding: 12px 16px; min-width: 120px; }
  .card .k { font-size: 11px; color: #777; text-transform: uppercase; letter-spacing: .04em; }
  .card .v { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .tablewrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e3e3df; border-radius: 10px; overflow: hidden; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
  th { background: #fafafa; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #777; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.date { color: #666; white-space: nowrap; font-variant-numeric: tabular-nums; }
  a { color: #b5532a; text-decoration: none; font-weight: 600; }
  a:hover { text-decoration: underline; }
  .proj { font-size: 11px; color: #999; font-weight: 400; }
  .empty { padding: 30px; text-align: center; color: #999; }
  .foot { color: #999; font-size: 11px; margin-top: 14px; text-align: center; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Claude Code Receipts</h1>
    <p class="sub">${list.length} session${list.length === 1 ? '' : 's'} in this folder</p>
    <div class="cards">
      <div class="card"><div class="k">Sessions</div><div class="v">${list.length}</div></div>
      <div class="card"><div class="k">Total tokens</div><div class="v">${fmtInt(totalTokens)}</div></div>
      <div class="card"><div class="k">Est. total cost</div><div class="v">${fmtMoney(totalCost)}</div></div>
    </div>
    ${
      list.length
        ? `<div class="tablewrap"><table>
      <thead><tr><th>Date</th><th>Session</th><th class="num">Duration</th><th class="num">Tokens</th><th class="num">Est. cost</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`
        : '<div class="empty">No receipts yet.</div>'
    }
    <p class="foot">estimated equivalent API cost — not money billed</p>
  </div>
</body>
</html>
`;
}
