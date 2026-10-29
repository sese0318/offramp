// A whole run against a fake Qloo server that answers with Qloo's documented
// shapes, using the deterministic planner. Checks that every item in the plan
// came from a live call, that tag ids came from /v2/tags, and that the trap
// radar asks without the calm filter.
process.env.OFFRAMP_FORCE_MOCK_LLM = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const CATALOG = {
  'urn:entity:tv_show': [
    { entity_id: 'TV-calm', name: 'Slow Garden', d: 'A gentle, cozy show about a quiet garden.' },
    { entity_id: 'TV-hot', name: 'Night Heist', d: 'A suspense thriller full of cliffhanger endings.' },
  ],
  'urn:entity:podcast': [{ entity_id: 'POD-calm', name: 'Soft Stories', d: 'Calm, slow bedtime stories.' }],
  'urn:entity:artist': [{ entity_id: 'ART-calm', name: 'Quiet Piano', d: 'Ambient piano, soft and sparse.' }],
  'urn:entity:book': [{ entity_id: 'BOOK-calm', name: 'Warm Tea Book', d: 'A cozy, gentle novel.' }],
};
const seen = [];

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = Object.fromEntries(url.searchParams);
  seen.push({ path: url.pathname, p });
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/search') {
    const id = 'FAV-' + p.query.replace(/\W+/g, '').toLowerCase();
    const type = (p.types || 'urn:entity:tv_show').split(',')[0];
    return res.end(JSON.stringify({ results: [{ entity_id: id, name: p.query, types: [type] }] }));
  }
  if (url.pathname === '/v2/tags') {
    const word = p['filter.query'];
    return res.end(JSON.stringify({ success: true, results: { tags: [{ id: `urn:tag:keyword:qloo:${word}`, name: word, type: 'urn:tag:keyword:qloo' }] } }));
  }
  if (url.pathname === '/v2/insights') {
    const list = (CATALOG[p['filter.type']] || []).filter((e) => !p['filter.tags'] || !/hot/i.test(e.entity_id));
    const signal = (p['signal.interests.entities'] || '').split(',')[0];
    return res.end(
      JSON.stringify({
        success: true,
        results: {
          entities: list.map((e, i) => ({
            entity_id: e.entity_id,
            name: e.name,
            subtype: p['filter.type'],
            properties: { description: e.d },
            query: { affinity: 0.9 - i * 0.05, explainability: { 'signal.interests.entities': [{ entity_id: signal, score: 0.8 }] } },
          })),
        },
      })
    );
  }
  res.statusCode = 404;
  res.end('{}');
});

test('a full run on live Qloo shapes', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.QLOO_API_KEY = 'fake-qloo-key';
  process.env.QLOO_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.QLOO_PACE_MS = '0';
  delete process.env.OFFRAMP_FORCE_SAMPLE_QLOO;
  try {
    const { getConfig } = await import('../lib/config.js');
    const { runToCompletion, probeValidator } = await import('../lib/agent.js');
    const cfg = getConfig();
    assert.equal(cfg.qloo.enabled, true);
    const state = await runToCompletion(
      { favorites: ['Bake Show', 'Night Radio'], traps: ['Night Heist'], sleepBy: '00:30', windDownMinutes: 90, notes: '' },
      cfg
    );
    assert.ok(state.plan, state.error || JSON.stringify(state.validationErrors));
    assert.deepEqual(Object.keys(state.sources.qloo), ['live']);
    const items = [...state.plan.steps.map((s) => s.item), state.plan.ifAwake && state.plan.ifAwake.item].filter(Boolean);
    assert.ok(items.length >= 3);
    for (const it of items) {
      assert.equal(it.source, 'live', it.name);
      assert.ok(!it.id.startsWith('sample'), it.id);
    }
    // Calm lanes carry real tag ids from /v2/tags and a low trend bias.
    const calm = seen.filter((c) => c.path === '/v2/insights' && c.p['filter.tags']);
    assert.ok(calm.length >= 3);
    assert.ok(calm.every((c) => c.p['filter.tags'].startsWith('urn:tag:keyword:qloo:') && c.p['bias.trends'] === 'low' && c.p['feature.explainability'] === 'true'));
    // The trap radar asks without the calm filter, and the stimulating title lands in skip tonight.
    assert.ok(seen.some((c) => c.path === '/v2/insights' && !c.p['filter.tags']));
    assert.ok(state.plan.skipTonight.some((s) => s.item.name === 'Night Heist'));
    assert.ok(!items.some((it) => it.name === 'Night Heist'));
    // "Because you like" comes from explainability.
    assert.ok(items.some((it) => it.because.length));
    const probe = probeValidator(state);
    assert.equal(probe.cases[0].accepted, true);
    assert.equal(probe.cases[1].accepted, false);
  } finally {
    server.close();
  }
});
