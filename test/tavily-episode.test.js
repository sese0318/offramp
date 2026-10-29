// The Tavily episode step against a local fake Tavily server. With a key set,
// the first show or podcast in the plan gets one named episode, and a pick
// that does not appear in the search results is dropped.
process.env.OFFRAMP_FORCE_MOCK_LLM = '1';
process.env.OFFRAMP_FORCE_SAMPLE_QLOO = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const personas = JSON.parse(readFileSync(new URL('../data/personas.json', import.meta.url), 'utf8'));
const seen = [];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const data = JSON.parse(body || '{}');
    seen.push({ path: req.url, auth: req.headers.authorization, query: data.query });
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        answer: 'Viewers often pick a gentle episode for winding down.',
        results: [
          { title: 'The calmest episode is "Bread and Butter" (Season 2, Episode 3)', url: 'https://example.org/calm', content: 'A slow, cozy episode with no cliffhanger.' },
          { title: 'Episode guide', url: 'https://example.org/guide', content: 'All episodes listed.' },
        ],
      })
    );
  });
});

test('with a Tavily key the first step names one grounded episode', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.TAVILY_API_KEY = 'tvly-test-not-real';
  process.env.TAVILY_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  try {
    const { getConfig } = await import('../lib/config.js');
    const { runToCompletion } = await import('../lib/agent.js');
    const cfg = getConfig();
    assert.equal(cfg.tavily.enabled, true);
    for (const p of personas) {
      const state = await runToCompletion(p.input, cfg);
      assert.ok(state.plan, state.error);
      const first = state.plan.steps.find((s) => s.item.lane === 'screen' || s.item.lane === 'audio');
      assert.ok(first.episode, `${p.id} has no episode`);
      assert.equal(first.episode.title, 'Bread and Butter');
      assert.equal(first.episode.url, 'https://example.org/calm');
      assert.ok(state.trace.some((t) => t.kind === 'tavily'));
      assert.equal(state.sources.tavily, 1);
    }
    assert.ok(seen.every((r) => r.path === '/search' && r.auth === 'Bearer tvly-test-not-real'));
  } finally {
    server.close();
    delete process.env.TAVILY_API_KEY;
  }
});

test('an episode the model made up is dropped', async () => {
  const { groundEpisode } = await import('../lib/tavily.js');
  const search = { answer: '', results: [{ title: 'Guide', url: 'https://example.org/a', snippet: 'Try "Quiet Morning", a gentle one.' }] };
  assert.equal(groundEpisode({ title: 'Ozymandias' }, search), null);
  const ok = groundEpisode({ title: 'Quiet Morning', url: 'https://not-in-results.example' }, search);
  assert.equal(ok.title, 'Quiet Morning');
  assert.equal(ok.url, 'https://example.org/a');
});

test('an episode named in the results is kept despite case, quotes, dashes and escapes', async () => {
  const { groundEpisode } = await import('../lib/tavily.js');
  const search = {
    answer: 'Fans mention "A Trip to Walt Disney\\\'s Vacation Kingdom" (#103).',
    results: [
      { title: 'Sleep With Me - Apple Podcasts', url: 'https://example.org/show', snippet: 'Reviews and ratings.' },
      { title: 'Sleep With Me', url: 'https://example.org/site', snippet: '## 1488 – 1970s Catalogs for the Autumnal Season ## 1487 – Great Gourdcast' },
    ],
  };
  const a = groundEpisode({ title: "A Trip to Walt Disney's Vacation Kingdom", url: '' }, search);
  assert.equal(a.title, "A Trip to Walt Disney's Vacation Kingdom");
  const b = groundEpisode({ title: '1488 - 1970s catalogs for the autumnal season', url: 'https://example.org/show' }, search);
  assert.ok(b, 'dash and case differences should not drop the pick');
  assert.equal(b.url, 'https://example.org/site', 'the source link is the result that names the episode');
  // Whole words only, so a fragment of a real title is not enough.
  assert.equal(groundEpisode({ title: 'Gourd' }, search), null);
  assert.equal(groundEpisode({ title: 'The Autumnal Season Finale' }, search), null);
});

test('the episode shows no number, length or fact the search results do not state', async () => {
  const { groundEpisode } = await import('../lib/tavily.js');
  const search = {
    answer: `Listeners like "A Trip to Walt Disney\\'s Vacation Kingdom" (#103).`,
    results: [{ title: 'Midnight Diner episodes', url: 'https://example.org/list', snippet: 'Episode 5: Butter Rice. A quiet night at the diner.' }],
  };
  const a = groundEpisode({ title: "A Trip to Walt Disney's Vacation Kingdom", season_episode: '#103', why: 'Calm Disney trip story under 15 min' }, search);
  assert.equal(a.seasonEpisode, '#103', 'the number is in the answer that names it');
  assert.equal(a.why, '', 'a length the results never state is dropped');
  const b = groundEpisode({ title: 'Butter Rice', season_episode: 'S01E05', why: 'Cozy food, like the Bake Off you love' }, search);
  assert.equal(b.seasonEpisode, '', 'season 1 is not stated, so the label is dropped');
  assert.equal(b.why, 'Cozy food, like the Bake Off you love');
  const c = groundEpisode({ title: 'Butter Rice', season_episode: 'Episode 5', why: '' }, search);
  assert.equal(c.seasonEpisode, 'Episode 5');
  assert.equal(groundEpisode({ title: 'Butter Rice', season_episode: 'E7' }, search).seasonEpisode, '');
});
