// Nebius Token Factory client (OpenAI-compatible chat completions) with a
// deterministic mock for offline runs. Every call leaves a receipt with the
// tier, model id, latency and token usage so the UI can show the routing.

import { getConfig } from './config.js';
import { mockChat } from './mockLlm.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiers whose model ran out of max_tokens while reasoning. Later calls to the
// same tier in this process ask for no reasoning straight away.
const NO_THINK = { chat_template_kwargs: { enable_thinking: false } };
const noThinkTiers = new Set();

// True when the whole completion was reasoning. Some Token Factory models put
// that reasoning in content, without <think> tags, when they hit max_tokens.
function allReasoning(usage) {
  const d = usage && usage.completion_tokens_details;
  const r = d && d.reasoning_tokens;
  return typeof r === 'number' && r > 0 && r >= (usage.completion_tokens || 0);
}

export class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function stripThinking(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();
}

export function extractJson(text) {
  if (!text) return null;
  const clean = stripThinking(String(text)).replace(/```(?:json)?/gi, '');
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']';
    let start = clean.indexOf(open);
    while (start !== -1) {
      let depth = 0;
      let inStr = false;
      for (let i = start; i < clean.length; i++) {
        const ch = clean[i];
        if (inStr) {
          if (ch === '\\') i++;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(clean.slice(start, i + 1));
            } catch {
              break;
            }
          }
        }
      }
      start = clean.indexOf(open, start + 1);
    }
  }
  return null;
}

export function createLLM(cfg = getConfig(), { deadline = Infinity } = {}) {
  const receipts = [];
  const left = () => deadline - Date.now();

  async function live(tier, req) {
    const model = cfg.nebius.models[tier];
    let maxTokens = req.maxTokens ?? 1200;
    const notes = [];
    const delays = [800, 2000];
    let lengthRetry = false;
    // Only when NEBIUS_EXTRA_BODY does not already set the chat template.
    const canNoThink = !(cfg.nebius.extraBody && cfg.nebius.extraBody.chat_template_kwargs);
    let noThink = canNoThink && noThinkTiers.has(tier);
    // Tokens from a cut-off attempt are still billed, so they are added in.
    const carried = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, reasoning_tokens: 0 };
    const addUsage = (u) => {
      if (!u) return;
      carried.prompt_tokens += u.prompt_tokens || 0;
      carried.completion_tokens += u.completion_tokens || 0;
      carried.total_tokens += u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0);
      carried.reasoning_tokens += (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0;
    };
    for (let attempt = 0; ; attempt++) {
      // Every step has a time budget so one serverless request never runs past
      // the platform limit. A call that would not fit is not started.
      const timeout = Math.min(cfg.nebius.timeoutMs, left() - 1500);
      if (timeout < Math.min(4000, cfg.nebius.timeoutMs)) {
        const err = new LlmError('the time budget for this step was used up before the call could run', 0);
        err.budget = true;
        throw err;
      }
      const body = {
        model: model.id,
        messages: req.messages,
        temperature: req.temperature ?? 0.3,
        max_tokens: maxTokens,
        ...(req.tools && req.tools.length ? { tools: req.tools, tool_choice: 'auto' } : {}),
        ...(cfg.nebius.extraBody || {}),
        ...(noThink ? NO_THINK : {}),
      };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      let res;
      try {
        res = await fetch(model.baseUrl.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.nebius.apiKey}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < delays.length && left() > delays[attempt] + 6000) {
          notes.push(`retried after ${err.name === 'AbortError' ? 'a timeout' : 'a network error'}`);
          await sleep(delays[attempt]);
          continue;
        }
        throw new LlmError(`Token Factory request failed: ${err.name === 'AbortError' ? `no answer within ${timeout} ms` : err.message}`, 0);
      }
      clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && attempt < delays.length && left() > delays[attempt] + 6000) {
        notes.push(`retried after HTTP ${res.status}`);
        await sleep(delays[attempt]);
        continue;
      }
      if (res.status === 400 && noThink) {
        // The model does not take the template switch. Drop it and go on.
        noThink = false;
        noThinkTiers.delete(tier);
        notes.push('model refused enable_thinking false, retried without it');
        continue;
      }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        throw new LlmError(`Token Factory ${model.id} returned ${res.status}: ${text}`, res.status);
      }
      const data = await res.json();
      const choice = (data.choices && data.choices[0]) || {};
      const msg = choice.message || { role: 'assistant', content: '' };
      let content = stripThinking(msg.content || '');
      const hasCalls = Boolean(msg.tool_calls && msg.tool_calls.length);
      // Reasoning models can spend the whole token budget thinking and return
      // nothing usable, or return the cut-off reasoning itself as content.
      // Neither is an answer: retry once with a larger budget and reasoning
      // switched off, and say so.
      const cutOff = choice.finish_reason === 'length' && !hasCalls && (!content || allReasoning(data.usage));
      if (cutOff) content = '';
      if (cutOff && !lengthRetry && maxTokens < 8000 && left() > 15000) {
        lengthRetry = true;
        addUsage(data.usage);
        if (canNoThink && !noThink) {
          noThink = true;
          noThinkTiers.add(tier);
        }
        notes.push(`hit max_tokens ${maxTokens} with no answer (reasoning), retried with ${maxTokens * 2}${noThink ? ' and reasoning off' : ''}`);
        maxTokens *= 2;
        continue;
      }
      addUsage(data.usage);
      return {
        message: { role: 'assistant', content, ...(hasCalls ? { tool_calls: msg.tool_calls } : {}) },
        usage: data.usage || carried.total_tokens > 0 ? carried : null,
        model: model.id,
        finish: choice.finish_reason || null,
        reasoningTokens: carried.reasoning_tokens || null,
        notes,
      };
    }
  }

  return {
    receipts,
    left,
    get mode() {
      return cfg.nebius.enabled ? 'live' : 'mock';
    },
    async chat(tier, req) {
      const started = Date.now();
      let out;
      if (cfg.nebius.enabled) {
        out = await live(tier, req);
      } else {
        out = mockChat(tier, req);
        out.model = cfg.nebius.models[tier].id + ' (mock)';
      }
      const u = out.usage || {};
      const receipt = {
        tier,
        model: out.model,
        source: cfg.nebius.enabled ? 'live' : 'mock',
        ms: Date.now() - started,
        purpose: req.purpose || '',
        tokens: out.usage ? u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0) : null,
        promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : null,
        completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : null,
        reasoningTokens: out.reasoningTokens ?? null,
        finish: out.finish ?? null,
        toolCalls: out.message.tool_calls ? out.message.tool_calls.length : 0,
      };
      if (out.notes && out.notes.length) receipt.note = out.notes.join('. ');
      receipts.push(receipt);
      return { ...out, receipt };
    },
    async json(tier, req) {
      const first = await this.chat(tier, req);
      let parsed = extractJson(first.message.content);
      if (parsed) return { data: parsed, receipt: first.receipt };
      const retry = await this.chat(tier, {
        ...req,
        purpose: (req.purpose || '') + ' (retry for JSON)',
        messages: [
          ...req.messages,
          { role: 'assistant', content: first.message.content || '' },
          { role: 'user', content: 'Reply again with only the JSON object, no prose.' },
        ],
      });
      parsed = extractJson(retry.message.content);
      return { data: parsed, receipt: retry.receipt };
    },
  };
}
