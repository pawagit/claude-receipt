// Building the receipt view-model and rendering it to Markdown + HTML.

import { costFor } from './pricing.js';
import { activeTime } from './aggregate.js';
import { renderQrSvg, Ecc } from './qrcode.js';
import { truncate } from './text.js';

const fmtInt = (n) => Math.round(n).toLocaleString('en-US');
const fmtMoney = (n) => '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(4));
const mdCell = (s) => String(s).replace(/\|/g, '\\|'); // a `|` would end the table cell

// --- Claude Code brand logo -------------------------------------------------
// The official Claude Code mark (assets/claudecode-color.svg): a clay-coloured robot
// silhouette. The source SVG cuts the eyes out as transparent holes; here we
// draw the body solid and overlay two black eye rects so the eyes read black
// on any background. viewBox is cropped to the artwork (y 5..20).
const BRAND_ICON_SVG =
  '<svg class="brand" xmlns="http://www.w3.org/2000/svg" viewBox="0 5 24 15" role="img" aria-label="Claude Code">' +
  '<title>Claude Code</title>' +
  '<path fill="#d97757" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949z"/>' +
  '<rect x="6" y="8.102" width="1.488" height="2.847" fill="#1a1a1a"/>' +
  '<rect x="16.51" y="8.102" width="1.49" height="2.847" fill="#1a1a1a"/>' +
  '</svg>';

// A monospace block-art rendition of the mark for the Markdown header.
const BRAND_ICON_ASCII = [
  '▐▛███▜▌',
  '▜█████▛▘',
  '▘▘ ▝▝',
];

