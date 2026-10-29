// Edge cases of the live Qloo client against a local fake server.
//   the two spellings of the video game type
//   a search that rejects the types filter
//   ids from the offline catalog never reach the live API
//   explainability in more than one shape
//   recorded snapshots are trimmed and load from the environment variable
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

const seen = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const params = Object.fromEntries(url.searchParams);
  seen.push({ path: url.pathname, params });
  res.setHeader('content-type', 'application/json');
  const bad = (msg) => {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: msg }));
  };
  if (url.pathname === '/search') {
    if (params.query === 'Strict' && params.types) return bad('types not supported here');
    if ((params.types || '').includes('urn:entity:video_game')) return bad('unknown type');
    const all = [
      { entity_id: 'G1', name: 'Stardew Valley', types: ['urn:entity:videogame'], popularity: 0.9 },
      { entity_id: 'BOOK1', name: 'Strict Book', types: ['urn:entity:book'] },
    ];
    const wanted = params.types ? params.types.split(',') : null;
    return res.end(JSON.stringify({ results: all.filter((e) => !wanted || wanted.includes(e.types[0])) }));
  }
  if (url.pathname === '/v2/insights') {
    return res.end(
      JSON.stringify({
        success: true,
        results: {
          entities: [
            {
              entity_id: 'P1',
              name: 'Sleep With Me',
              subtype: 'urn:entity:podcast',
              properties: { description: 'x'.repeat(400), image: { url: 'https://example.com/a.jpg' } },
              tags: Array.from({ length: 30 }, (_, i) => ({ id: `urn:tag:genre:podcast:t${i}`, name: `Tag ${i}`, type: 'urn:tag:genre:podcast' })),
              query: { affinity: 0.81234, explainability: { 'signal.interests.entities': { entities: [{ entity_id: 'G1', score: 0.7 }] } } },
            },
          ],
        },
      })
    );
  }
  res.end(JSON.stringify({ success: true, results: { tags: [] } }));
});

test('live Qloo edge cases', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.QLOO_API_KEY = 'fake-qloo-key';
  process.env.QLOO_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.QLOO_PACE_MS = '0';
  delete process.env.QLOO_VIDEOGAME_TYPE;
  delete process.env.OFFRAMP_FORCE_SAMPLE_QLOO;
  try {
    const { getConfig } = await import('../lib/config.js');
    const { createQloo } = await import('../lib/qloo.js');
    const q = createQloo(getConfig());

    // The hackathon guide spelling is tried first, the other one after a 400.
    const g = await q.search('Stardew Valley', { types: 'urn:entity:videogame', take: 1 });
    assert.equal(g.source, 'live');
    assert.equal(g.results[0].id, 'G1');
    assert.equal(g.results[0].type, 'urn:entity:videogame');
    assert.equal(seen[0].params.types, 'urn:entity:video_game');
    assert.equal(seen[1].params.types, 'urn:entity:videogame');
    assert.match(q.receipts[0].note, /spelled urn:entity:videogame/);

    // The working spelling is remembered, so the next call needs no retry.
    const before = seen.length;
    await q.search('Stardew Valley', { types: 'urn:entity:videogame', take: 1 });
    assert.equal(seen.length, before + 1);

    // A search that rejects types is retried without it and filtered locally.
    const s = await q.search('Strict', { types: 'urn:entity:book', take: 3 });
    assert.equal(s.source, 'live');
    assert.deepEqual(s.results.map((r) => r.id), ['BOOK1']);
    assert.equal(seen.at(-1).params.types, undefined);
    assert.match(q.receipts.at(-1).note, /filtered locally/);

    // Sample ids never reach the live API.
    const mixed = await q.insights({ type: 'urn:entity:podcast', signalEntities: ['G1', 'sample-tv-bakeoff'], tags: ['sample:tag:calm'] });
    assert.equal(mixed.source, 'live');
    assert.equal(seen.at(-1).params['signal.interests.entities'], 'G1');
    assert.equal(seen.at(-1).params['filter.tags'], undefined);
    assert.deepEqual(mixed.entities[0].because, [{ id: 'G1', score: 0.7 }]);
    assert.equal(mixed.entities[0].affinity, 0.812);

    const calls = seen.length;
    const onlySample = await q.insights({ type: 'urn:entity:podcast', signalEntities: ['sample-tv-bakeoff'] });
    assert.equal(seen.length, calls, 'no live request when every signal is a sample id');
    assert.equal(onlySample.source, 'sample');
    assert.match(q.receipts.at(-1).note, /no live Qloo ids/);
  } finally {
    server.close();
  }
});

test('snapshots are trimmed and load from the environment variable', async () => {
  const { trimResponse, explainList } = await import('../lib/qloo.js');
  const raw = {
    success: true,
    results: {
      entities: [
        {
          entity_id: 'P1',
          name: 'Sleep With Me',
          subtype: 'urn:entity:podcast',
          properties: { description: 'y'.repeat(500), image: { url: 'https://example.com/a.jpg' }, akas: ['a', 'b'] },
          tags: Array.from({ length: 40 }, (_, i) => ({ id: `urn:tag:keyword:t${i}`, name: `K${i}`, type: 'urn:tag:keyword' })),
          query: { affinity: 0.5, explainability: { 'signal.interests.entities': [{ entity_id: 'A', score: 0.2 }, { entity_id: 'B', score: 0.9 }] } },
        },
      ],
    },
  };
  const t = trimResponse('/v2/insights', raw);
  const e = t.results.entities[0];
  assert.equal(e.properties.description.length, 160);
  assert.equal(e.properties.image, undefined);
  assert.equal(e.tags.length, 6);
  assert.deepEqual(explainList(e.query).map((x) => x.entity_id), ['B', 'A']);
  assert.ok(JSON.stringify(t).length < JSON.stringify(raw).length / 3);

  // Keyed by entity id is read too.
  assert.deepEqual(explainList({ explainability: { X: 0.4, Y: 0.6, warning: 'n/a' } }).map((x) => x.entity_id), ['Y', 'X']);
  assert.deepEqual(explainList({ explainability: { warning: 'could not compute' } }), []);

  // The hosted fallback reads a gzipped, base64 value from the environment.
  const { spawnSync } = await import('node:child_process');
  const key = '/search?query=Radiohead&take=1&types=urn:entity:artist';
  const value = gzipSync(JSON.stringify({ [key]: { results: [{ entity_id: 'R1', name: 'Radiohead', types: ['urn:entity:artist'] }] } })).toString('base64');
  const script = `
    const { createQloo, snapshotCount } = await import('./lib/qloo.js');
    const { getConfig } = await import('./lib/config.js');
    const q = createQloo(getConfig());
    const r = await q.search('Radiohead', { types: 'urn:entity:artist', take: 1 });
    console.log(JSON.stringify({ n: snapshotCount(), source: r.source, id: r.results[0] && r.results[0].id }));
  `;
  const env = { ...process.env, QLOO_SNAPSHOTS_GZ_B64: value, QLOO_API_KEY: '' };
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', cwd: new URL('..', import.meta.url) });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim()), { n: 1, source: 'snapshot', id: 'R1' });
});

test('recorded Qloo data is kept out of git', async () => {
  const { readFileSync } = await import('node:fs');
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(ignore, /^data\/\*\.local\.json$/m);
  assert.match(ignore, /^\*\.local\.txt$/m);
  const { SNAPSHOT_PATH } = await import('../lib/qloo.js');
  assert.match(SNAPSHOT_PATH, /qloo-snapshots\.local\.json$/);
});
