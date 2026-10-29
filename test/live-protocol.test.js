// Exercises the live Token Factory code path against a local fake server that
// speaks the OpenAI-compatible chat completions protocol. It checks the request
// shape (auth header, model ids per tier, tools) and the agent's recovery when
// the planner submits a title that Qloo never returned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const requests = [];
let port;

function reply(res, message, usage = { total_tokens: 42 }) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message }], usage }));
}
const call = (name, args, i) => ({ id: `call_${name}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

function toolResults(messages) {
  return messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const data = JSON.parse(body);
    requests.push({ auth: req.headers.authorization, url: req.url, model: data.model, hasTools: Boolean(data.tools), messages: data.messages });
    const sys = data.messages[0].content;
    if (sys.startsWith('You turn a person')) {
      return reply(res, { role: 'assistant', content: '<think>parsing</think>{"favorites":[{"name":"Serial","kind":"podcast"},{"name":"Spirited Away","kind":"movie"}],"traps":[{"name":"Breaking Bad","kind":"tv_show"}],"constraints":["shares a room"],"screen_ok":true}' });
    }
    if (sys.startsWith('You rate media')) {
      const items = JSON.parse(data.messages[1].content).items;
      return reply(res, { role: 'assistant', content: JSON.stringify({ ratings: items.map((it) => ({ id: it.id, arousal: /crime|thriller|suspense/i.test(JSON.stringify(it)) ? 8 : 1, reason: 'test' })) }) });
    }
    const turn = data.messages.filter((m) => m.role === 'assistant').length;
    const results = toolResults(data.messages);
    if (turn === 0) {
      return reply(res, { role: 'assistant', content: 'Resolving your taste.', tool_calls: [call('resolve_taste', { items: [{ name: 'Serial', kind: 'podcast', role: 'favorite' }, { name: 'Spirited Away', kind: 'movie', role: 'favorite' }, { name: 'Breaking Bad', kind: 'tv_show', role: 'trap' }] }, 0)] });
    }
    if (turn === 1) {
      const ids = results[0].resolved.filter((r) => r.role === 'favorite').map((r) => r.entity_id);
      return reply(res, {
        role: 'assistant',
        content: '',
        tool_calls: [
          call('recommend', { lane: 'audio', entity_type: 'podcast', signal_entity_ids: ids, tag_ids: ['sample:tag:sleep'] }, 1),
          call('recommend', { lane: 'music', entity_type: 'artist', signal_entity_ids: ids, tag_ids: ['sample:tag:ambient'] }, 2),
        ],
      });
    }
    if (turn === 2) {
      const ids = results.slice(1).flatMap((r) => r.candidates.map((c) => c.entity_id));
      return reply(res, { role: 'assistant', content: '', tool_calls: [call('rate_arousal', { entity_ids: ids }, 3)] });
    }
    const audio = results.find((r) => r.lane === 'audio').candidates[0].entity_id;
    const music = results.find((r) => r.lane === 'music').candidates[0].entity_id;
    if (turn === 3) {
      // First draft invents a title. The validator must reject it.
      return reply(res, { role: 'assistant', content: '', tool_calls: [call('submit_plan', { steps: [{ minutes_before_sleep: 60, lane: 'audio', entity_id: 'invented-id', instruction: 'x', why: 'y' }, { minutes_before_sleep: 15, lane: 'music', entity_id: music, instruction: 'x', why: 'y' }] }, 4)] });
    }
    return reply(res, {
      role: 'assistant',
      content: '',
      tool_calls: [call('submit_plan', { headline: 'Test night', steps: [{ minutes_before_sleep: 45, lane: 'audio', entity_id: audio, instruction: 'Listen', why: 'calm' }, { minutes_before_sleep: 15, lane: 'music', entity_id: music, instruction: 'Sleep timer', why: 'calm' }] }, 5)],
    });
  });
});

test('live protocol path, with a rejected draft that the planner fixes', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  process.env.NEBIUS_API_KEY = 'test-key-not-real';
  process.env.NEBIUS_BASE_URL_FAST = `http://127.0.0.1:${port}/v1`;
  process.env.NEBIUS_BASE_URL_PLANNER = `http://127.0.0.1:${port}/v1`;
  process.env.NEBIUS_BASE_URL_DEEP = `http://127.0.0.1:${port}/v1`;
  process.env.OFFRAMP_FORCE_SAMPLE_QLOO = '1';
  delete process.env.OFFRAMP_FORCE_MOCK_LLM;
  try {
    const { getConfig } = await import('../lib/config.js');
    const { runToCompletion } = await import('../lib/agent.js');
    const cfg = getConfig();
    assert.equal(cfg.nebius.enabled, true);
    const state = await runToCompletion({ favorites: ['Serial', 'Spirited Away'], traps: ['Breaking Bad'], sleepBy: '00:30', windDownMinutes: 60 }, cfg);
    assert.ok(state.plan, state.error);
    assert.equal(state.plan.meta.fallback, false);
    assert.equal(state.plan.meta.rejectedDrafts, 1);
    assert.equal(state.plan.steps.length, 2);
    assert.ok(state.trace.some((t) => t.kind === 'tool' && t.tool === 'submit_plan' && t.detail.rejected));
    assert.ok(requests.every((r) => r.auth === 'Bearer test-key-not-real'));
    const models = new Set(requests.map((r) => r.model));
    assert.ok(models.has(cfg.nebius.models.fast.id));
    assert.ok(models.has(cfg.nebius.models.planner.id));
    assert.ok(requests.filter((r) => r.model === cfg.nebius.models.planner.id).every((r) => r.hasTools));
    assert.ok(state.usage.planner.tokens > 0);
    assert.deepEqual(state.intake.constraints, ['shares a room']);
  } finally {
    server.close();
  }
});
