// Turning raw transcript records into a token/usage summary.
//
// THE CRITICAL STEP: a single assistant API response is written to the JSONL as
// multiple lines (one per content block), and every line repeats the `usage`
// object. Summing raw rows multiplies the token count. We therefore dedupe usage
// by message.id + requestId and count it once — from the row with the most
// output tokens, because sub-agent transcripts also write mid-stream snapshots
// (stop_reason null, a handful of output tokens) before the final row.

import { tierFor } from './pricing.js';

const SYNTHETIC = (m) => !m || m.startsWith('<'); // '<synthetic>', etc. — not billable
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
  let toolCalls = 0;
  let userPrompts = 0;
  let firstTs = null;
  let lastTs = null;

  for (const rec of records) {
    if (rec.timestamp) {
      const t = Date.parse(rec.timestamp);
      if (!Number.isNaN(t)) {
        if (firstTs === null || t < firstTs) firstTs = t;
        if (lastTs === null || t > lastTs) lastTs = t;
      }
    }

    if (rec.type === 'user') {
      if (isHumanPrompt(rec.message)) userPrompts++;
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
  };
}

// Session metadata (title, project, branch, version) pulled from the records.
export function extractMeta(records, sessionId) {
  let title = null;
  let lastPrompt = null;
  let cwd = null;
  let gitBranch = null;
  let version = null;

  for (const rec of records) {
    if (rec.type === 'ai-title' && rec.aiTitle) title = rec.aiTitle;
    if (rec.type === 'last-prompt' && rec.lastPrompt) lastPrompt = rec.lastPrompt;
    if (cwd === null && rec.cwd) cwd = rec.cwd;
    if (gitBranch === null && rec.gitBranch) gitBranch = rec.gitBranch;
    if (version === null && rec.version) version = rec.version;
  }

  if (!title && lastPrompt) {
    title = lastPrompt.length > 60 ? lastPrompt.slice(0, 57) + '…' : lastPrompt;
  }

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
  };
  for (const p of parts) {
    merged.toolCalls += p.toolCalls;
    merged.userPrompts += p.userPrompts;
    merged.assistantResponses += p.assistantResponses;
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

function isHumanPrompt(message) {
  if (!message) return false;
  const c = message.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (!Array.isArray(c)) return false;
  const hasText = c.some((b) => b && b.type === 'text');
  const hasToolResult = c.some((b) => b && b.type === 'tool_result');
  return hasText && !hasToolResult;
}

function basename(p) {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}
