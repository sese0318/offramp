// Measures the agent, so the numbers in the README, the Devpost page and the
// video are real. Runs the three example nights several times and reports
// aggregates only (no titles, so no Qloo response data is written anywhere).
//
//   npm run bench                      3 nights x 10 runs (2 runs with no keys)
//   npm run bench -- --runs 5
//   npm run bench -- --agreement       also compares Lightning and Ultra arousal
//                                      ratings on up to 40 candidates
//
// Cost needs prices in USD per 1M tokens, from your Token Factory pricing page:
//   NEBIUS_PRICE_IN_FAST, NEBIUS_PRICE_OUT_FAST, and the same for PLANNER, DEEP
// Without them the cost line says so instead of guessing.
//
// The summary is printed and also saved to bench/results.local.json, which is
// gitignored. With the mock model the output is labeled MOCK and is only a
// check that the script works. Do not publish mock numbers.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, root } from './env.js';
loadEnv();

const { getConfig, publicStatus } = await import('../lib/config.js');
const { runToCompletion } = await import('../lib/agent.js');
const { createLLM } = await import('../lib/llm.js');
const { arousalPrompt, compactForRating } = await import('../lib/arousal.js');

const args = process.argv.slice(2);
const cfg = getConfig();
const live = cfg.nebius.enabled;
const runsArg = args.indexOf('--runs');
const runs = runsArg >= 0 ? Math.max(1, Number(args[runsArg + 1]) || 1) : live ? 10 : 2;
const personas = JSON.parse(readFileSync(join(root, 'data', 'personas.json'), 'utf8'));

const median = (xs) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');
const price = (tier, dir) => {
  const v = process.env[`NEBIUS_PRICE_${dir}_${tier.toUpperCase()}`];
  return v === undefined || v === '' ? null : Number(v);
};

const status = publicStatus(cfg);
console.log(live ? 'Status' : 'MOCK RUN, do not publish these numbers. Status', JSON.stringify(status));

const totals = { runs: 0, plans: 0, fallback: 0, firstDraft: 0, drafts: 0, rejected: 0, invented: 0, plannerTurns: 0, nativeTurns: 0, textTurns: 0, deferred: 0, ratedByModel: 0, rated: 0, lengthStops: 0, runMs: [] };
const tiers = {};
const candidatePool = new Map();

for (let r = 0; r < runs; r++) {
  for (const p of personas) {
    const t0 = Date.now();
    let state;
    try {
      state = await runToCompletion(p.input, cfg);
    } catch (err) {
      console.log(`run failed for ${p.id}: ${err.message}`);
      totals.runs += 1;
      continue;
    }
    totals.runs += 1;
    totals.runMs.push(Date.now() - t0);
    const m = state.metrics || {};
    totals.plannerTurns += m.plannerTurns || 0;
    totals.nativeTurns += m.nativeToolTurns || 0;
    totals.textTurns += m.textToolTurns || 0;
    totals.deferred += m.deferredCalls || 0;
    for (const rating of Object.values(state.scratch.ratings || {})) {
      totals.rated += 1;
      if (rating.by === 'model') totals.ratedByModel += 1;
    }
    for (const [tier, u] of Object.entries(state.usage || {})) {
      const t = (tiers[tier] = tiers[tier] || { model: u.model, calls: 0, latencies: [], prompt: 0, completion: 0, total: 0, reasoning: 0 });
      t.calls += u.calls;
      t.latencies.push(...(u.latencies || []));
      t.prompt += u.promptTokens || 0;
      t.completion += u.completionTokens || 0;
      t.total += u.tokens || 0;
      t.reasoning += u.reasoningTokens || 0;
      totals.lengthStops += u.lengthStops || 0;
    }
    if (state.plan) {
      totals.plans += 1;
      const meta = state.plan.meta || {};
      if (meta.fallback) totals.fallback += 1;
      if (meta.firstDraftAccepted) totals.firstDraft += 1;
      totals.drafts += meta.drafts || 0;
      totals.rejected += meta.rejectedDrafts || 0;
      totals.invented += meta.inventedCaught || 0;
    }
    for (const id of Object.values(state.scratch.candidates || {}).flat()) {
      const e = state.scratch.entities[id];
      if (e && candidatePool.size < 40) candidatePool.set(id, e);
    }
    process.stdout.write('.');
  }
}
console.log('');

const runCount = totals.runs || 1;
const tierRows = Object.entries(tiers).map(([tier, t]) => {
  const pin = price(tier, 'IN');
  const pout = price(tier, 'OUT');
  const cost = pin !== null && pout !== null ? ((t.prompt * pin + t.completion * pout) / 1e6) / runCount : null;
  return {
    tier,
    model: t.model,
    callsPerRun: +(t.calls / runCount).toFixed(1),
    medianMs: median(t.latencies),
    tokensPerRun: Math.round(t.total / runCount),
    reasoningTokensPerRun: Math.round(t.reasoning / runCount),
    costPerRunUsd: cost === null ? null : +cost.toFixed(5),
  };
});
const knownCosts = tierRows.filter((r) => r.costPerRunUsd !== null);

