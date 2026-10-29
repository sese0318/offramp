// Offramp front end. Plain modules, no build step.

const PERSONAS = [
  {
    id: 'one-more-episode',
    label: 'One more episode',
    who: 'Nursing student, early clinicals, falls asleep at 2 after Breaking Bad',
    input: {
      favorites: ['Spirited Away', 'Phoebe Bridgers', 'Serial', 'The Great British Bake Off'],
      traps: ['Breaking Bad', 'YouTube video essays'],
      sleepBy: '00:30',
      windDownMinutes: 90,
      notes: 'I share a dorm room so I use earbuds. I keep telling myself one more episode.',
    },
  },
  {
    id: 'doomscroll-playlist',
    label: 'Scroll, then playlist',
    who: 'Line cook, home at 11 after a late shift, wired and scrolling',
    input: {
      favorites: ['Radiohead', 'Parks and Recreation', 'Hidden Brain', 'Piranesi'],
      traps: ['Stranger Things', 'TikTok'],
      sleepBy: '01:00',
      windDownMinutes: 60,
      notes: 'I need some sound to fall asleep. Silence makes my brain loud.',
    },
  },
  {
    id: 'one-more-boss',
    label: 'One more boss',
    who: 'Grad student who games to decompress and loses track of time',
    input: {
      favorites: ['Joe Hisaishi', 'Stardew Valley', 'The Hobbit', 'My Neighbor Totoro'],
      traps: ['Elden Ring', 'Crime Junkie'],
      sleepBy: '23:45',
      windDownMinutes: 90,
      notes: 'No screens tonight if possible, my eyes are tired.',
    },
  },
];

const LANE_LABEL = {
  screen: 'Last screen',
  audio: 'Lights low, audio only',
  music: 'In bed, eyes closed',
  page: 'If you are still awake',
};
// Sample mode must never look like Qloo output. Its ids and scores are made
// up, so every label says so.
const SOURCE_LABEL = { live: 'Qloo live', snapshot: 'Qloo recorded', sample: 'offline sample, not Qloo', unknown: 'source unknown' };
const TYPE_LABEL = { tv_show: 'TV show', movie: 'film', podcast: 'podcast', artist: 'artist', book: 'book', videogame: 'game' };
const typeName = (t) => TYPE_LABEL[String(t || '').replace('urn:entity:', '')] || String(t || '').replace('urn:entity:', '');
let qlooMode = 'sample';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('offramp.' + key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('offramp.' + key, JSON.stringify(value));
    } catch {
      /* storage can be unavailable in private windows; the app still works */
    }
  },
};

