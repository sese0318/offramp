// The two side calls: the no-taste baseline and the weekly reflection.

import { getConfig } from './config.js';
import { createLLM } from './llm.js';
import { baselineMessages, REFLECT_SYSTEM } from './prompts.js';
import { sanitizeInput, screen, CRISIS_MESSAGE } from './safety.js';
import { namesInText } from './plan.js';

// Same planner model, same person, no Qloo and no tools. Shown next to the
// Offramp plan so the difference the taste graph makes is visible. The
// comparison is measured from both outputs, never assumed: the baseline may
// well name real titles, so the page counts what each side actually did.
export async function baseline(rawInput, cfg = getConfig(), planItems = null) {
  const input = sanitizeInput(rawInput);
  if (screen(input).crisis) return { text: CRISIS_MESSAGE, receipt: null };
  const llm = createLLM(cfg, { deadline: Date.now() + cfg.agent.stepBudgetMs });
  const res = await llm.chat('planner', { messages: baselineMessages(input), purpose: 'baseline (no Qloo)', maxTokens: 700, temperature: 0.3 });
  const text = res.message.content;
  return { text, receipt: res.receipt, facts: planItems ? compareFacts(text, planItems, input) : null };
}

const listOrNone = (list) => (list.length ? list.join(', ') : 'none');
const has = (text, name) => String(text).toLowerCase().includes(String(name).toLowerCase());

export function compareFacts(text, planItems, input) {
  const items = (Array.isArray(planItems) ? planItems : []).slice(0, 8).map((i) => ({
    name: String((i && i.name) || '').slice(0, 120),
    lane: String((i && i.lane) || ''),
    hasId: Boolean(i && i.id),
    arousal: Number.isFinite(Number(i && i.arousal)) ? Number(i.arousal) : null,
    because: Array.isArray(i && i.because) ? i.because.map(String).slice(0, 3) : [],
  }));
  const favorites = input.favorites || [];
  const traps = input.traps || [];
  const named = namesInText(text).filter((n) => !/^(Step|Steps|Night|Tonight|Dim|Turn|Read|Listen|Put|Try)\b/.test(n)).slice(0, 8);
  const trapHits = traps.filter((t) => has(text, t));
  const favHits = favorites.filter((f) => has(text, f));
  const newToYou = items.filter((i) => i.name && !favorites.some((f) => has(i.name, f) || has(f, i.name)));
  const lanes = [...new Set(items.map((i) => i.lane).filter(Boolean))];
  return [
    { label: 'Titles named', without: named.length ? named.join(', ') : 'none', with: items.map((i) => i.name).join(', ') },
    { label: 'Tied to a Qloo entity id', without: '0', with: `${items.filter((i) => i.hasId).length} of ${items.length}` },
    { label: 'New to you, found from your taste', without: `${named.filter((n) => !favorites.some((f) => has(n, f) || has(f, n))).length}`, with: `${newToYou.length}${newToYou.some((i) => i.because.length) ? `, each linked to one of your favorites` : ''}` },
    { label: 'Repeats what you typed', without: favHits.length ? favHits.join(', ') : 'none', with: listOrNone(items.filter((i) => favorites.some((f) => has(i.name, f))).map((i) => i.name)) },
    { label: 'Recommends what keeps you up', without: trapHits.length ? `mentions ${trapHits.join(', ')}` : 'no', with: listOrNone(items.filter((i) => traps.some((t) => has(i.name, t))).map((i) => i.name)) },
    { label: 'Each step rated for pre-sleep arousal', without: 'no', with: items.length ? `yes, highest ${Math.max(...items.map((i) => i.arousal ?? 0))} of 10` : 'yes' },
    { label: 'Formats tonight', without: 'not checked', with: lanes.join(', ') },
  ];
}

function cleanLogs(logs) {
  return (Array.isArray(logs) ? logs : []).slice(-14).map((n) => ({
    date: String(n.date || '').slice(0, 10),
    target: String(n.target || '').slice(0, 5),
    minutesLate: Math.max(-180, Math.min(600, Number(n.minutesLate) || 0)),
    followed: (Array.isArray(n.followed) ? n.followed : []).map((x) => String(x).slice(0, 12)).slice(0, 5),
    pulledBy: String(n.pulledBy || '').slice(0, 160),
    feltRested: Math.max(1, Math.min(5, Number(n.feltRested) || 3)),
    plan: (Array.isArray(n.plan) ? n.plan : []).map((x) => String(x).slice(0, 80)).slice(0, 5),
  }));
}

// Weekly reflection on the deep tier (Nemotron 3 Ultra). The log lives in the
// person's browser and is sent only when they ask for a reflection.
export async function reflect(rawLogs, cfg = getConfig()) {
  const logs = cleanLogs(rawLogs);
  if (logs.length < 2) return { reflection: null, error: 'Log at least two mornings first.' };
  const llm = createLLM(cfg, { deadline: Date.now() + cfg.agent.stepBudgetMs });
  const { data, receipt } = await llm.json('deep', {
    messages: [
      { role: 'system', content: REFLECT_SYSTEM },
      { role: 'user', content: JSON.stringify({ nights: logs }) },
    ],
    purpose: 'reflect',
    maxTokens: 1200,
    temperature: 0.3,
    context: { logs },
  });
  if (!data) return { reflection: null, error: 'The reflection model did not return JSON.', receipt };
  const t = data.tomorrow || {};
  if (screen({ notes: JSON.stringify(logs), favorites: [], traps: [] }).crisis) data.safety = CRISIS_MESSAGE;
  return {
    reflection: {
      summary: String(data.summary || '').slice(0, 500),
      whatWorked: (data.what_worked || []).map(String).slice(0, 3),
      changes: (data.changes || []).slice(0, 3).map((c) => ({ change: String(c.change || ''), why: String(c.why || '') })),
      tomorrow: {
        startEarlierMinutes: Math.max(0, Math.min(45, Number(t.start_earlier_minutes) || 0)),
        skipScreen: Boolean(t.skip_screen),
        note: String(t.note || '').slice(0, 200),
      },
      safety: data.safety || null,
    },
    receipt,
  };
}
