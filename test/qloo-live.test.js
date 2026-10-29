// The live Qloo client against a local fake server. Checks the header, the
// parameter names, the retry without optional parameters on a 400, and the
// labeled fallback when Qloo rejects the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const seen = [];
let reject = false;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  seen.push({ path: url.pathname, key: req.headers['x-api-key'], params: Object.fromEntries(url.searchParams) });
  res.setHeader('content-type', 'application/json');
  if (reject) {
    res.statusCode = 401;
    return res.end('{"error":"invalid key"}');
  }
  if (url.pathname === '/search') {
    return res.end(JSON.stringify({ results: [{ entity_id: 'E1', name: 'Nils Frahm', types: ['urn:entity:artist'], popularity: 0.7 }] }));
  }
  if (url.pathname === '/v2/insights') {
    if (url.searchParams.has('bias.trends')) {
      res.statusCode = 400;
      return res.end('{"error":"unknown parameter"}');
    }
    return res.end(
      JSON.stringify({
        success: true,
        results: {
          entities: [
            { entity_id: 'E2', name: 'Hiroshi Yoshimura', subtype: 'urn:entity:artist', query: { affinity: 0.9 }, tags: [{ id: 'urn:tag:genre:music:ambient', name: 'Ambient', type: 'urn:tag:genre:music' }] },
          ],
        },
      })
    );
  }
  res.end(JSON.stringify({ success: true, results: { tags: [{ id: 'urn:tag:genre:music:ambient', name: 'Ambient', type: 'urn:tag:genre:music' }] } }));
});

test('live Qloo client, retries and labeled fallback', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.QLOO_API_KEY = 'fake-qloo-key';
  process.env.QLOO_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.QLOO_PACE_MS = '0';
  delete process.env.OFFRAMP_FORCE_SAMPLE_QLOO;
  try {
    const { getConfig } = await import('../lib/config.js');
    const { createQloo } = await import('../lib/qloo.js');
    const q = createQloo(getConfig());

    const s = await q.search('Nils Frahm', { types: 'urn:entity:artist', take: 1 });
    assert.equal(s.source, 'live');
    assert.equal(s.results[0].id, 'E1');
    assert.equal(seen[0].key, 'fake-qloo-key');
    assert.equal(seen[0].params.query, 'Nils Frahm');

    const t = await q.tags('ambient', { parentType: 'urn:entity:artist' });
    assert.equal(t.tags[0].id, 'urn:tag:genre:music:ambient');
    assert.equal(seen[1].params['filter.parents.types'], 'urn:entity:artist');

    const i = await q.insights({ type: 'urn:entity:artist', signalEntities: ['E1'], tags: ['urn:tag:genre:music:ambient'], trendBias: 'low' });
    assert.equal(i.source, 'live');
    assert.equal(i.entities[0].affinity, 0.9);
    const insightCalls = seen.filter((c) => c.path === '/v2/insights');
    assert.equal(insightCalls.length, 2);
    assert.equal(insightCalls[0].params['bias.trends'], 'low');
    assert.equal(insightCalls[1].params['bias.trends'], undefined);
    assert.match(q.receipts[2].note, /retried without/);

    reject = true;
    const after = await q.search('Nils Frahm', { types: 'urn:entity:artist', take: 1 });
    assert.notEqual(after.source, 'live');
    assert.match(q.receipts[3].note, /rejected the key/);
  } finally {
    server.close();
  }
});
