// Checks that each key in .env works, with one tiny call per service.
// Prints status codes and model ids only, never the keys.
//   npm run check-keys

import { loadEnv } from './env.js';
loadEnv();
const { getConfig } = await import('../lib/config.js');
const cfg = getConfig();
let ok = true;

async function timed(fn) {
  const t = Date.now();
  try {
    const r = await fn();
    return { ...r, ms: Date.now() - t };
  } catch (err) {
    return { error: err.message, ms: Date.now() - t };
  }
}

console.log('--- Qloo');
if (!process.env.QLOO_API_KEY) {
  console.log('QLOO_API_KEY is empty. The app will use sample data.');
} else {
  const r = await timed(async () => {
    const url = new URL(cfg.qloo.baseUrl + '/search');
    url.searchParams.set('query', 'Radiohead');
    url.searchParams.set('types', 'urn:entity:artist');
    url.searchParams.set('take', '1');
    const res = await fetch(url, { headers: { 'X-Api-Key': process.env.QLOO_API_KEY } });
    const body = await res.json().catch(() => ({}));
    const hit = Array.isArray(body.results) ? body.results[0] : null;
    return { status: res.status, first: hit ? hit.name : null, id: hit ? hit.entity_id : null };
  });
  console.log(r);
  if (r.status !== 200) {
    ok = false;
    console.log('Qloo did not return 200. A 401 usually means the key is not a hackathon key or QLOO_BASE_URL is wrong.');
  } else {
    // Which spelling of the video game type does this API accept? The app
    // tries both on its own, this only tells you which one to pin.
    for (const t of ['urn:entity:video_game', 'urn:entity:videogame']) {
      const g = await timed(async () => {
        const url = new URL(cfg.qloo.baseUrl + '/v2/insights');
        url.searchParams.set('filter.type', t);
        url.searchParams.set('take', '1');
        const res = await fetch(url, { headers: { 'X-Api-Key': process.env.QLOO_API_KEY } });
        return { status: res.status };
      });
      console.log('video game type', t, g);
    }
    // One insights call with explainability, to see the response shape.
    if (r.id) {
      const x = await timed(async () => {
        const url = new URL(cfg.qloo.baseUrl + '/v2/insights');
        url.searchParams.set('filter.type', 'urn:entity:artist');
        url.searchParams.set('signal.interests.entities', r.id);
        url.searchParams.set('feature.explainability', 'true');
        url.searchParams.set('take', '2');
        const res = await fetch(url, { headers: { 'X-Api-Key': process.env.QLOO_API_KEY } });
        const body = await res.json().catch(() => ({}));
        const first = body.results && body.results.entities && body.results.entities[0];
        return {
          status: res.status,
          first: first ? first.name : null,
          affinity: first && first.query ? first.query.affinity : null,
          explainability: first && first.query && first.query.explainability ? JSON.stringify(first.query.explainability).slice(0, 200) : null,
        };
      });
      console.log('insights with explainability', x);
    }
  }
}

console.log('--- Nebius Token Factory');
if (!process.env.NEBIUS_API_KEY) {
  console.log('NEBIUS_API_KEY is empty. The app will use the mock model.');
} else {
  const bases = [...new Set(Object.values(cfg.nebius.models).map((m) => m.baseUrl))];
  const available = new Set();
  for (const base of bases) {
    const r = await timed(async () => {
      const res = await fetch(base.replace(/\/$/, '') + '/models', { headers: { authorization: `Bearer ${process.env.NEBIUS_API_KEY}` } });
      const body = await res.json().catch(() => ({}));
      const ids = (body.data || []).map((m) => m.id);
      ids.forEach((id) => available.add(id));
      return { status: res.status, nemotron: ids.filter((id) => /nemotron/i.test(id)) };
    });
    console.log(base, r);
  }
  for (const [tier, m] of Object.entries(cfg.nebius.models)) {
    const r = await timed(async () => {
      const res = await fetch(m.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.NEBIUS_API_KEY}` },
        body: JSON.stringify({ model: m.id, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 400, ...(cfg.nebius.extraBody || {}) }),
      });
      const body = await res.json().catch(() => ({}));
      const text = body.choices ? String(body.choices[0].message.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim().slice(0, 40) : JSON.stringify(body).slice(0, 160);
      const details = (body.usage && body.usage.completion_tokens_details) || {};
      return { status: res.status, reply: text, finish: body.choices && body.choices[0].finish_reason, tokens: body.usage && body.usage.total_tokens, reasoningTokens: details.reasoning_tokens ?? null };
    });
    console.log(tier.padEnd(8), m.id, r);
    if (r.status !== 200) {
      ok = false;
      const near = [...available].filter((id) => /nemotron/i.test(id));
      console.log(`  ${tier} failed. Set NEBIUS_MODEL_${tier.toUpperCase()} in .env to one of: ${near.join(', ') || '(no Nemotron ids listed)'}`);
    }
  }
  console.log('--- Tool calling on the planner');
  const m = cfg.nebius.models.planner;
  const r = await timed(async () => {
    const res = await fetch(m.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.NEBIUS_API_KEY}` },
      body: JSON.stringify({
        model: m.id,
        messages: [{ role: 'user', content: 'Call the ping tool with word set to hello.' }],
        tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] } } }],
        tool_choice: 'auto',
        max_tokens: 600,
        ...(cfg.nebius.extraBody || {}),
      }),
    });
    const body = await res.json().catch(() => ({}));
    const choice = (body.choices && body.choices[0]) || {};
    const calls = choice.message && choice.message.tool_calls;
    const details = (body.usage && body.usage.completion_tokens_details) || {};
    return { status: res.status, finish: choice.finish_reason, toolCalls: calls ? calls.map((c) => `${c.function.name}(${c.function.arguments})`) : null, completionTokens: body.usage && body.usage.completion_tokens, reasoningTokens: details.reasoning_tokens ?? null };
  });
  console.log(r);
  if (!r.toolCalls) console.log('  No native tool call came back. Offramp will switch to its JSON tool protocol automatically.');
  if (r.finish === 'length') {
    console.log('  The planner hit max_tokens before answering, probably while reasoning. Try turning reasoning off with one of these lines in .env, then run check-keys again:');
    console.log('  NEBIUS_EXTRA_BODY={"chat_template_kwargs":{"enable_thinking":false}}');
    console.log('  NEBIUS_EXTRA_BODY={"reasoning_effort":"low"}');
  }
  console.log('NEBIUS_EXTRA_BODY is', cfg.nebius.extraBody ? JSON.stringify(cfg.nebius.extraBody) : 'not set');
}

console.log('--- Tavily (for the Best Use of Tavily bonus)');
if (!process.env.TAVILY_API_KEY) {
  console.log('Not set. Plans work without it, but the first step will not name one episode and the Tavily bonus needs a runtime call.');
} else {
  const { searchEpisodes } = await import('../lib/tavily.js');
  const r = await searchEpisodes({ name: 'The Great British Bake Off', type: 'urn:entity:tv_show' }, cfg);
  console.log({ available: r.available, results: r.results ? r.results.length : 0, ms: r.ms, note: r.note });
  if (!r.available) ok = false;
}
console.log(ok ? '\nAll configured keys work.' : '\nSomething needs fixing, see above.');
process.exit(ok ? 0 : 1);
