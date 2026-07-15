// A folder-level index of all receipts. Each receipt run upserts an entry into
// `<dir>/index.json` (keyed by session id) and re-renders `<dir>/index.html`
// from it — so the index is incremental, accurate, and cheap to maintain.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MANIFEST = 'index.json';

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

export function loadManifest(dir) {
  const p = join(dir, MANIFEST);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')).entries || {};
  } catch {
    return {};
  }
}

// Upsert one session's entry and rewrite index.json + index.html.
export function updateIndex(dir, entry) {
  const entries = loadManifest(dir);
  entries[entry.sessionId] = entry;
  writeFileSync(join(dir, MANIFEST), JSON.stringify({ entries }, null, 2), 'utf8');
  writeFileSync(join(dir, 'index.html'), renderIndexHtml(Object.values(entries)), 'utf8');
}

// Rebuild index.html from an existing index.json (no new receipt generated).
export function rebuildIndex(dir) {
  const entries = Object.values(loadManifest(dir));
  writeFileSync(join(dir, 'index.html'), renderIndexHtml(entries), 'utf8');
  return entries.length;
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