// ---------- chips ----------
const chipLists = { favorites: [], traps: [] };
function renderChips(name) {
  const box = $(`[data-chips="${name}"]`);
  box.querySelectorAll('.chip').forEach((c) => c.remove());
  const input = box.querySelector('input');
  chipLists[name].forEach((text, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${esc(text)}<button type="button" aria-label="Remove ${esc(text)}">×</button>`;
    chip.querySelector('button').onclick = () => {
      chipLists[name].splice(i, 1);
      renderChips(name);
    };
    box.insertBefore(chip, input);
  });
}
function initChips(name, max) {
  const box = $(`[data-chips="${name}"]`);
  const input = box.querySelector('input');
  const add = () => {
    input.value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((v) => {
        if (chipLists[name].length < max && !chipLists[name].includes(v)) chipLists[name].push(v);
      });
    input.value = '';
    renderChips(name);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !input.value && chipLists[name].length) {
      chipLists[name].pop();
      renderChips(name);
    }
  });
  input.addEventListener('blur', add);
  box.addEventListener('click', () => input.focus());
}

// ---------- status ----------
async function loadStatus() {
  try {
    const s = await fetch('/api/health').then((r) => r.json());
    qlooMode = s.qloo;
    const qlooLabel = { live: 'Qloo live', snapshot: 'Qloo recorded responses', sample: 'Offline sample data, not Qloo' }[s.qloo] || 'Qloo';
    $('#pills').innerHTML = [
      `<span class="pill ${s.nemotron}">Nemotron ${s.nemotron}</span>`,
      `<span class="pill ${s.qloo}">${qlooLabel}</span>`,
      s.tavily === 'live' ? '<span class="pill live">Tavily live</span>' : '',
    ].join('');
  } catch {
    $('#pills').innerHTML = '<span class="pill">status unavailable</span>';
  }
}

// ---------- tabs ----------
function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
      document.querySelectorAll('.view').forEach((v) => (v.hidden = v.id !== tab.getAttribute('aria-controls')));
    });
  });
}

// ---------- form ----------
function fillForm(input) {
  chipLists.favorites = [...input.favorites];
  chipLists.traps = [...input.traps];
  renderChips('favorites');
  renderChips('traps');
  $('#sleepBy').value = input.sleepBy;
  $('#windDown').value = String(input.windDownMinutes);
  $('#notes').value = input.notes || '';
  $('#screenOk').checked = !/no screens/i.test(input.notes || '');
}
function readForm() {
  return {
    favorites: chipLists.favorites,
    traps: chipLists.traps,
    sleepBy: $('#sleepBy').value || '00:30',
    windDownMinutes: Number($('#windDown').value),
    notes: $('#notes').value,
    screenOk: $('#screenOk').checked,
  };
}

// ---------- agent run ----------
let running = false;
let lastState = null;
async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function run(input) {
  if (running) return;
  running = true;
  const btn = $('#run');
  btn.disabled = true;
  $('#result').hidden = true;
  $('#trace').innerHTML = '';
  $('#usage').innerHTML = '';
  setHint('<span class="spinner"></span> Reading your night');
  try {
    let state = await post('/api/agent', { action: 'start', input });
    renderTrace(state);
    let guard = 0;
    while (!state.done && guard++ < 16) {
      setHint(`<span class="spinner"></span> ${state.pendingEpisode !== undefined ? 'Finding one calm episode' : state.scripted ? 'Running the fixed tool sequence' : `Planner step ${state.steps + 1}`}`);
      try {
        state = await post('/api/agent', { action: 'step', state });
      } catch (err) {
        setHint('<span class="spinner"></span> Retrying one step');
        state = await post('/api/agent', { action: 'step', state });
      }
      renderTrace(state);
    }
    renderUsage(state);
    lastState = state;
    renderResult(state, input);
    setHint(state.plan ? 'Done. Scroll down for tonight.' : '');
    if (state.plan) store.set('lastPlan', { at: new Date().toISOString(), sleepBy: state.plan.sleepBy, plan: state.plan.steps.map((s) => s.item && s.item.name) });
  } catch (err) {
    setHint('');
    $('#result').hidden = false;
    $('#result').innerHTML = `<div class="note">Something went wrong: ${esc(err.message)}. Try again in a moment.</div>`;
  } finally {
    running = false;
    btn.disabled = false;
  }
}
function setHint(html) {
  $('#runHint').innerHTML = html;
}

function detailHtml(d) {
  if (d == null) return '';
  if (typeof d === 'string') return esc(d);
  if (Array.isArray(d)) return `<ul>${d.map((x) => `<li>${esc(typeof x === 'string' ? x : JSON.stringify(x))}</li>`).join('')}</ul>`;
  return `<ul>${Object.entries(d)
    .map(([k, v]) => `<li><b>${esc(k)}</b> ${esc(Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v)}</li>`)
    .join('')}</ul>`;
}

function renderTrace(state) {
  const list = $('#trace');
  const have = list.querySelectorAll('li[data-n]').length;
  for (const t of state.trace.slice(have)) {
    const li = document.createElement('li');
    li.dataset.n = t.n;
    li.className = 'kind-' + t.kind;
    const meta = [t.source && (t.kind === 'qloo' ? SOURCE_LABEL[t.source] || t.source : t.source), t.model, t.ms != null ? `${t.ms} ms` : '', t.tokens ? `${t.tokens} tok` : '', t.count != null ? `${t.count} results` : '']
      .filter(Boolean)
      .join(' · ');
    li.innerHTML = `<div class="t-head"><span class="t-title">${esc(t.title)}</span><span class="t-meta">${esc(meta)}</span></div>${
      t.detail ? `<div class="t-detail">${detailHtml(t.detail)}</div>` : ''
    }${t.note ? `<div class="t-detail">${esc(t.note)}</div>` : ''}`;
    list.appendChild(li);
  }
  list.scrollTop = list.scrollHeight;
}

function renderUsage(state) {
  const tiers = { fast: 'Fast tier', planner: 'Planner tier', deep: 'Deep tier' };
  const q = state.sources.qloo || {};
  const qTotal = Object.values(q).reduce((a, b) => a + b, 0);
  const m = state.plan && state.plan.meta;
  $('#usage').innerHTML =
    Object.entries(state.usage || {})
      .map(([tier, u]) => `<div><b>${esc(u.model)}</b>${esc(tiers[tier] || tier)}, ${u.calls} calls, ${u.tokens} tokens, ${(u.ms / 1000).toFixed(1)} s</div>`)
      .join('') +
    `<div><b>${qTotal} Qloo calls</b>${esc(Object.entries(q).map(([k, v]) => `${v} ${SOURCE_LABEL[k] || k}`).join(', '))}</div>` +
    (state.sources.tavily ? `<div><b>${state.sources.tavily} Tavily search</b>one calm episode for the first step</div>` : '') +
    (m ? `<div><b>${m.drafts || 0} plan draft${m.drafts === 1 ? '' : 's'}</b>${m.rejectedDrafts || 0} rejected by the validator${m.inventedCaught ? `, ${m.inventedCaught} made-up titles caught` : ''}${m.fallback ? ', finished by the safety net' : ''}</div>` : '');
}

function rampSvg(plan) {
  const W = 1000;
  const H = 150;
  const pad = 24;
  const total = plan.windDownMinutes + 20; // 20 minutes of "the feed" before the plan starts
  const x = (m) => pad + ((total - m) / total) * (W - pad * 2);
  const y = (a) => pad / 2 + ((10 - a) / 10) * (H - pad * 1.5);
  const pts = plan.steps.map((s) => [x(s.minutesBeforeSleep), y(s.item.arousal)]);
  pts.unshift([x(total), y(Math.max(7, ...plan.skipTonight.map((s) => s.item.arousal)))]);
  pts.push([x(0), y(0)]);
  const path = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const feedY = y(Math.max(7, ...plan.skipTonight.map((s) => s.item.arousal)));
  const dots = plan.steps
    .map((s, i) => `<circle cx="${pts[i + 1][0].toFixed(1)}" cy="${pts[i + 1][1].toFixed(1)}" r="5" fill="#f2c38b"><title>${esc(s.item.name)}, arousal ${s.item.arousal}</title></circle>`)
    .join('');
  return `<svg class="ramp" viewBox="0 0 ${W} ${H}" role="img" aria-label="Arousal falls from the feed to sleep across the plan">
    <line x1="${pad}" x2="${W - pad}" y1="${feedY}" y2="${feedY}" stroke="#f4a7a0" stroke-dasharray="5 6" stroke-width="1.5"/>
    <text x="${W - pad}" y="${feedY - 6}" text-anchor="end" font-size="11" fill="#f4a7a0" font-family="system-ui">the feed stays here</text>
    <path d="${path}" fill="none" stroke="#9fb7ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}
    <text x="${x(0)}" y="${H - 4}" text-anchor="end" font-size="11" fill="#a3abc4" font-family="system-ui">asleep ${esc(plan.sleepBy)}</text>
    <text x="${pad}" y="${H - 4}" font-size="11" fill="#a3abc4" font-family="system-ui">arousal, high to low</text>
  </svg>`;
}

function itemBadges(item) {
  const b = [];
  const sample = item.source === 'sample';
  if (item.affinity != null) b.push(`<span class="badge" title="${sample ? 'Made-up score from the offline sample catalog' : 'Qloo affinity for this person'}">${sample ? 'affinity (sample)' : 'Qloo affinity'} ${Number(item.affinity).toFixed(2)}</span>`);
  b.push(`<span class="badge arousal" title="${esc(item.arousalReason || 'pre-sleep arousal')}">Arousal ${item.arousal}/10${item.arousalBy === 'model' ? '' : ' (heuristic)'} <span class="meter"><i style="width:${item.arousal * 10}%"></i></span></span>`);
  if (item.because && item.because.length) b.push(`<span class="badge">${sample ? 'Sample link to' : 'Because you like'} ${esc(item.because.slice(0, 2).join(' and '))}</span>`);
  b.push(`<span class="badge">${esc(SOURCE_LABEL[item.source] || item.source)}</span>`);
  return `<div class="badges">${b.join('')}</div>`;
}

// The first thing a judge should see. What the person typed (films and TV,
// mostly) on the left, the formats Qloo found from that taste on the right.
function translationHtml(plan, state) {
  const typed = Object.entries(state.scratch.resolved || {})
    .filter(([, r]) => r && r.role === 'favorite' && r.id)
    .map(([q, r]) => `${r.name || q} <small>${esc(typeName(r.type))}</small>`);
  const found = [...plan.steps.map((s) => s.item), plan.ifAwake && plan.ifAwake.item]
    .filter(Boolean)
    .map((i) => `${esc(i.name)} <small>${esc(typeName(i.type))}${i.because && i.because.length ? `, ${i.source === 'sample' ? 'sample link to' : 'because you like'} ${esc(i.because[0])}` : ''}</small>`);
  if (!typed.length || !found.length) return '';
  const sample = plan.steps.some((s) => s.item && s.item.source === 'sample');
  return `<div class="translate panel"><div><h3>You said you love</h3><ul>${typed.map((t) => `<li>${t}</li>`).join('')}</ul></div>
    <div class="arrow" aria-hidden="true">→</div>
    <div><h3>${sample ? 'Offline sample picks for tonight' : 'Qloo found for tonight'}</h3><ul>${found.map((t) => `<li>${t}</li>`).join('')}</ul></div>
    <p class="hint">${sample ? 'Offline sample catalog with made-up scores. With a Qloo key these come from the Qloo taste graph.' : 'Same taste, carried into formats that end in audio. Qloo matches across domains, from film and TV to podcasts, artists and books.'}</p></div>`;
}

function episodeHtml(ep) {
  if (!ep) return '';
  return `<p class="episode">Tonight, one episode: <b>${esc(ep.title)}</b>${ep.seasonEpisode ? ` (${esc(ep.seasonEpisode)})` : ''}. ${esc(ep.why || '')}${ep.url ? ` <a href="${esc(ep.url)}" target="_blank" rel="noopener noreferrer">source</a>` : ''} <span class="badge">found with Tavily</span></p>`;
}

function renderResult(state, input) {
  const box = $('#result');
  box.hidden = false;
  if (state.crisis) {
    box.innerHTML = `<div class="crisis" role="alert">${esc(state.crisis)}</div>`;
    return;
  }
  if (!state.plan) {
    box.innerHTML = `<div class="note">${esc(state.error || 'No plan this time.')}</div>`;
    return;
  }
  const p = state.plan;
  const steps = p.steps
    .map(
      (s) => `<li class="step"><div class="time">${esc(s.at)}</div><div class="card">
        <div class="lane">${esc(LANE_LABEL[s.item.lane] || s.item.lane)}</div>
        <div class="title">${esc(s.item.name)}</div>
        ${episodeHtml(s.episode)}
        <p class="instr">${esc(s.instruction)}</p>
        <p class="why">${esc(s.why)}</p>
        ${itemBadges(s.item)}
      </div></li>`
    )
    .join('');
  const awake = p.ifAwake
    ? `<li class="step"><div class="time later">+20 min</div><div class="card"><div class="lane">${esc(LANE_LABEL.page)}</div><div class="title">${esc(p.ifAwake.item.name)}</div><p class="instr">${esc(p.ifAwake.instruction)}</p><p class="why">${esc(p.ifAwake.why)}</p>${itemBadges(p.ifAwake.item)}</div></li>`
    : '';
  const skip = p.skipTonight.length
    ? `<div class="panel skip"><h2>Skip tonight, save for daytime</h2><p class="hint">${
        p.skipTonight.some((s) => s.item.source === 'sample')
          ? 'Offline sample picks that would likely pull you in. With a Qloo key, this list is what Qloo predicts you would love most.'
          : 'Qloo predicts you would love these. That is exactly why they are not for the last hour.'
      }</p><ul>${p.skipTonight
        .map((s) => `<li><b>${esc(s.item.name)}</b>, arousal ${s.item.arousal}/10${s.item.affinity != null ? `, ${s.item.source === 'sample' ? 'affinity (sample)' : 'Qloo affinity'} ${Number(s.item.affinity).toFixed(2)}` : ''}. ${esc(s.why)}</li>`)
        .join('')}</ul></div>`
    : '';
  const notes = (p.notes || []).map((n) => `<div class="note">${esc(n)}</div>`).join('');
  const fallback = p.meta && p.meta.fallback ? `<div class="note">The planner model did not finish, so the deterministic planner assembled this from the same taste data (${esc(p.meta.reason || '')}).</div>` : '';
  box.innerHTML = `
    <div class="result-head"><div><h2>${esc(p.headline)}</h2><p>Asleep by ${esc(p.sleepBy)}. ${esc(p.note)}</p></div>
      <div class="actions"><button class="btn" id="compareBtn" type="button">Compare with a plan made without Qloo</button><button class="btn" id="probeBtn" type="button">Try to break the checks</button></div></div>
    ${translationHtml(p, state)}
    ${rampSvg(p)}
    ${fallback}${notes}
    <ol class="timeline">${steps}${awake}</ol>
    <div class="side">${skip}<div class="panel" id="compareBox" hidden></div><div class="panel" id="probeBox" hidden></div></div>`;
  $('#compareBtn').onclick = () => compare(input, p);
  $('#probeBtn').onclick = probe;
  if (!new URLSearchParams(location.search).has('shot')) box.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

async function compare(input, plan) {
  const box = $('#compareBox');
  box.hidden = false;
  box.innerHTML = '<span class="spinner"></span> Asking the same Nemotron model, without Qloo';
  const planItems = [...plan.steps.map((s) => s.item), plan.ifAwake && plan.ifAwake.item].filter(Boolean).map((i) => ({ name: i.name, lane: typeName(i.type), id: i.id, arousal: i.arousal, because: i.because }));
  try {
    const r = await post('/api/baseline', { input, planItems });
    const facts = (r.facts || [])
      .map((f) => `<tr><th scope="row">${esc(f.label)}</th><td>${esc(f.without)}</td><td>${esc(f.with)}</td></tr>`)
      .join('');
    box.innerHTML = `<h2>Same model, no taste graph</h2>
      ${facts ? `<table class="facts"><thead><tr><th></th><th>Without Qloo</th><th>With Offramp</th></tr></thead><tbody>${facts}</tbody></table><p class="hint">Counted from the two outputs on this page, not assumed.</p>` : ''}
      <div class="compare">
      <div><h3>Without Qloo, as the model wrote it</h3><pre>${esc(r.text)}</pre></div>
      <div><h3>With Offramp</h3><pre>${esc(plan.steps.map((s) => `${s.at} ${s.item.name}${s.episode ? `, ${s.episode.title}` : ''}`).join('\n'))}${plan.ifAwake ? `\nif awake ${plan.ifAwake.item.name}` : ''}</pre></div></div>
      <p class="hint">${esc(r.receipt ? `${r.receipt.model}, ${r.receipt.ms} ms` : '')}</p>`;
  } catch (err) {
    box.innerHTML = `<div class="note">Comparison failed: ${esc(err.message)}</div>`;
  }
}

// Hands the validator tonight's plan and two drafts broken on purpose.
async function probe() {
  const box = $('#probeBox');
  box.hidden = false;
  box.innerHTML = '<span class="spinner"></span> Sending broken drafts to the validator';
  try {
    const r = await post('/api/agent', { action: 'probe', state: lastState });
    if (r.error) throw new Error(r.error);
    box.innerHTML = `<h2>Try to break the checks</h2><p class="hint">The validator runs in code, not in the prompt. Every step needs an entity id from a Qloo call in this run, and the step text is scanned for titles Qloo did not return.</p><ul class="probe">${r.cases
      .map(
        (c) => `<li class="${c.accepted ? 'pass' : 'fail'}"><b>${c.accepted ? 'Accepted' : 'Rejected'}</b> ${esc(c.label)}${
          c.errors.length ? `<ul>${c.errors.slice(0, 3).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''
        }</li>`
      )
      .join('')}</ul>`;
    box.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
  } catch (err) {
    box.innerHTML = `<div class="note">The check could not run: ${esc(err.message)}</div>`;
  }
}

// ---------- mornings ----------
function renderLogs() {
  const logs = store.get('logs', []);
  const list = $('#logs');
  list.innerHTML = logs.length
    ? logs
        .slice()
        .reverse()
        .map((l) => `<li><span><b>${esc(l.date)}</b> target ${esc(l.target)}, ${l.minutesLate ? `${l.minutesLate} min late` : 'on time'}</span><span class="hint">${esc((l.followed || []).join(', ') || 'no steps')}${l.pulledBy ? `, pulled by ${esc(l.pulledBy)}` : ''}</span></li>`)
        .join('')
    : '<li class="empty">No mornings logged yet.</li>';
}

function initMornings() {
  const today = new Date();
  today.setDate(today.getDate() - 1);
  $('#logDate').value = today.toISOString().slice(0, 10);
  const last = store.get('lastPlan', null);
  if (last && last.sleepBy) $('#logTarget').value = last.sleepBy;
  $('#logForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const logs = store.get('logs', []);
    logs.push({
      date: $('#logDate').value,
      target: $('#logTarget').value,
      minutesLate: Number($('#logLate').value),
      followed: [...document.querySelectorAll('input[name="followed"]:checked')].map((x) => x.value),
      pulledBy: $('#logPulled').value,
      feltRested: Number($('#logRested').value),
      plan: (store.get('lastPlan', {}) || {}).plan || [],
    });
    store.set('logs', logs.slice(-14));
    renderLogs();
    e.target.reset();
    initMornings.setDefaults();
  });
  initMornings.setDefaults = () => {
    $('#logDate').value = today.toISOString().slice(0, 10);
  };
  $('#sampleWeek').onclick = () => {
    const base = new Date();
    const mk = (d, late, followed, pulled, rested) => {
      const dt = new Date(base);
      dt.setDate(base.getDate() - d);
      return { date: dt.toISOString().slice(0, 10), target: '00:30', minutesLate: late, followed, pulledBy: pulled, feltRested: rested, plan: ['Midnight Diner', 'Sleep With Me', 'Brian Eno'] };
    };
    store.set('logs', [
      mk(7, 90, ['screen'], 'one more episode, then YouTube', 2),
      mk(6, 60, ['screen', 'audio'], 'autoplay started the next episode', 2),
      mk(5, 10, ['audio', 'music'], '', 4),
      mk(4, 75, ['screen'], 'checked TikTok after the episode', 2),
      mk(3, 5, ['audio', 'music'], '', 4),
      mk(2, 30, ['screen', 'audio', 'music'], 'phone was on the bed', 3),
      mk(1, 0, ['audio', 'music', 'ifawake'], 'woke at 3, got up and read', 4),
    ]);
    renderLogs();
  };
  $('#clearLogs').onclick = () => {
    store.set('logs', []);
    renderLogs();
    $('#reflection').innerHTML = '';
  };
  $('#reflectBtn').onclick = reflectWeek;
  renderLogs();
}

async function reflectWeek() {
  const box = $('#reflection');
  const btn = $('#reflectBtn');
  btn.disabled = true;
  box.innerHTML = '<p><span class="spinner"></span> Nemotron 3 Ultra is reading your week</p>';
  try {
    const r = await post('/api/reflect', { logs: store.get('logs', []) });
    if (!r.reflection) {
      box.innerHTML = `<div class="note">${esc(r.error || 'No reflection this time.')}</div>`;
      return;
    }
    const f = r.reflection;
    box.innerHTML = `<h3>This week</h3><p>${esc(f.summary)}</p>
      ${f.whatWorked.length ? `<h3>What worked</h3><ul>${f.whatWorked.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${f.changes.length ? `<h3>Try next</h3><ul>${f.changes.map((c) => `<li><b>${esc(c.change)}</b> ${esc(c.why)}</li>`).join('')}</ul>` : ''}
      ${f.safety ? `<div class="crisis">${esc(f.safety)}</div>` : ''}
      <div class="actions" style="margin-top:10px"><button class="btn primary" id="applyBtn" type="button">Apply to tonight</button><span class="hint">${esc(r.receipt ? r.receipt.model : '')}</span></div>`;
    $('#applyBtn').onclick = () => {
      const wd = $('#windDown');
      const target = Number(wd.value) + f.tomorrow.startEarlierMinutes;
      const options = [...wd.options].map((o) => Number(o.value));
      wd.value = String(options.find((o) => o >= target) || options[options.length - 1]);
      if (f.tomorrow.skipScreen) $('#screenOk').checked = false;
      const note = f.changes[0] ? `Reflection says: ${f.changes[0].change}` : '';
      if (note && !$('#notes').value.includes(note)) $('#notes').value = ($('#notes').value + ' ' + note).trim().slice(0, 500);
      $('#tab-tonight').click();
      $('#form').scrollIntoView({ block: 'start' });
    };
  } catch (err) {
    box.innerHTML = `<div class="note">Reflection failed: ${esc(err.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- boot ----------
function init() {
  initTabs();
  initChips('favorites', 6);
  initChips('traps', 4);
  $('#personas').innerHTML = PERSONAS.map(
    (p) => `<button class="persona" type="button" data-id="${p.id}"><b>${esc(p.label)}</b><span>${esc(p.who)}</span><small>Loves ${esc(p.input.favorites.slice(0, 3).join(', '))}</small></button>`
  ).join('');
  document.querySelectorAll('.persona').forEach((b) =>
    b.addEventListener('click', () => {
      const p = PERSONAS.find((x) => x.id === b.dataset.id);
      fillForm(p.input);
      $('#tab-tonight').click();
      run(readForm());
    })
  );
  $('#form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = readForm();
    if (!input.favorites.length) {
      setHint('Add at least one thing you love.');
      return;
    }
    run(input);
  });
  const draft = store.get('draft', null);
  fillForm(draft || PERSONAS[0].input);
  $('#form').addEventListener('change', () => store.set('draft', readForm()));
  initMornings();
  loadStatus();
  // ?run=<persona id> starts an example night on load (handy for demos and judges)
  const auto = new URLSearchParams(location.search).get('run');
  const persona = PERSONAS.find((p) => p.id === auto);
  if (persona) {
    fillForm(persona.input);
    run(readForm());
  }
}
init();
