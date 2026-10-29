// What happens when Token Factory is slow, out of credits, or spends its
// token budget on reasoning. Each case runs against a local fake server.
process.env.OFFRAMP_FORCE_SAMPLE_QLOO = '1';
delete process.env.OFFRAMP_FORCE_MOCK_LLM;

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const personas = JSON.parse(readFileSync(new URL('../data/personas.json', import.meta.url), 'utf8'));
let mode = 'credits';
const requests = [];

function reply(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const data = JSON.parse(body || '{}');
    requests.push({ model: data.model, maxTokens: data.max_tokens, tools: Boolean(data.tools), noThink: Boolean(data.chat_template_kwargs && data.chat_template_kwargs.enable_thinking === false), sys: String((data.messages && data.messages[0] && data.messages[0].content) || '').slice(0, 20) });
    if (mode === 'credits') return reply(res, { detail: 'Insufficient balance' }, 402);
    const sys = String((data.messages && data.messages[0] && data.messages[0].content) || '');
    if (mode === 'thinkContent' && sys.startsWith('You turn a person') && !(data.chat_template_kwargs && data.chat_template_kwargs.enable_thinking === false)) {
      // Cut-off reasoning returned as content, with a stray JSON array in it.
      const think = "Here's a thinking process:\n1. favorites: [\"Serial\", \"Spirited Away\"] and the form {\"favorites\":[{\"name\":\"\"";
      return reply(res, { choices: [{ message: { content: think }, finish_reason: 'length' }], usage: { total_tokens: 900, completion_tokens: data.max_tokens, completion_tokens_details: { reasoning_tokens: data.max_tokens } } });
    }
    if (sys.startsWith('You turn a person')) return reply(res, { choices: [{ message: { content: '{"favorites":[],"traps":[],"constraints":[]}' }, finish_reason: 'stop' }] });
    if (sys.startsWith('You rate media')) {
      const items = JSON.parse(data.messages[1].content).items;
      return reply(res, { choices: [{ message: { content: JSON.stringify({ ratings: items.map((it) => ({ id: it.id, arousal: 2, reason: 'test' })) }) }, finish_reason: 'stop' }] });
    }
    if (mode === 'slow') {
      setTimeout(() => reply(res, { choices: [{ message: { content: 'late' }, finish_reason: 'stop' }] }), 6000);
      return;
    }
    if (mode === 'length') {
      if (data.max_tokens < 5000) return reply(res, { choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { total_tokens: data.max_tokens, completion_tokens: data.max_tokens, completion_tokens_details: { reasoning_tokens: data.max_tokens } } });
      return reply(res, { choices: [{ message: { content: 'Thinking done.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'resolve_taste', arguments: '{"items":[{"name":"Serial","role":"favorite"}]}' } }] }, finish_reason: 'tool_calls' }], usage: { total_tokens: 900 } });
    }
    return reply(res, { choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
  });
});

async function setup(extra = {}) {
  if (!server.listening) await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  delete process.env.OFFRAMP_STEP_BUDGET_MS;
  delete process.env.NEBIUS_TIMEOUT_MS;
  Object.assign(process.env, { NEBIUS_API_KEY: 'test-key-not-real', NEBIUS_BASE_URL_FAST: base, NEBIUS_BASE_URL_PLANNER: base, NEBIUS_BASE_URL_DEEP: base }, extra);
  const { getConfig } = await import('../lib/config.js');
  return getConfig();
}

test('out of credits: the page still gets a Qloo-grounded plan and says why', { timeout: 30000 }, async () => {
  mode = 'credits';
  const cfg = await setup();
  const { runToCompletion } = await import('../lib/agent.js');
  const state = await runToCompletion(personas[0].input, cfg);
  assert.ok(state.plan, state.error);
  assert.equal(state.plan.meta.fallback, true);
  assert.match(state.plan.meta.reason, /402/);
  assert.ok(state.trace.some((t) => t.kind === 'fallback' && /fixed tool sequence/.test(t.title)));
  assert.ok(state.plan.notes.some((n) => /could not be reached/.test(n)));
  assert.ok(state.plan.steps.every((s) => s.item.arousalBy === 'heuristic'));
});

test('a slow planner call is cut off inside the step budget', { timeout: 30000 }, async () => {
  mode = 'slow';
  const cfg = await setup({ OFFRAMP_STEP_BUDGET_MS: '9000', NEBIUS_TIMEOUT_MS: '3000' });
  const { startRun, step } = await import('../lib/agent.js');
  let state = await startRun(personas[1].input, cfg);
  const t0 = Date.now();
  state = await step(state, cfg);
  const took = Date.now() - t0;
  assert.ok(took < 9000, `step took ${took} ms`);
  assert.ok(state.scripted, 'planner failure should hand over to the fixed tool sequence');
  state = await step(state, cfg);
  assert.ok(state.plan, state.error);
  assert.ok(state.plan.steps.some((s) => s.item.arousalBy === 'model'));
});

test('reasoning that eats max_tokens is retried once with a bigger budget', { timeout: 30000 }, async () => {
  mode = 'length';
  requests.length = 0;
  const cfg = await setup();
  const { startRun, step } = await import('../lib/agent.js');
  let state = await startRun(personas[0].input, cfg);
  state = await step(state, cfg);
  const planner = requests.filter((r) => r.tools);
  assert.deepEqual(planner.map((r) => r.maxTokens), [2500, 5000]);
  assert.ok(state.trace.some((t) => t.kind === 'model' && /hit max_tokens 2500/.test(t.note || '')));
  assert.equal(state.usage.planner.reasoningTokens, 2500);
  assert.ok(state.trace.some((t) => t.kind === 'tool' && t.tool === 'resolve_taste'));
});

test('cut-off reasoning returned as content is not parsed as the answer', { timeout: 30000 }, async () => {
  mode = 'thinkContent';
  requests.length = 0;
  const cfg = await setup();
  const { startRun } = await import('../lib/agent.js');
  const state = await startRun(personas[0].input, cfg);
  const intake = requests.filter((r) => r.sys.startsWith('You turn a person'));
  assert.deepEqual(intake.map((r) => [r.maxTokens, r.noThink]), [[700, false], [1400, true]]);
  assert.ok(state.trace.some((t) => t.kind === 'model' && /reasoning off/.test(t.note || '')));
  // The planner always sees the person's favorites, never an empty list.
  assert.deepEqual(state.intake.favorites.map((f) => f.name), personas[0].input.favorites);
});

after(() => {
  server.closeAllConnections();
  server.close();
});
