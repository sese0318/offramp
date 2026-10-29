// Deterministic stand-in for Nemotron, used when NEBIUS_API_KEY is not set.
// It follows the same tool protocol as the live planner so the whole agent,
// including validation and the UI trace, can be tested offline. Every receipt
// it produces is labeled mock.

import { heuristicArousal } from './arousal.js';
import { autoPlan } from './plan.js';
import { sampleSearch } from './qloo.js';

let callSeq = 0;
const toolCall = (name, args) => ({
  id: `mock-${++callSeq}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const HABIT = /(youtube|tiktok|instagram|reels|reddit|twitter|x\.com|scroll|twitch|shorts|news|feed|phone)/i;

function guessKind(name) {
  if (HABIT.test(name)) return 'habit';
  const hit = sampleSearch(name, '', 1).results[0];
  if (hit) return hit.type.replace('urn:entity:', '');
  if (/podcast/i.test(name)) return 'podcast';
  return 'unknown';
}

function mockIntake(input) {
  const notes = String(input.notes || '');
  const constraints = [];
  if (/(room|roommate|partner|dorm)/i.test(notes)) constraints.push('shares a room, keep sound low or use headphones');
  if (/(silence|white noise|need sound|need noise)/i.test(notes)) constraints.push('needs some sound to fall asleep');
  return {
    favorites: input.favorites.map((name) => ({ name, kind: guessKind(name) })),
    traps: input.traps.map((name) => ({ name, kind: guessKind(name) })),
    constraints,
    screen_ok: !/(no screens?|screen free|without screens?)/i.test(notes) && input.prefs.screen_ok !== false,
  };
}

function mockRatings(items) {
  return {
    ratings: (items || []).map((it) => {
      const entity = { name: it.name, description: it.description, tags: (it.tags || []).map((name) => ({ name })), type: 'urn:entity:' + it.type };
      const arousal = heuristicArousal(entity);
      const reason = arousal >= 6 ? 'suspense or high stakes keep attention up' : arousal <= 2 ? 'slow, gentle and familiar' : 'mild, low stakes';
      return { id: it.id, arousal, reason };
    }),
  };
}

// The fixed tool sequence. The offline mock planner uses it, and so does the
// agent's safety net when the planner model cannot be reached.
export function scriptedTurn({ scratch, intake, input }) {
  const f = scratch.flags;
  if (!f.resolved) {
    const items = [
      ...intake.favorites.filter((x) => x.kind !== 'habit').map((x) => ({ name: x.name, kind: x.kind, role: 'favorite' })),
      ...intake.traps.filter((x) => x.kind !== 'habit').map((x) => ({ name: x.name, kind: x.kind, role: 'trap' })),
    ];
    return { content: 'First I will find what you named in the Qloo taste graph.', tool_calls: [toolCall('resolve_taste', { items })] };
  }
  if (!f.tags) {
    const asks = [
      ['relaxing', 'podcast'],
      ['sleep', 'podcast'],
      ['ambient', 'artist'],
      ['calm', 'artist'],
      ['calm', 'tv_show'],
      ['cozy', 'book'],
    ];
    return { content: 'Next, calm tag ids for each lane.', tool_calls: asks.map(([query, entity_type]) => toolCall('find_tags', { query, entity_type })) };
  }
  const favorites = Object.values(scratch.resolved).filter((r) => r.role === 'favorite' && r.id).map((r) => r.id);
  if (!scratch.candidates.audio && favorites.length) {
    const tagIds = (k) => (scratch.tags[k] || []).map((t) => t.id);
    const calls = [];
    if (intake.screen_ok !== false) calls.push(toolCall('recommend', { lane: 'screen', entity_type: 'tv_show', signal_entity_ids: favorites, tag_ids: tagIds('tv_show'), take: 8 }));
    calls.push(toolCall('recommend', { lane: 'audio', entity_type: 'podcast', signal_entity_ids: favorites, tag_ids: tagIds('podcast'), take: 8 }));
    calls.push(toolCall('recommend', { lane: 'music', entity_type: 'artist', signal_entity_ids: favorites, tag_ids: tagIds('artist'), take: 8 }));
    calls.push(toolCall('recommend', { lane: 'page', entity_type: 'book', signal_entity_ids: favorites, tag_ids: tagIds('book'), take: 6 }));
    calls.push(toolCall('recommend', { lane: 'trap_radar', entity_type: 'tv_show', signal_entity_ids: favorites, take: 6 }));
    calls.push(toolCall('recommend', { lane: 'trap_radar', entity_type: 'podcast', signal_entity_ids: favorites, take: 4 }));
    return { content: 'Now taste-matched candidates for each lane, plus a trap radar.', tool_calls: calls };
  }
  if (!f.rated) {
    const ids = [...new Set(Object.values(scratch.candidates).flat())].slice(0, 30);
    return { content: 'Rating every candidate for pre-sleep arousal.', tool_calls: [toolCall('rate_arousal', { entity_ids: ids })] };
  }
  const plan = autoPlan(scratch, input);
  return { content: 'Putting it in order, calmest last.', tool_calls: [toolCall('submit_plan', plan)] };
}

function mockBaseline(messages) {
  return [
    '1. Turn off screens an hour before bed.',
    '2. Dim the lights and take a warm shower.',
    '3. Read a book or listen to calming music.',
    '4. Try deep breathing or meditation once you are in bed.',
    '(Offline mock. With a Nebius key this is the same Nemotron planner model, answering without Qloo.)',
  ].join('\n');
}

function mockReflect(logs) {
  const nights = Array.isArray(logs) ? logs : [];
  const late = nights.filter((n) => Number(n.minutesLate) > 20);
  const screenPulled = nights.filter((n) => /episode|video|scroll|phone|youtube|tiktok/i.test(String(n.pulledBy || '')));
  const audioHelped = nights.filter((n) => (n.followed || []).includes('audio') && Number(n.minutesLate) <= 20);
  return {
    summary: nights.length
      ? `${nights.length} nights logged. ${late.length} ran more than 20 minutes past the target, and on ${screenPulled.length} nights a screen is what pulled you back.`
      : 'No nights logged yet.',
    what_worked: audioHelped.length ? [`On ${audioHelped.length} nights the audio step got you to sleep close to the target.`] : [],
    changes: [
      screenPulled.length >= 2
        ? { change: 'Start the audio step 15 minutes earlier and skip the screen step for three nights.', why: 'Most late nights started with one more episode or video.' }
        : { change: 'Keep the same order and protect the last 15 minutes.', why: 'The plan mostly held.' },
    ],
    tomorrow: { start_earlier_minutes: screenPulled.length >= 2 ? 15 : 0, skip_screen: screenPulled.length >= 2, note: 'Offline mock reflection. With a Nebius key this runs on Nemotron 3 Ultra.' },
  };
}

export function mockChat(tier, req) {
  const purpose = String(req.purpose || '');
  const ctx = req.context || {};
  let message;
  if (purpose.startsWith('intake')) {
    message = { role: 'assistant', content: JSON.stringify(mockIntake(ctx.input)) };
  } else if (purpose.startsWith('rate_arousal')) {
    message = { role: 'assistant', content: JSON.stringify(mockRatings(ctx.items)) };
  } else if (purpose.startsWith('plan')) {
    const turn = scriptedTurn(ctx);
    message = { role: 'assistant', content: turn.content, tool_calls: turn.tool_calls };
  } else if (purpose.startsWith('baseline')) {
    message = { role: 'assistant', content: mockBaseline(req.messages) };
  } else if (purpose.startsWith('pick_episode')) {
    // Offline stand-in: take the first quoted title in the search results.
    const results = (ctx.search && ctx.search.results) || [];
    let title = '';
    for (const r of results) {
      const m = String(r.title + ' ' + r.snippet).match(/["“]([^"”]{3,80})["”]/);
      if (m) {
        title = m[1];
        break;
      }
    }
    message = { role: 'assistant', content: JSON.stringify({ title, season_episode: '', url: (results[0] && results[0].url) || '', why: 'gentle and complete on its own' }) };
  } else if (purpose.startsWith('reflect')) {
    message = { role: 'assistant', content: JSON.stringify(mockReflect(ctx.logs)) };
  } else {
    message = { role: 'assistant', content: '{}' };
  }
  const chars = JSON.stringify(req.messages || []).length + JSON.stringify(message).length;
  return { message, usage: { total_tokens: Math.round(chars / 4) } };
}