const summary = {
  measuredAt: new Date().toISOString(),
  mode: { nemotron: status.nemotron, qloo: status.qloo, tavily: status.tavily },
  runs: totals.runs,
  plans: totals.plans,
  firstDraftAccepted: pct(totals.firstDraft, totals.plans),
  draftsRejectedByValidator: totals.rejected,
  inventedTitlesCaught: totals.invented,
  finishedBySafetyNet: pct(totals.fallback, totals.plans),
  plannerTurnsWithNativeToolCalls: pct(totals.nativeTurns, totals.plannerTurns),
  plannerTurnsOnJsonProtocol: pct(totals.textTurns, totals.plannerTurns),
  callsDeferredForTime: totals.deferred,
  ratingsByModel: pct(totals.ratedByModel, totals.rated),
  maxTokensStops: totals.lengthStops,
  medianSecondsPerPlan: totals.runMs.length ? +(median(totals.runMs) / 1000).toFixed(1) : null,
  tiers: tierRows,
  costPerPlanUsd: knownCosts.length === tierRows.length && tierRows.length ? +knownCosts.reduce((a, r) => a + r.costPerRunUsd, 0).toFixed(5) : 'set NEBIUS_PRICE_IN_* and NEBIUS_PRICE_OUT_* to compute',
};

if (args.includes('--agreement')) {
  // Do the fast and the deep model agree on arousal? If they mostly do, the
  // fast tier is the right place for rating. Only aggregates are kept.
  const items = [...candidatePool.values()].map(compactForRating);
  const rate = async (tier) => {
    const llm = createLLM(cfg);
    const out = new Map();
    for (let i = 0; i < items.length; i += 20) {
      const batch = items.slice(i, i + 20);
      const { data } = await llm.json(tier, { messages: arousalPrompt(batch), purpose: 'rate_arousal', maxTokens: 1500, temperature: 0.1, context: { items: batch } });
      for (const r of (data && data.ratings) || []) if (Number.isFinite(Number(r.arousal))) out.set(r.id, Number(r.arousal));
    }
    return { out, ms: llm.receipts.reduce((a, r) => a + r.ms, 0) };
  };
  const fast = await rate('fast');
  const deep = await rate('deep');
  const both = items.map((it) => it.id).filter((id) => fast.out.has(id) && deep.out.has(id));
  const diffs = both.map((id) => Math.abs(fast.out.get(id) - deep.out.get(id)));
  const rank = (ids, map) => {
    const sorted = [...ids].sort((a, b) => map.get(a) - map.get(b));
    const r = new Map();
    sorted.forEach((id, i) => r.set(id, i));
    return r;
  };
  const ra = rank(both, fast.out);
  const rb = rank(both, deep.out);
  const n = both.length;
  const d2 = both.reduce((a, id) => a + (ra.get(id) - rb.get(id)) ** 2, 0);
  summary.agreement = {
    candidates: n,
    meanAbsDifference: n ? +(diffs.reduce((a, b) => a + b, 0) / n).toFixed(2) : null,
    withinOnePoint: pct(diffs.filter((d) => d <= 1).length, n),
    spearman: n > 2 ? +(1 - (6 * d2) / (n * (n * n - 1))).toFixed(2) : null,
    fastSeconds: +(fast.ms / 1000).toFixed(1),
    deepSeconds: +(deep.ms / 1000).toFixed(1),
  };
}

mkdirSync(join(root, 'bench'), { recursive: true });
writeFileSync(join(root, 'bench', 'results.local.json'), JSON.stringify(summary, null, 2));

console.log(`\n${live ? '' : 'MOCK, NOT FOR PUBLISHING. '}Offramp benchmark, ${summary.runs} runs (${personas.length} example nights x ${runs}), ${summary.measuredAt}`);
console.log(`Nemotron ${summary.mode.nemotron}, Qloo ${summary.mode.qloo}, Tavily ${summary.mode.tavily}\n`);
console.log('| Measure | Value |');
console.log('| --- | --- |');
for (const [label, key] of [
  ['Plans produced', 'plans'],
  ['First draft accepted by the validator', 'firstDraftAccepted'],
  ['Drafts the validator sent back', 'draftsRejectedByValidator'],
  ['Made-up titles or ids caught', 'inventedTitlesCaught'],
  ['Plans finished by the safety net', 'finishedBySafetyNet'],
  ['Planner turns with native tool calls', 'plannerTurnsWithNativeToolCalls'],
  ['Planner turns on the JSON tool protocol', 'plannerTurnsOnJsonProtocol'],
  ['Arousal ratings made by the model', 'ratingsByModel'],
  ['Calls cut off at max_tokens', 'maxTokensStops'],
  ['Tool calls deferred to stay in the time limit', 'callsDeferredForTime'],
  ['Median seconds per plan', 'medianSecondsPerPlan'],
  ['Cost per plan, USD', 'costPerPlanUsd'],
]) {
  console.log(`| ${label} | ${summary[key]} |`);
}
console.log('\n| Tier | Model | Calls per plan | Median ms per call | Tokens per plan | Reasoning tokens per plan |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const t of summary.tiers) console.log(`| ${t.tier} | ${t.model} | ${t.callsPerRun} | ${t.medianMs} | ${t.tokensPerRun} | ${t.reasoningTokensPerRun} |`);
if (summary.agreement) {
  const a = summary.agreement;
  console.log(`\nArousal agreement on ${a.candidates} candidates, fast vs deep. Mean difference ${a.meanAbsDifference} points, within 1 point ${a.withinOnePoint}, Spearman ${a.spearman}. Fast took ${a.fastSeconds} s, deep took ${a.deepSeconds} s.`);
}
console.log('\nSaved to bench/results.local.json (gitignored).');
