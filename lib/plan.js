// Plan validation and the deterministic fallback planner.
// The planner model proposes, this file checks. A plan is rejected when it
// recommends anything that did not come back from a Qloo call in this run,
// puts a screen too close to sleep, or ends on something stimulating.

import { heuristicArousal } from './arousal.js';

export const LANES = {
  screen: ['urn:entity:tv_show', 'urn:entity:movie'],
  audio: ['urn:entity:podcast'],
  music: ['urn:entity:artist'],
  page: ['urn:entity:book'],
};

export const LIMITS = {
  maxStepArousal: 5,
  lastScreenMinutes: 45, // a screen step must start at least this long before sleep
  minSteps: 2,
  maxSteps: 5,
};

export function laneOf(type) {
  for (const [lane, types] of Object.entries(LANES)) if (types.includes(type)) return lane;
  return null;
}

export function arousalOf(scratch, id) {
  const r = scratch.ratings && scratch.ratings[id];
  if (r && typeof r.arousal === 'number') return r.arousal;
  const e = scratch.entities[id];
  return e ? heuristicArousal(e) : 10;
}

export function clockMinus(sleepBy, minutes) {
  const [h, m] = String(sleepBy || '23:30').split(':').map(Number);
  let total = (h * 60 + (m || 0) - minutes) % 1440;
  if (total < 0) total += 1440;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function trapIds(scratch) {
  return new Set(Object.values(scratch.resolved || {}).filter((r) => r && r.role === 'trap' && r.id).map((r) => r.id));
}

// Free-text check. The entity_id check grounds each step, but the instruction
// and why lines are written by the model. This scan rejects a quoted title,
// or a run of two or more capitalized words, that matches nothing Qloo
// returned in this run and nothing the person typed. It scans for names, so a
// title written all in lowercase could still slip through. That is why the UI
// shows each step's title from Qloo data, never from the model's text.
const ALLOWED_NAMES = [
  'do not disturb', 'night shift', 'screen time', 'airplane mode', 'sleep focus', 'wind down', 'low power mode',
  'apple podcasts', 'apple music', 'youtube music', 'spotify', 'cbt-i', 'offramp', 'qloo',
];
const CONNECTORS = new Set(['of', 'the', 'and', 'in', 'on', 'a', 'an', 'to', 'for', 'with', 'at', 'by', '&']);

function knownNames(scratch, input) {
  const names = [];
  for (const e of Object.values(scratch.entities || {})) if (e && e.name) names.push(String(e.name).toLowerCase());
  for (const [k, r] of Object.entries(scratch.resolved || {})) {
    names.push(k.toLowerCase());
    if (r && r.name) names.push(String(r.name).toLowerCase());
  }
  for (const s of [...((input && input.favorites) || []), ...((input && input.traps) || [])]) names.push(String(s).toLowerCase());
  if (scratch.episode && scratch.episode.title) names.push(String(scratch.episode.title).toLowerCase());
  return names.filter((n) => n.length >= 3);
}

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isKnown(phrase, names, quoted) {
  const p = phrase.toLowerCase().replace(/[’']s$/, '').trim();
  if (p.length < 3) return true;
  if (names.some((n) => n.includes(p))) return true;
  // Take out every known name and allowed phrase. What is left must not
  // still look like a name (two or more capitalized words), and a quoted
  // phrase must have nothing left at all.
  let rest = phrase;
  for (const n of [...names, ...ALLOWED_NAMES].filter((n) => n.length >= 4).sort((a, b) => b.length - a.length)) {
    rest = rest.replace(new RegExp(escapeRe(n), 'gi'), ' ');
  }
  const caps = rest.split(/\s+/).filter((w) => /^[A-Z0-9]/.test(w) && !CONNECTORS.has(w.toLowerCase()));
  return quoted ? caps.length === 0 && rest.replace(/[^A-Za-z]/g, '').length < 3 : caps.length < 2;
}

function findNames(text) {
  const found = [];
  const s = String(text || '');
  for (const m of s.matchAll(/["“”]([^"“”]{3,80})["“”]/g)) found.push({ text: m[1].trim(), quoted: true });
  for (const sentence of s.replace(/["“”]/g, ' ').split(/(?<=[.!?:;])\s+|\n+/)) {
    const words = sentence.split(/\s+/).filter(Boolean);
    let run = [];
    const flush = () => {
      while (run.length && CONNECTORS.has(run[run.length - 1].toLowerCase())) run.pop();
      const caps = run.filter((w) => /^[A-Z0-9]/.test(w));
      if (caps.length >= 2) found.push({ text: run.join(' ').replace(/[.,!?;:)]+$/, ''), quoted: false });
      run = [];
    };
    words.forEach((raw, i) => {
      const w = raw.replace(/^[(\[]+/, '');
      const bare = w.replace(/[,.!?;:)]+$/, '');
      const cap = /^[A-Z][\w'’&.-]*$/.test(bare) || /^[0-9]+[A-Za-z%]+[\w'’-]*$/.test(bare);
      // The first word of a sentence is capitalized anyway. Keep it only when
      // the next word is capitalized too (a name such as Brian Eno).
      const next = (words[i + 1] || '').replace(/[,.!?;:)]+$/, '');
      if (i === 0 && cap && !/^[A-Z]/.test(next)) return;
      if (cap) {
        run.push(w);
        if (w !== bare) flush();
      } else if (run.length && CONNECTORS.has(bare.toLowerCase())) run.push(w);
      else flush();
    });
    flush();
  }
  const seen = new Set();
  return found.filter((f) => !seen.has(f.text) && seen.add(f.text));
}

export function namesInText(text) {
  return findNames(text).map((f) => f.text);
}

export function unknownNames(text, scratch, input) {
  const names = knownNames(scratch, input);
  const stray = findNames(text).filter((f) => !isKnown(f.text, names, f.quoted)).map((f) => f.text);
  return stray.filter((n) => !stray.some((m) => m !== n && m.includes(n)));
}

export function validatePlan(plan, scratch, input) {
  const errors = [];
  const warnings = [];
  const windDown = Number(input.windDownMinutes) || 90;
  if (!plan || !Array.isArray(plan.steps)) return { ok: false, errors: ['submit_plan needs a steps array'], warnings };
  const steps = plan.steps;
  if (steps.length < LIMITS.minSteps || steps.length > LIMITS.maxSteps) {
    errors.push(`use ${LIMITS.minSteps} to ${LIMITS.maxSteps} steps, got ${steps.length}`);
  }
  const traps = trapIds(scratch);
  const skipIds = new Set((plan.skip_tonight || []).map((s) => s.entity_id));
  let prevMinutes = Infinity;
  let prevArousal = Infinity;
  steps.forEach((s, i) => {
    const label = `step ${i + 1}`;
    const e = scratch.entities[s.entity_id];
    if (!e) {
      errors.push(`${label} uses entity_id ${s.entity_id}, which no Qloo tool returned in this run. Pick an entity_id from a tool result.`);
      return;
    }
    const lane = laneOf(e.type);
    if (s.lane && lane && s.lane !== lane) errors.push(`${label} says lane ${s.lane} but ${e.name} is a ${e.type}`);
    const mins = Number(s.minutes_before_sleep);
    if (!Number.isFinite(mins) || mins < 0 || mins > windDown) errors.push(`${label} minutes_before_sleep must be between 0 and ${windDown}`);
    if (mins >= prevMinutes) errors.push(`${label} must come later in the night than the step before it (smaller minutes_before_sleep)`);
    prevMinutes = mins;
    if (lane === 'screen' && mins < LIMITS.lastScreenMinutes) {
      errors.push(`${label} is a screen at ${mins} minutes before sleep. Screens must start at least ${LIMITS.lastScreenMinutes} minutes before sleep.`);
    }
    const a = arousalOf(scratch, s.entity_id);
    if (a > LIMITS.maxStepArousal) errors.push(`${label} (${e.name}) has arousal ${a}, above the limit of ${LIMITS.maxStepArousal} for tonight`);
    if (a > prevArousal + 1) warnings.push(`${label} (${e.name}) is more stimulating than the step before it`);
    prevArousal = Math.min(prevArousal, a);
    if (traps.has(s.entity_id)) errors.push(`${label} uses ${e.name}, which the person named as what keeps them up`);
    if (skipIds.has(s.entity_id)) errors.push(`${label} uses ${e.name}, which the plan also lists under skip_tonight`);
    const stray = unknownNames(`${s.instruction || ''}\n${s.why || ''}`, scratch, input);
    if (stray.length) errors.push(`${label} text names ${stray.map((n) => `"${n}"`).join(', ')}, which no Qloo tool returned in this run. Name only titles from tool results.`);
  });
  const last = steps[steps.length - 1];
  const lastEntity = last && scratch.entities[last.entity_id];
  if (lastEntity && !['audio', 'music'].includes(laneOf(lastEntity.type))) {
    errors.push('the last step must be audio only (a podcast or an artist), so the eyes can close');
  }
  if (plan.if_awake && plan.if_awake.entity_id) {
    const e = scratch.entities[plan.if_awake.entity_id];
    if (!e) errors.push('if_awake uses an entity_id no Qloo tool returned');
    else if (!['page', 'music', 'audio'].includes(laneOf(e.type))) errors.push('if_awake should be a book, a podcast or an artist');
    const stray = unknownNames(`${plan.if_awake.instruction || ''}\n${plan.if_awake.why || ''}`, scratch, input);
    if (stray.length) errors.push(`if_awake text names ${stray.map((n) => `"${n}"`).join(', ')}, which no Qloo tool returned in this run`);
  }
  for (const s of plan.skip_tonight || []) {
    if (!scratch.entities[s.entity_id]) errors.push(`skip_tonight uses entity_id ${s.entity_id}, which no Qloo tool returned`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function enrichPlan(plan, scratch, input, meta = {}) {
  const sleepBy = input.sleepBy || '23:30';
  const view = (id) => {
    const e = scratch.entities[id];
    if (!e) return null;
    const because = (e.because || [])
      .map((b) => scratch.entities[b.id] && scratch.entities[b.id].name)
      .filter(Boolean);
    return {
      id: e.id,
      name: e.name,
      type: e.type,
      lane: laneOf(e.type),
      affinity: e.affinity,
      arousal: arousalOf(scratch, id),
      arousalReason: (scratch.ratings && scratch.ratings[id] && scratch.ratings[id].reason) || '',
      arousalBy: (scratch.ratings && scratch.ratings[id] && scratch.ratings[id].by) || 'heuristic',
      because,
      tags: (e.tags || []).slice(0, 4).map((t) => t.name),
      description: e.description,
      image: e.image,
      source: e.source || 'unknown',
    };
  };
  return {
    headline: plan.headline || 'Tonight’s offramp',
    note: plan.note || '',
    sleepBy,
    windDownMinutes: Number(input.windDownMinutes) || 90,
    steps: plan.steps.map((s) => ({
      at: clockMinus(sleepBy, Number(s.minutes_before_sleep)),
      minutesBeforeSleep: Number(s.minutes_before_sleep),
      instruction: s.instruction || '',
      why: s.why || '',
      item: view(s.entity_id),
      episode: s.episode || null,
    })),
    ifAwake: plan.if_awake && plan.if_awake.entity_id
      ? { instruction: plan.if_awake.instruction || '', why: plan.if_awake.why || '', item: view(plan.if_awake.entity_id) }
      : null,
    skipTonight: (plan.skip_tonight || []).map((s) => ({ why: s.why || '', item: view(s.entity_id) })).filter((s) => s.item),
    meta,
  };
}

function score(scratch, id) {
  const e = scratch.entities[id];
  const affinity = typeof e.affinity === 'number' ? e.affinity : 0.5;
  const a = arousalOf(scratch, id);
  return affinity * Math.pow(1 - a / 10, 1.5);
}

function bestFrom(scratch, ids, used, maxArousal = LIMITS.maxStepArousal) {
  const traps = trapIds(scratch);
  const pool = ids.filter((id) => scratch.entities[id] && !used.has(id) && !traps.has(id) && arousalOf(scratch, id) <= maxArousal);
  pool.sort((a, b) => score(scratch, b) - score(scratch, a));
  return pool[0] || null;
}

// Deterministic planner. Used by the offline mock and as the safety net if
// the planner model runs out of steps.
export function autoPlan(scratch, input) {
  const windDown = Number(input.windDownMinutes) || 90;
  const screenOk = !(input.prefs && input.prefs.screen_ok === false);
  const cands = scratch.candidates || {};
  const used = new Set();
  const steps = [];
  if (screenOk && cands.screen && cands.screen.length) {
    const id = bestFrom(scratch, cands.screen, used, 4);
    if (id) {
      used.add(id);
      steps.push({
        minutes_before_sleep: windDown,
        lane: 'screen',
        entity_id: id,
        instruction: `One episode or one short stretch of ${scratch.entities[id].name}. When it ends, the screen goes off and the phone goes across the room.`,
        why: 'Your taste, but low stakes and with a clear end.',
      });
    }
  }
  const audio = bestFrom(scratch, cands.audio || [], used);
  if (audio) {
    used.add(audio);
    steps.push({
      minutes_before_sleep: Math.min(windDown - 5, 45),
      lane: 'audio',
      entity_id: audio,
      instruction: `Lights low. Put on ${scratch.entities[audio].name} with the screen face down.`,
      why: 'Audio keeps the company you like without the pull of a picture.',
    });
  }
  const music = bestFrom(scratch, cands.music || [], used);
  if (music) {
    used.add(music);
    steps.push({
      minutes_before_sleep: 15,
      lane: 'music',
      entity_id: music,
      instruction: `In bed. ${scratch.entities[music].name} at low volume with a 30 minute sleep timer.`,
      why: 'Familiar, slow sound for the last stretch.',
    });
  }
  const book = bestFrom(scratch, cands.page || [], used);
  const radar = [...(cands.trap_radar || []), ...Object.values(scratch.resolved || {}).filter((r) => r && r.role === 'trap' && r.id).map((r) => r.id)];
  const skip = [...new Set(radar)]
    .filter((id) => scratch.entities[id] && !used.has(id) && arousalOf(scratch, id) >= 6)
    .sort((a, b) => (scratch.entities[b].affinity || 0) - (scratch.entities[a].affinity || 0))
    .slice(0, 3)
    .map((id) => ({ entity_id: id, why: 'High affinity and high arousal. Save it for a weekend afternoon.' }));
  return {
    headline: 'Your taste, in the right order',
    steps,
    if_awake: book
      ? {
          entity_id: book,
          instruction: `Still awake after about 20 minutes? Get up, keep the light dim, read a few pages of ${scratch.entities[book].name}, and go back to bed when you feel sleepy.`,
          why: 'Leaving the bed when sleep does not come keeps the bed linked with sleep.',
        }
      : null,
    skip_tonight: skip,
    note: 'Nothing here is off limits forever. Tonight is about order and timing.',
  };
}
