// Qloo client with three sources, always labeled in the receipts.
//   live      a real call to the Qloo API (hackathon base URL, X-Api-Key header)
//   snapshot  a real Qloo response recorded earlier with `npm run record`
//   sample    the bundled offline catalog in data/sample-qloo.json (not Qloo output)
// Live is used whenever a key is configured. If Qloo rejects the key (for
// example after hackathon keys are switched off), the client falls back to a
// recorded snapshot for the same request, then to the sample catalog.
//
// Recorded Qloo responses are a private server-side cache. Qloo's hackathon
// guide asks builders not to store Qloo response data in a public repository,
// so snapshots never live in git. They are read from a gitignored local file
// (data/qloo-snapshots.local.json) or from the QLOO_SNAPSHOTS_GZ_B64
// environment variable set in the hosting dashboard.

import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { getConfig } from './config.js';

const require = createRequire(import.meta.url);
const SAMPLE = require('../data/sample-qloo.json');
export const SNAPSHOT_PATH = fileURLToPath(new URL('../data/qloo-snapshots.local.json', import.meta.url));
const SNAPSHOTS = loadSnapshots();

function loadSnapshots() {
  const fromEnv = process.env.QLOO_SNAPSHOTS_GZ_B64;
  if (fromEnv) {
    try {
      return JSON.parse(gunzipSync(Buffer.from(fromEnv, 'base64')).toString('utf8'));
    } catch {
      // A broken value must never take the app down. Fall through.
    }
  }
  try {
    if (existsSync(SNAPSHOT_PATH)) return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch {
    // Same as above.
  }
  return {};
}

export function snapshotCount() {
  return Object.keys(SNAPSHOTS).filter((k) => !k.startsWith('~')).length;
}

export function allSnapshots() {
  return SNAPSHOTS;
}

// Internal entity types. Qloo's hackathon guide spells the video game type
// urn:entity:video_game, while older Qloo material uses urn:entity:videogame.
// The app keeps one internal spelling and translates at the API boundary.
// If Qloo answers 400, the other spelling is tried once and remembered.
export const ENTITY_TYPES = {
  artist: 'urn:entity:artist',
  book: 'urn:entity:book',
  movie: 'urn:entity:movie',
  podcast: 'urn:entity:podcast',
  tv_show: 'urn:entity:tv_show',
  videogame: 'urn:entity:videogame',
};
const SEARCH_TYPES_ALL = Object.values(ENTITY_TYPES).join(',');
const GAME_SPELLINGS = ['urn:entity:video_game', 'urn:entity:videogame'];
const GAME_RE = /urn:entity:video_?game/g;
let gameWire = GAME_SPELLINGS.includes(process.env.QLOO_VIDEOGAME_TYPE) ? process.env.QLOO_VIDEOGAME_TYPE : GAME_SPELLINGS[0];
const TYPE_PARAMS = ['types', 'filter.type', 'filter.parents.types'];

export function canonicalType(value) {
  return typeof value === 'string' ? value.replace(/urn:entity:video_game\b/g, ENTITY_TYPES.videogame) : value;
}

function toWire(value) {
  return String(value).replace(GAME_RE, gameWire);
}

export function isSampleId(id) {
  return typeof id === 'string' && (id.startsWith('sample-') || id.startsWith('sample:'));
}

// Tag types worth showing to a model or a person. Qloo entities can carry
// around a hundred tags, many about audience or logistics.
const USEFUL_TAG_HINT = /(genre|keyword|style|mood|subgenre|theme|category|sample)/i;

class QlooAuthError extends Error {}

export function requestKey(path, params) {
  const sorted = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return `${path}?${sorted}`;
}

// A looser key so a recorded snapshot still answers when the live planner asks
// for the same thing with slightly different tags or result counts.
export function looseKey(path, params) {
  const p = params || {};
  if (path === '/v2/insights') {
    const ids = String(p['signal.interests.entities'] || '').split(',').filter(Boolean).sort().join(',');
    return `~${path}|${p['filter.type']}|${ids}|${p['filter.tags'] ? 'tagged' : 'open'}`;
  }
  if (path === '/search') return `~${path}|${String(p.query || '').toLowerCase().trim()}`;
  if (path === '/v2/tags') return `~${path}|${String(p['filter.query'] || '').toLowerCase().trim()}|${p['filter.parents.types'] || ''}`;
  return `~${path}`;
}

function fromSnapshot(path, params) {
  return SNAPSHOTS[requestKey(path, params)] || SNAPSHOTS[looseKey(path, params)] || null;
}

// Qloo documents feature.explainability as a per-result query.explainability
// section that lists which signal entities contributed and by how much (0 to
// 1). The nesting is read defensively, so a shape change only hides the
// "Because you like" line instead of breaking a run.
export function explainList(q) {
  const ex = q && q.explainability;
  if (!ex || typeof ex !== 'object') return [];
  let list = ex['signal.interests.entities'] ?? (ex.signal && ex.signal.interests && ex.signal.interests.entities) ?? ex;
  if (list && !Array.isArray(list) && typeof list === 'object') {
    if (Array.isArray(list.entities)) list = list.entities;
    else list = Object.entries(list).filter(([, v]) => typeof v === 'number').map(([k, v]) => ({ entity_id: k, score: v }));
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x === 'object' && (x.entity_id || x.id))
    .map((x) => ({ entity_id: x.entity_id || x.id, score: Number(x.score ?? x.weight ?? x.impact ?? 0) || 0 }))
    .sort((a, b) => b.score - a.score);
}

function entityType(e) {
  const subtype = typeof e.subtype === 'string' && e.subtype.startsWith('urn:entity:') ? e.subtype : null;
  const types = Array.isArray(e.types) ? e.types.filter((t) => typeof t === 'string' && t.startsWith('urn:entity:')) : [];
  return canonicalType(subtype || types[0] || e.type || '');
}

function usefulTags(list) {
  return (list || [])
    .map((t) => (typeof t === 'string' ? sampleTag(t) : t && { id: t.id || t.tag_id, name: t.name, type: t.type || '' }))
    .filter((t) => t && t.name && (!t.type || USEFUL_TAG_HINT.test(t.type) || USEFUL_TAG_HINT.test(t.id || '')));
}

export function normalizeEntity(e) {
  if (!e) return null;
  const q = e.query || {};
  const props = e.properties || {};
  return {
    id: e.entity_id || e.id,
    name: e.name,
    type: entityType(e),
    popularity: typeof e.popularity === 'number' ? round(e.popularity) : null,
    affinity: typeof q.affinity === 'number' ? round(q.affinity) : null,
    because: explainList(q).map((x) => ({ id: x.entity_id, score: round(x.score) })).slice(0, 3),
    tags: usefulTags(e.tags).slice(0, 10),
    description: String(props.description || props.short_description || e.description || '').slice(0, 220),
    year: props.release_year || null,
    image: (props.image && props.image.url) || null,
  };
}

// What a recorded snapshot keeps: only the fields normalizeEntity reads, so
// the private cache stays small enough for one environment variable.
function trimEntity(e) {
  if (!e || typeof e !== 'object') return e;
  const q = e.query || {};
  const props = e.properties || {};
  const out = { entity_id: e.entity_id || e.id, name: e.name };
  if (e.subtype) out.subtype = e.subtype;
  if (Array.isArray(e.types)) out.types = e.types.slice(0, 3);
  if (e.type) out.type = e.type;
  if (typeof e.popularity === 'number') out.popularity = round(e.popularity);
  const query = {};
  if (typeof q.affinity === 'number') query.affinity = round(q.affinity);
  const ex = explainList(q).slice(0, 3).map((x) => ({ entity_id: x.entity_id, score: round(x.score) }));
  if (ex.length) query.explainability = { 'signal.interests.entities': ex };
  if (Object.keys(query).length) out.query = query;
  const tags = usefulTags(e.tags).slice(0, 6);
  if (tags.length) out.tags = tags;
  const description = String(props.description || props.short_description || e.description || '').slice(0, 160);
  if (description) out.properties = { description, ...(props.release_year ? { release_year: props.release_year } : {}) };
  return out;
}

export function trimResponse(path, data) {
  if (!data || typeof data !== 'object') return data;
  if (path === '/search') {
    const raw = Array.isArray(data.results) ? data.results : (data.results && data.results.entities) || [];
    return { results: raw.slice(0, 5).map(trimEntity) };
  }
  if (path === '/v2/insights') {
    return { results: { entities: ((data.results && data.results.entities) || []).slice(0, 15).map(trimEntity) } };
  }
  if (path === '/v2/tags') {
    const raw = (data.results && data.results.tags) || [];
    return { results: { tags: raw.slice(0, 10).map((t) => ({ id: t.id || t.tag_id, name: t.name, type: t.type || '' })) } };
  }
  return data;
}

function sampleTag(id) {
  const t = SAMPLE.tags.find((x) => x.id === id);
  return t ? { id: t.id, name: t.name, type: 'sample' } : null;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createQloo(cfg = getConfig()) {
  const receipts = [];
  let lastCall = 0;
  const OPTIONAL_PARAMS = ['bias.trends', 'feature.explainability'];

  // One live request. A 400 is retried with up to three fixes, each used at
  // most once and each written into the receipt: drop the optional tuning
  // parameters, try the other video game spelling, and (for search only) drop
  // the types filter and filter locally instead.
  async function live(path, params) {
    const wait = lastCall + cfg.qloo.paceMs - Date.now();
    if (wait > 0) await sleep(wait);
    const url = new URL(cfg.qloo.baseUrl + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === '') continue;
      url.searchParams.set(k, TYPE_PARAMS.includes(k) ? toWire(v) : String(v));
    }
    const notes = [];
    let typesDropped = false;
    let previousWire = null;
    const fixes = [
      {
        when: () => OPTIONAL_PARAMS.some((k) => url.searchParams.has(k)),
        apply: () => {
          OPTIONAL_PARAMS.forEach((k) => url.searchParams.delete(k));
          notes.push('Qloo rejected an optional parameter, retried without bias.trends and explainability');
        },
      },
      {
        when: () => TYPE_PARAMS.some((k) => /urn:entity:video_?game/.test(url.searchParams.get(k) || '')),
        apply: () => {
          previousWire = gameWire;
          gameWire = gameWire === GAME_SPELLINGS[0] ? GAME_SPELLINGS[1] : GAME_SPELLINGS[0];
          TYPE_PARAMS.forEach((k) => url.searchParams.has(k) && url.searchParams.set(k, toWire(url.searchParams.get(k))));
          notes.push(`retried with the video game type spelled ${gameWire}`);
        },
      },
      {
        when: () => path === '/search' && url.searchParams.has('types'),
        apply: () => {
          url.searchParams.delete('types');
          url.searchParams.set('take', '10');
          typesDropped = true;
          notes.push('Qloo rejected the types filter on search, retried without it and filtered locally');
        },
      },
    ];
    const delays = [500, 1000, 2000];
    let attempt = 0;
    for (;;) {
      lastCall = Date.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.qloo.timeoutMs);
      let res;
      try {
        res = await fetch(url, { headers: { 'X-Api-Key': cfg.qloo.apiKey, accept: 'application/json' }, signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 401 || res.status === 403) {
        if (previousWire) gameWire = previousWire;
        throw new QlooAuthError(`Qloo rejected the key (${res.status})`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < delays.length) {
        await sleep(delays[attempt++]);
        continue;
      }
      if (res.status === 400) {
        const fix = fixes.find((f) => !f.used && f.when());
        if (fix) {
          fix.used = true;
          fix.apply();
          continue;
        }
      }
      if (!res.ok) {
        if (previousWire) gameWire = previousWire;
        const body = (await res.text()).slice(0, 200);
        throw new Error(`Qloo ${path} returned ${res.status}: ${body}`);
      }
      return { data: await res.json(), notes, typesDropped };
    }
  }

  async function call(path, params, sampleFn, opts = {}) {
    const started = Date.now();
    const key = requestKey(path, params);
    let source = 'sample';
    let data;
    let note = opts.note;
    let typesDropped = false;
    if (cfg.qloo.enabled && !opts.offline) {
      try {
        const out = await live(path, params);
        data = out.data;
        typesDropped = out.typesDropped;
        source = 'live';
        if (out.notes.length) note = out.notes.join('. ');
        if (cfg.qloo.record) {
          const trimmed = trimResponse(path, data);
          SNAPSHOTS[key] = trimmed;
          SNAPSHOTS[looseKey(path, params)] = trimmed;
          writeFileSync(SNAPSHOT_PATH, JSON.stringify(SNAPSHOTS));
        }
      } catch (err) {
        note = err.message;
        const snap = fromSnapshot(path, params);
        if (snap) {
          data = snap;
          source = 'snapshot';
        }
        if (!(err instanceof QlooAuthError) && !data) {
          // Network trouble on a live call. Fall through to sample data, but say so.
          note = 'live call failed, using sample data: ' + err.message;
        }
      }
    } else if (!cfg.qloo.forceSample && !opts.offline) {
      const snap = fromSnapshot(path, params);
      if (snap) {
        data = snap;
        source = 'snapshot';
      }
    }
    if (!data) {
      data = sampleFn();
      source = 'sample';
    }
    const receipt = { endpoint: path, params: { ...params }, source, ms: Date.now() - started };
    if (note) receipt.note = note;
    receipts.push(receipt);
    return { data, receipt, typesDropped };
  }

  return {
    receipts,

    async search(query, { types = SEARCH_TYPES_ALL, take = 3 } = {}) {
      const params = { query, types, take };
      const { data, receipt, typesDropped } = await call('/search', params, () => sampleSearch(query, types, take));
      const raw = Array.isArray(data.results) ? data.results : (data.results && data.results.entities) || [];
      let results = raw.map(normalizeEntity).filter((e) => e && e.id && e.name);
      if (typesDropped) {
        const wanted = String(types).split(',').map(canonicalType);
        const kept = results.filter((r) => wanted.includes(r.type));
        if (kept.length) results = kept;
      }
      results = results.slice(0, take);
      receipt.count = results.length;
      return { source: receipt.source, results };
    },

    async tags(query, { parentType, take = 8 } = {}) {
      const params = { 'filter.query': query, 'filter.parents.types': parentType, take };
      const { data, receipt } = await call('/v2/tags', params, () => sampleTags(query, parentType, take));
      const raw = (data.results && data.results.tags) || [];
      const tags = raw.map((t) => ({ id: t.id || t.tag_id, name: t.name, type: t.type || '' })).filter((t) => t.id);
      receipt.count = tags.length;
      return { source: receipt.source, tags };
    },

    async insights({ type, signalEntities = [], tags = [], excludeEntities = [], take = 10, explain = true, trendBias }) {
      // Ids from the offline catalog mean nothing to the live API (they can
      // appear if one earlier live call fell back to sample data), so a live
      // request only carries real Qloo ids.
      let signals = signalEntities;
      let exclude = excludeEntities;
      let tagIds = tags;
      let opts = {};
      if (cfg.qloo.enabled) {
        signals = signals.filter((id) => !isSampleId(id));
        exclude = exclude.filter((id) => !isSampleId(id));
        tagIds = tagIds.filter((id) => !isSampleId(id));
        if (!signals.length) {
          signals = signalEntities;
          exclude = excludeEntities;
          tagIds = tags;
          opts = { offline: true, note: 'no live Qloo ids to use as signals, used sample data' };
        }
      }
      const params = {
        'filter.type': type,
        'signal.interests.entities': signals.join(','),
        'filter.tags': tagIds.join(','),
        'operator.filter.tags': tagIds.length ? 'union' : undefined,
        'filter.exclude.entities': exclude.join(','),
        // Novelty is arousing at night. Calm lanes turn Qloo's trend bias down
        // so familiar favorites rank above whatever is trending this week.
        'bias.trends': trendBias,
        'feature.explainability': explain ? 'true' : undefined,
        take: Math.max(1, Math.min(50, take)),
      };
      const { data, receipt } = await call(
        '/v2/insights',
        params,
        () => sampleInsights({ type, signalEntities: signals, tags: tagIds, excludeEntities: exclude, take }),
        opts
      );
      const raw = (data.results && data.results.entities) || [];
      const entities = raw.map(normalizeEntity).filter((e) => e && e.id && e.name);
      receipt.count = entities.length;
      return { source: receipt.source, entities };
    },
  };
}

// ---------- offline sample catalog ----------

const ALIASES = {
  'studio ghibli': ['sample-mv-spiritedaway', 'sample-mv-totoro'],
  ghibli: ['sample-mv-spiritedaway', 'sample-mv-totoro'],
  miyazaki: ['sample-mv-spiritedaway', 'sample-mv-totoro'],
  'bob ross': ['sample-tv-joyofpainting'],
  'bake off': ['sample-tv-bakeoff'],
  'great british baking show': ['sample-tv-bakeoff'],
};

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rawSample(id) {
  const e = SAMPLE.entities.find((x) => x.entity_id === id);
  return e ? { ...e } : null;
}

export function sampleSearch(query, types, take) {
  const q = norm(query);
  const allowed = String(types || '').split(',').filter(Boolean);
  const pool = SAMPLE.entities.filter((e) => !allowed.length || allowed.includes(e.type));
  let hits = [];
  if (ALIASES[q]) hits = ALIASES[q].map(rawSample).filter((e) => e && pool.some((p) => p.entity_id === e.entity_id));
  if (!hits.length) {
    const exact = pool.filter((e) => norm(e.name) === q);
    const partial = pool.filter((e) => !exact.includes(e) && q.length > 2 && (norm(e.name).includes(q) || q.includes(norm(e.name))));
    hits = [...exact, ...partial];
  }
  return { results: hits.slice(0, take).map((e) => ({ ...e, types: [e.type] })) };
}

export function sampleTags(query, parentType, take) {
  const q = norm(query);
  const words = q.split(' ').filter((w) => w.length > 2);
  const tags = SAMPLE.tags
    .filter((t) => !parentType || t.types.includes(parentType))
    .filter((t) => {
      const n = norm(t.name);
      return n.includes(q) || words.some((w) => n.includes(w) || w.includes(n.slice(0, 5)));
    })
    .slice(0, take)
    .map((t) => ({ id: t.id, name: t.name, type: 'sample' }));
  return { success: true, results: { tags } };
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export function sampleInsights({ type, signalEntities = [], tags = [], excludeEntities = [], take = 10 }) {
  const signals = signalEntities.map(rawSample).filter(Boolean);
  const signalTags = new Set(signals.flatMap((s) => s.tags));
  const pool = SAMPLE.entities.filter(
    (e) =>
      e.type === type &&
      !excludeEntities.includes(e.entity_id) &&
      !signalEntities.includes(e.entity_id) &&
      (!tags.length || e.tags.some((t) => tags.includes(t)))
  );
  const scored = pool.map((e) => {
    const shared = e.tags.filter((t) => signalTags.has(t)).length;
    const sim = signalTags.size ? shared / Math.max(1, Math.min(e.tags.length, signalTags.size)) : 0;
    const affinity = Math.min(0.99, 0.5 + 0.3 * sim + 0.15 * e.popularity + 0.05 * hash(e.entity_id + signalEntities.join()));
    const because = signals
      .map((s) => ({ entity_id: s.entity_id, score: round(s.tags.filter((t) => e.tags.includes(t)).length / Math.max(1, e.tags.length)) }))
      .filter((b) => b.score > 0)
      .sort((a, b) => b.score - a.score);
    return { ...e, query: { affinity: round(affinity), explainability: { 'signal.interests.entities': because } } };
  });
  scored.sort((a, b) => b.query.affinity - a.query.affinity);
  return { success: true, results: { entities: scored.slice(0, take) } };
}
