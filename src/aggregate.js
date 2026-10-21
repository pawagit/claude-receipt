// Turning raw transcript records into a token/usage summary.
//
// THE CRITICAL STEP: a single assistant API response is written to the JSONL as
// multiple lines (one per content block), and every line repeats the `usage`
// object. Summing raw rows multiplies the token count. We therefore dedupe usage
// by message.id + requestId and count it once — from the row with the most
// output tokens, because sub-agent transcripts also write mid-stream snapshots
// (stop_reason null, a handful of output tokens) before the final row.

import { tierFor } from './pricing.js';
import { truncate } from './text.js';

const SYNTHETIC = (m) => !m || m.startsWith('<'); // '<synthetic>', etc. — not billable
// User-role records that no person typed: background-task notices, `!` shell
// commands, local command output, and interrupt markers.
const NOT_TYPED = /^\s*(<task-notification>|<bash-|<local-command-|Caveat:|\[Request interrupted)/;
const IDLE_GAP_MS = 30 * 60_000; // a longer pause between records isn't active time
const TIER_LABELS = { fast: 'fast', long: 'long context' };

// One bucket per model and price tier: fast-mode and long-context responses
// cost more, so they get their own line (`claude-opus-5-5 · fast`).
function bucketKey(model, tier) {
  return tier ? `${model} · ${TIER_LABELS[tier]}` : model;
}

function emptyModelBucket(model, tier) {
  return {
    model,
    tier,
    responses: 0,
    input: 0,
    output: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    webSearch: 0,
    webFetch: 0,
  };
}

// Aggregate one set of records (a main session, or a sub-agent transcript).
export function aggregate(records) {
  const models = {};
  const responses = new Map(); // message.id|requestId -> { model, usage } of its final row
  const seenToolUseIds = new Set(); // tool_use block id -> dedupe tool calls
  const timestamps = [];
  let toolCalls = 0;
  let userPrompts = 0;
  let pendingPrompts = 0; // typed prompts not yet answered by a billed response
  let firstTs = null;
  let lastTs = null;

  for (const rec of records) {
    if (rec.timestamp) {
      const t = Date.parse(rec.timestamp);
      if (!Number.isNaN(t)) {
        timestamps.push(t);
        if (firstTs === null || t < firstTs) firstTs = t;
        if (lastTs === null || t > lastTs) lastTs = t;
      }
    }

    if (rec.type === 'user') {
      if (isTypedPrompt(rec)) pendingPrompts++;
      continue;
    }

    if (rec.type !== 'assistant') continue;

    const msg = rec.message || {};
    const model = msg.model;

    // Count tool calls from every assistant row, deduped by block id, so we are
    // robust to however the rows are split.
    for (const block of asArray(msg.content)) {
      if (block && block.type === 'tool_use') {
        const id = block.id || `${msg.id}:${block.name}`;
        if (!seenToolUseIds.has(id)) {
          seenToolUseIds.add(id);
          toolCalls++;
        }
      }
    }

    // Usage: one entry per API response (synthetic/system rows aren't billed),
    // keeping the row with the most output tokens; ties go to the later row.
    if (SYNTHETIC(model) || !msg.usage) continue;
    // A prompt counts once Claude answers it (`/exit`, `/model` etc. get no answer).
    userPrompts += pendingPrompts;
    pendingPrompts = 0;
    const key = msg.id || rec.requestId ? `${msg.id || ''}|${rec.requestId || ''}` : rec.uuid;
    const prev = responses.get(key);
    if (!prev || (msg.usage.output_tokens || 0) >= (prev.usage.output_tokens || 0)) {
      responses.set(key, { model, usage: msg.usage });
    }
  }

  for (const { model, usage: u } of responses.values()) {
    const tier = tierFor(model, u);
    const bucket = (models[bucketKey(model, tier)] ??= emptyModelBucket(model, tier));
    bucket.responses++;
    bucket.input += u.input_tokens || 0;
    bucket.output += u.output_tokens || 0;
    bucket.cacheRead += u.cache_read_input_tokens || 0;

    const cc = u.cache_creation;
    if (cc && (cc.ephemeral_5m_input_tokens || cc.ephemeral_1h_input_tokens)) {
      bucket.cacheWrite5m += cc.ephemeral_5m_input_tokens || 0;
      bucket.cacheWrite1h += cc.ephemeral_1h_input_tokens || 0;
    } else {
      // No breakdown available — attribute creation tokens to the 5m tier.
      bucket.cacheWrite5m += u.cache_creation_input_tokens || 0;
    }

    const stu = u.server_tool_use;
    if (stu) {
      bucket.webSearch += stu.web_search_requests || 0;
      bucket.webFetch += stu.web_fetch_requests || 0;
    }
  }

  return {
    models,
    toolCalls,
    userPrompts,
    assistantResponses: responses.size,
    firstTs,
    lastTs,
    timestamps,
  };
}

// Active time from record timestamps: the sum of the gaps between consecutive
// records, skipping pauses longer than IDLE_GAP_MS (a session left open
// overnight isn't 14 hours of work). Wall time is first to last record.
export function activeTime(timestamps) {
  const ts = [...timestamps].sort((a, b) => a - b);
  let activeMs = 0;
  for (let i = 1; i < ts.length; i++) {
    const gap = ts[i] - ts[i - 1];
    if (gap <= IDLE_GAP_MS) activeMs += gap;
  }
  return { activeMs, wallMs: ts.length ? ts[ts.length - 1] - ts[0] : 0 };
}

// Session metadata (title, project, branch, version) pulled from the records.
// Title: a name set with /rename, else Claude Code's AI title, else the last prompt.
export function extractMeta(records, sessionId) {
  let customTitle = null;
  let aiTitle = null;
  let lastPrompt = null;
  let cwd = null;
  let gitBranch = null;
  let version = null;

  for (const rec of records) {
    if (rec.type === 'custom-title' && rec.customTitle) customTitle = rec.customTitle;
    if (rec.type === 'ai-title' && rec.aiTitle) aiTitle = rec.aiTitle;
    if (rec.type === 'last-prompt' && rec.lastPrompt) lastPrompt = rec.lastPrompt;
    if (cwd === null && rec.cwd) cwd = rec.cwd;
    if (gitBranch === null && rec.gitBranch) gitBranch = rec.gitBranch;
    if (version === null && rec.version) version = rec.version;
  }

  const title = customTitle || aiTitle || (lastPrompt && truncate(lastPrompt.replace(/\s+/g, ' ').trim(), 60));

  return {
    sessionId,
    title: title || '(untitled session)',
    cwd,
    project: cwd ? basename(cwd) : null,
    gitBranch,
    version,
  };
}

// Merge several aggregates (e.g. main session + sub-agent transcripts).
export function mergeAggregates(parts) {
  const merged = {
    models: {},
    toolCalls: 0,
    userPrompts: 0,
    assistantResponses: 0,
    firstTs: null,
    lastTs: null,
    timestamps: [],
  };
  for (const p of parts) {
    merged.toolCalls += p.toolCalls;
    merged.userPrompts += p.userPrompts;
    merged.assistantResponses += p.assistantResponses;
    merged.timestamps.push(...(p.timestamps ?? []));
    if (p.firstTs !== null)
      merged.firstTs = merged.firstTs === null ? p.firstTs : Math.min(merged.firstTs, p.firstTs);
    if (p.lastTs !== null)
      merged.lastTs = merged.lastTs === null ? p.lastTs : Math.max(merged.lastTs, p.lastTs);
    for (const [key, b] of Object.entries(p.models)) {
      const t = (merged.models[key] ??= emptyModelBucket(b.model ?? key, b.tier ?? ''));
      t.responses += b.responses;
      t.input += b.input;
      t.output += b.output;
      t.cacheWrite5m += b.cacheWrite5m;
      t.cacheWrite1h += b.cacheWrite1h;
      t.cacheRead += b.cacheRead;
      t.webSearch += b.webSearch;
      t.webFetch += b.webFetch;
    }
  }
  return merged;
}

function asArray(content) {
  return Array.isArray(content) ? content : [];
}

// A prompt a person typed (a slash command like `/review` included). Not tool
// results, not Claude Code's own injected (isMeta) messages or compaction
// summaries, and not a sub-agent's task prompt (sidechain records).
function isTypedPrompt(rec) {
  if (rec.isMeta || rec.isCompactSummary || rec.isSidechain) return false;
  const c = rec.message?.content;
  let text;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c) && !c.some((b) => b && b.type === 'tool_result')) {
    text = c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  }
  return !!text && text.trim().length > 0 && !NOT_TYPED.test(text);
}

function basename(p) {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}
