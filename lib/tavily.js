// Tavily, for the one thing Qloo does not hold: episodes. Qloo knows the show
// or podcast a person would like. When TAVILY_API_KEY is set, Offramp runs one
// extra agent step after the plan is accepted. It searches the web for calm,
// self-contained episodes of the first step's title, a fast Nemotron model
// picks one, and the pick is kept only if its title appears word for word in
// the search results (ignoring case and punctuation). The first step then has a clear end, one named episode.

import { EPISODE_SYSTEM } from './prompts.js';

export async function searchEpisodes(entity, cfg, { timeoutMs = 12000 } = {}) {
  if (!cfg || !cfg.tavily || !cfg.tavily.enabled) {
    return { available: false, note: 'Tavily is not configured for this deployment.' };
  }
  // Ask for episodes by name. A question like "calmest episode to listen to
  // before bed" mostly returns sleep listicles and show pages that name no
  // episode at all, so the pick came back empty.
  const kind = String(entity.type || '').includes('podcast') ? 'podcast' : 'show';
  const query = `"${entity.name}" ${kind} best episodes`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(cfg.tavily.baseUrl.replace(/\/$/, '') + '/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.tavily.apiKey}` },
      body: JSON.stringify({ query, max_results: 5, search_depth: 'basic', include_answer: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) return { available: false, note: `Tavily returned ${res.status}`, ms: Date.now() - started, query };
    const data = await res.json();
    return {
      available: true,
      query,
      ms: Date.now() - started,
      answer: String(data.answer || '').slice(0, 400),
      results: (data.results || []).slice(0, 5).map((r) => ({ title: String(r.title || '').slice(0, 160), url: String(r.url || ''), snippet: String(r.content || '').slice(0, 500) })),
    };
  } catch (err) {
    return { available: false, note: 'Tavily call failed: ' + err.message, ms: Date.now() - started, query };
  } finally {
    clearTimeout(timer);
  }
}

// Compare titles on letters and digits only. Web text and the model differ in
// case, quotes, dashes, escapes (Tavily answers can carry \\' ) and accents.
export const squash = (s) =>
  String(s || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’‘`\\]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

// The pick must be grounded in what Tavily returned, the same idea as the
// Qloo entity id check. A title the model wrote from memory is dropped.
export function groundEpisode(pick, search) {
  const title = String((pick && pick.title) || '').trim();
  if (title.length < 3 || title.length > 120) return null;
  const haystack = squash([search.answer, ...(search.results || []).flatMap((r) => [r.title, r.snippet])].join(' \n '));
  const needle = squash(title);
  if (needle.length < 3 || !` ${haystack} `.includes(` ${needle} `)) return null;
  // Source link: a result that names the episode, the model's choice first.
  const results = search.results || [];
  const names = (r) => ` ${squash(`${r.title} ${r.snippet}`)} `.includes(` ${needle} `);
  const urls = results.map((r) => r.url);
  const url = (results.find((r) => r.url === pick.url && names(r)) || results.find(names) || {}).url || (urls.includes(pick.url) ? pick.url : urls[0]) || '';
  // Only facts the search text states are shown. The episode number is kept
  // only if every number in it appears in a text that names the episode, and
  // the why line (about the person's taste) may not carry numbers or lengths.
  const sources = [...results.filter(names).map((r) => `${r.title} ${r.snippet}`), ...(` ${squash(search.answer)} `.includes(` ${needle} `) ? [search.answer] : [])];
  return {
    title: title.slice(0, 120),
    seasonEpisode: statedNumbers(String(pick.season_episode || '').slice(0, 30), sources),
    url,
    why: NUMBERISH.test(String(pick.why || '')) ? '' : String(pick.why || '').slice(0, 120),
  };
}

const NUMBERISH = /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|half|quarter|min|mins|minutes?|hours?|hrs?|seconds?|secs?|long|short|length|runtime)\b/i;
const numbersIn = (s) => (String(s || '').match(/\d+/g) || []).map((n) => String(Number(n)));

// Keeps the episode label only if it has numbers and all of them appear in
// one of the texts that name the episode. Anything else is dropped.
export function statedNumbers(label, sources) {
  const want = numbersIn(label);
  if (!label.trim() || !want.length) return '';
  const ok = sources.some((text) => {
    const have = new Set(numbersIn(text));
    return want.every((n) => have.has(n));
  });
  return ok ? label.trim() : '';
}

export function episodeMessages(entity, search, favorites = []) {
  return [
    { role: 'system', content: EPISODE_SYSTEM },
    { role: 'user', content: JSON.stringify({ title: entity.name, type: String(entity.type || '').replace('urn:entity:', ''), person_loves: favorites.slice(0, 6), search_answer: search.answer, results: search.results }) },
  ];
}