// Compact, human-readable summary encoded into the QR code.
function buildQrPayload(v) {
  const m = v.meta;
  const lines = ['CLAUDE CODE · RECEIPT'];
  lines.push(truncate(m.title, 60));
  if (m.project) lines.push(m.project + (m.gitBranch ? ' · ' + m.gitBranch : ''));
  if (m.version) lines.push('CC ' + m.version);
  lines.push(`${fmtDateTime(v.startedAt)} · ${fmtDuration(v.durationMs)}`);
  lines.push(`${v.userPrompts}p · ${v.assistantResponses}t · ${v.toolCalls}x`);
  lines.push(`TOKENS ${fmtInt(v.totalTokens)}`);
  lines.push(`EST ${fmtMoney(v.totalCost)}`);
  lines.push(`session ${m.sessionId}`);
  return lines.join('\n');
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Active time, plus wall time when idle pauses make the two differ a lot.
function fmtDurationLine(v) {
  const active = fmtDuration(v.durationMs);
  return v.wallMs > 1.5 * v.durationMs && v.wallMs - v.durationMs >= 60_000
    ? `${active} active (wall ${fmtDuration(v.wallMs)})`
    : active;
}

function fmtDateTime(ms) {
  if (ms == null) return '—';
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Combine meta + aggregate + pricing into a flat structure both renderers use.
export function buildView(meta, agg, { subagent } = {}) {
  const models = [];
  let totalTokens = 0;
  let totalCost = 0;
  let anyUnknownCost = false;
  let webSearch = 0;
  let webFetch = 0;

  for (const [name, b] of Object.entries(agg.models)) {
    const cost = costFor(name, b);
    if (!cost.known) anyUnknownCost = true;
    const tokens = b.input + b.output + b.cacheWrite5m + b.cacheWrite1h + b.cacheRead;
    totalTokens += tokens;
    totalCost += cost.total;
    webSearch += b.webSearch;
    webFetch += b.webFetch;
    models.push({
      name,
      responses: b.responses,
      input: b.input,
      output: b.output,
      cacheWrite: b.cacheWrite5m + b.cacheWrite1h,
      cacheRead: b.cacheRead,
      tokens,
      cost,
    });
  }
  models.sort((a, b) => b.tokens - a.tokens);
  const { activeMs, wallMs } = activeTime(agg.timestamps ?? []);

  return {
    meta,
    models,
    totalTokens,
    totalCost,
    anyUnknownCost,
    webSearch,
    webFetch,
    toolCalls: agg.toolCalls,
    userPrompts: agg.userPrompts,
    assistantResponses: agg.assistantResponses,
    durationMs: activeMs, // active time; idle pauses over 30 min are left out
    wallMs,
    startedAt: agg.firstTs,
    endedAt: agg.lastTs,
    subagent: subagent || null, // optional rolled-up sub-agent line
    generatedAt: Date.now(),
  };
}

export function renderMarkdown(v) {
  const m = v.meta;
  const L = [];
  L.push('```');
  for (const line of BRAND_ICON_ASCII) L.push('                      ' + line);
  L.push('');
  L.push('      C L A U D E   C O D E   ·   R E C E I P T');
  L.push('```');
  L.push(`### ${m.title}`);
  L.push('');
  L.push(`| | |`);
  L.push(`|---|---|`);
  if (m.project) L.push(`| **Project** | ${mdCell(m.project)}${m.gitBranch ? ` (${mdCell(m.gitBranch)})` : ''} |`);
  if (m.version) L.push(`| **CC version** | ${mdCell(m.version)} |`);
  L.push(`| **Started** | ${fmtDateTime(v.startedAt)} |`);
  L.push(`| **Duration** | ${fmtDurationLine(v)} |`);
  L.push(`| **Prompts · Turns · Tools** | ${v.userPrompts} · ${v.assistantResponses} · ${v.toolCalls} |`);
  if (v.webSearch || v.webFetch) L.push(`| **Web search · fetch** | ${v.webSearch} · ${v.webFetch} |`);
  L.push('');
  L.push('#### Line items');
  L.push('');
  L.push('| Model | Input | Output | Cache write | Cache read | Est. cost |');
  L.push('|---|--:|--:|--:|--:|--:|');
  for (const md of v.models) {
    L.push(
      `| \`${mdCell(md.name)}\` | ${fmtInt(md.input)} | ${fmtInt(md.output)} | ${fmtInt(md.cacheWrite)} | ${fmtInt(md.cacheRead)} | ${md.cost.known ? fmtMoney(md.cost.total) : 'n/a'} |`,
    );
  }
  L.push('');
  if (v.subagent && v.subagent.totalTokens > 0) {
    L.push(`> Includes sub-agents: ${fmtInt(v.subagent.totalTokens)} tokens · ${fmtMoney(v.subagent.totalCost)} est.`);
    L.push('');
  }
  L.push(`**TOTAL** — ${fmtInt(v.totalTokens)} tokens`);
  L.push('');
  L.push(`**ESTIMATED EQUIVALENT API COST — ${fmtMoney(v.totalCost)}**${v.anyUnknownCost ? ' (excludes models with no price)' : ''}`);
  L.push('');
  L.push('---');
  L.push(`<sub>session \`${m.sessionId}\` · generated ${fmtDateTime(v.generatedAt)} · cost is a per-token estimate, not money billed</sub>`);
  L.push('');
  return L.join('\n');
}

export function renderHtml(v) {
  const m = v.meta;
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const rows = v.models
    .map(
      (md) => `
      <div class="item">
        <div class="item-name">${esc(md.name)}</div>
        <div class="line"><span>Input</span><span>${fmtInt(md.input)}</span></div>
        <div class="line"><span>Output</span><span>${fmtInt(md.output)}</span></div>
        <div class="line"><span>Cache write</span><span>${fmtInt(md.cacheWrite)}</span></div>
        <div class="line"><span>Cache read</span><span>${fmtInt(md.cacheRead)}</span></div>
        <div class="line subtotal"><span>Subtotal</span><span>${md.cost.known ? fmtMoney(md.cost.total) : 'n/a'}</span></div>
      </div>`,
    )
    .join('');

  const subagentLine =
    v.subagent && v.subagent.totalTokens > 0
      ? `<div class="line"><span>Sub-agents</span><span>${fmtInt(v.subagent.totalTokens)} tok · ${fmtMoney(v.subagent.totalCost)}</span></div>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Code Receipt — ${esc(m.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 24px; background: #e9e9e6; font-family: "Courier New", ui-monospace, monospace; }
  .receipt { max-width: 380px; margin: 0 auto; background: #fffdf7; color: #1a1a1a;
    padding: 24px 26px; box-shadow: 0 2px 14px rgba(0,0,0,.18);
    background-image: repeating-linear-gradient(0deg, transparent, transparent 27px, rgba(0,0,0,.025) 28px); }
  h1 { font-size: 13px; letter-spacing: 3px; text-align: center; margin: 0 0 2px; }
  .sub { text-align: center; font-size: 11px; color: #666; margin-bottom: 14px; }
  .title { text-align: center; font-weight: bold; font-size: 15px; margin: 10px 0 14px; }
  .hr { border: none; border-top: 1px dashed #999; margin: 12px 0; }
  .meta .line, .totals .line, .item .line { display: flex; justify-content: space-between; font-size: 12.5px; line-height: 1.7; }
  .meta .line span:first-child { color: #555; }
  .item-name { font-weight: bold; font-size: 12.5px; margin-top: 8px; }
  .item .line span:first-child { padding-left: 10px; color: #555; }
  .subtotal span { font-weight: bold; color: #1a1a1a !important; }
  .totals .grand { display: flex; justify-content: space-between; font-weight: bold; font-size: 15px; margin-top: 6px; }
  .totals .tokens { display: flex; justify-content: space-between; font-size: 13px; }
  .foot { text-align: center; font-size: 10.5px; color: #777; margin-top: 16px; line-height: 1.5; }
  .brand { display: block; width: 46px; height: auto; margin: 0 auto 8px; }
  .qr { display: flex; justify-content: center; margin: 16px 0 2px; }
  .qr svg { width: 134px; height: 134px; }
  .qrcap { text-align: center; font-size: 9.5px; letter-spacing: 1.5px; text-transform: uppercase; color: #999; }
</style>
</head>
<body>
  <div class="receipt">
    ${BRAND_ICON_SVG}
    <h1>CLAUDE&nbsp;CODE</h1>
    <div class="sub">* * *  R E C E I P T  * * *</div>
    <div class="title">${esc(m.title)}</div>
    <hr class="hr">
    <div class="meta">
      ${m.project ? `<div class="line"><span>Project</span><span>${esc(m.project)}${m.gitBranch ? ' · ' + esc(m.gitBranch) : ''}</span></div>` : ''}
      ${m.version ? `<div class="line"><span>CC version</span><span>${esc(m.version)}</span></div>` : ''}
      <div class="line"><span>Date</span><span>${fmtDateTime(v.startedAt)}</span></div>
      <div class="line"><span>Duration</span><span>${fmtDurationLine(v)}</span></div>
      <div class="line"><span>Prompts · Turns · Tools</span><span>${v.userPrompts} · ${v.assistantResponses} · ${v.toolCalls}</span></div>
      ${v.webSearch || v.webFetch ? `<div class="line"><span>Web search · fetch</span><span>${v.webSearch} · ${v.webFetch}</span></div>` : ''}
    </div>
    <hr class="hr">
    <div class="items">${rows || '<div class="line"><span>No billable usage found</span><span></span></div>'}</div>
    <hr class="hr">
    <div class="totals">
      ${subagentLine}
      <div class="tokens"><span>TOTAL TOKENS</span><span>${fmtInt(v.totalTokens)}</span></div>
      <div class="grand"><span>EST. COST</span><span>${fmtMoney(v.totalCost)}</span></div>
    </div>
    <div class="qr">${renderQrSvg(buildQrPayload(v), { ecl: Ecc.MEDIUM, dark: '#1a1a1a', light: '#ffffff', border: 4 })}</div>
    <div class="qrcap">scan for session details</div>
    <div class="foot">
      ${v.anyUnknownCost ? 'cost excludes models with no price<br>' : ''}
      estimated equivalent API cost — not money billed<br>
      session ${esc(m.sessionId)}<br>
      generated ${fmtDateTime(v.generatedAt)}<br>
      ~ thank you for vibe coding ~
    </div>
  </div>
</body>
</html>
`;
}
