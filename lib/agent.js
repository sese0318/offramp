// The Offramp agent, written as a stateless step function.
// The browser calls /api/agent once to start a run and then once per step.
// Each step is one planner turn plus the tools it called, so no single
// serverless request runs long, and the UI can show the agent working live.
// The state travels with an HMAC signature so it cannot be edited client side.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getConfig } from './config.js';
import { createQloo } from './qloo.js';
import { createLLM, extractJson } from './llm.js';
import { toolSchemas, runTool } from './tools.js';
import { INTAKE_SYSTEM, plannerSystem, plannerUser, textProtocolAddendum } from './prompts.js';
import { searchEpisodes, groundEpisode, episodeMessages } from './tavily.js';
import { scriptedTurn } from './mockLlm.js';
import { autoPlan, enrichPlan, validatePlan } from './plan.js';
import { sanitizeInput, screen, CRISIS_MESSAGE, CLINICIAN_NOTE } from './safety.js';

const MAX_TOOL_CALLS_PER_STEP = 10;

function newScratch() {
  return { entities: {}, resolved: {}, tags: {}, candidates: {}, ratings: {}, flags: {} };
}

export function sign(state, secret) {
  const { sig, ...rest } = state;
  return createHmac('sha256', secret).update(JSON.stringify(rest)).digest('hex');
}

export function verify(state, secret) {
  if (!state || typeof state.sig !== 'string') return false;
  const expected = Buffer.from(sign(state, secret), 'hex');
  const given = Buffer.from(state.sig, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function addTrace(state, entry) {
  state.trace.push({ n: state.trace.length + 1, ...entry });
}

function collectReceipts(state, qloo, llm) {
  for (const r of qloo.receipts) {
    addTrace(state, {
      kind: 'qloo',
      title: `Qloo ${r.endpoint}`,
      detail: summarizeParams(r.params),
      source: r.source,
      ms: r.ms,
      count: r.count,
      note: r.note,
    });
    state.sources.qloo[r.source] = (state.sources.qloo[r.source] || 0) + 1;
  }
  for (const r of llm.receipts) {
    addTrace(state, { kind: 'model', title: `Nemotron ${r.tier}`, detail: r.purpose, model: r.model, source: r.source, ms: r.ms, tokens: r.tokens, note: r.note });
    const u = (state.usage[r.tier] = state.usage[r.tier] || { calls: 0, tokens: 0, ms: 0, model: r.model, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, lengthStops: 0, latencies: [] });
    u.calls += 1;
    u.tokens += r.tokens || 0;
    u.ms += r.ms;
    u.promptTokens += r.promptTokens || 0;
    u.completionTokens += r.completionTokens || 0;
    u.reasoningTokens += r.reasoningTokens || 0;
    if (r.finish === 'length') u.lengthStops += 1;
    u.latencies.push(r.ms);
    if (state.metrics && r.tier === 'planner' && /plan next action/.test(r.purpose)) {
      state.metrics.plannerTurns += 1;
      if (r.toolCalls) state.metrics.nativeToolTurns += 1;
    }
  }
  qloo.receipts.length = 0;
  llm.receipts.length = 0;
}

function summarizeParams(p) {
  const out = {};
  for (const [k, v] of Object.entries(p || {})) {
    if (v === undefined || v === '') continue;
    out[k] = String(v).length > 90 ? String(v).slice(0, 87) + '...' : v;
  }
  return out;
}

export async function startRun(rawInput, cfg = getConfig()) {
  const input = sanitizeInput(rawInput);
  const state = {
    v: 1,
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    input,
    intake: null,
    messages: [],
    scratch: newScratch(),
    trace: [],
    usage: {},
    sources: { qloo: {}, nemotron: cfg.nebius.enabled ? 'live' : 'mock' },
    toolMode: 'native',
    metrics: { plannerTurns: 0, nativeToolTurns: 0, textToolTurns: 0, deferredCalls: 0 },
    steps: 0,
    nudges: 0,
    done: false,
    plan: null,
    notes: [],
  };
  const flags = screen(input);
  if (flags.crisis) {
    state.done = true;
    state.crisis = CRISIS_MESSAGE;
    addTrace(state, { kind: 'safety', title: 'Paused for safety', detail: 'Crisis language detected, no plan generated.' });
    return state;
  }
  if (!input.favorites.length) {
    state.done = true;
    state.error = 'Add at least one thing you love so Offramp has a taste to work with.';
    return state;
  }
  if (flags.longTerm) state.notes.push(CLINICIAN_NOTE);

  const qloo = createQloo(cfg);
  const llm = createLLM(cfg, { deadline: Date.now() + cfg.agent.stepBudgetMs });
  let intake;
  try {
    const { data } = await llm.json('fast', {
      messages: [
        { role: 'system', content: INTAKE_SYSTEM },
        { role: 'user', content: JSON.stringify({ favorites: input.favorites, traps: input.traps, notes: input.notes }) },
      ],
      purpose: 'intake',
      maxTokens: 700,
      temperature: 0.1,
      context: { input },
    });
    intake = data;
  } catch (err) {
    state.notes.push('intake model call failed, used the typed fields as they are: ' + err.message);
  }
  state.intake = normalizeIntake(intake, input);
  addTrace(state, {
    kind: 'intake',
    title: 'Understood your night',
    detail: {
      favorites: state.intake.favorites.map((f) => `${f.name} (${f.kind})`),
      keeps_you_up: state.intake.traps.map((f) => `${f.name} (${f.kind})`),
      constraints: state.intake.constraints,
    },
  });
  const tools = toolSchemas();
  state.messages = [
    { role: 'system', content: plannerSystem({ tavily: cfg.tavily.enabled }) },
    { role: 'user', content: plannerUser(input, state.intake) },
  ];
  state.toolCount = tools.length;
  collectReceipts(state, qloo, llm);
  return state;
}

export function normalizeIntake(intake, input) {
  const kinds = ['artist', 'movie', 'tv_show', 'podcast', 'book', 'videogame', 'habit', 'unknown'];
  // A model reply can be the wrong shape (a bare array, plain strings, items
  // without names). Whatever survives must be non-empty, or the typed fields
  // are used as they are, so the planner always has the person's taste.
  if (!intake || typeof intake !== 'object' || Array.isArray(intake)) intake = null;
  const clean = (list) =>
    (Array.isArray(list) ? list : [])
      .map((x) => (typeof x === 'string' ? { name: x, kind: 'unknown' } : x))
      .filter((x) => x && typeof x === 'object' && x.name && String(x.name).trim())
      .slice(0, 6)
      .map((x) => ({ name: String(x.name).trim().slice(0, 80), kind: kinds.includes(x.kind) ? x.kind : 'unknown' }));
  const fix = (arr, fallback) => {
    const list = clean(arr);
    return list.length ? list : clean(fallback);
  };
  return {
    favorites: fix(intake && intake.favorites, input.favorites),
    traps: fix(intake && intake.traps, input.traps),
    constraints: (intake && Array.isArray(intake.constraints) ? intake.constraints : []).map((c) => String(c).slice(0, 120)).filter(Boolean).slice(0, 4),
    screen_ok: intake && intake.screen_ok === false ? false : input.prefs.screen_ok,
  };
}

function finish(state, plan, meta, cfg) {
  const f = state.scratch.flags || {};
  const metrics = {
    drafts: f.drafts || 0,
    rejectedDrafts: f.rejected || 0,
    inventedCaught: f.invented || 0,
    firstDraftAccepted: !meta.fallback && (f.drafts || 0) >= 1 && !(f.rejected || 0),
    toolMode: state.toolMode,
  };
  state.plan = enrichPlan(plan, state.scratch, state.input, { ...meta, ...metrics });
  state.plan.notes = state.notes;
  addTrace(state, { kind: 'plan', title: meta.fallback ? 'Plan assembled by the safety net' : 'Plan accepted', detail: `${state.plan.steps.length} steps, validated against Qloo results` });
  const target = episodeTarget(state.plan);
  if (cfg && cfg.tavily.enabled && target >= 0) {
    state.pendingEpisode = target;
    state.done = false;
  } else {
    state.done = true;
  }
}

// The first step that is a show or a podcast gets one named episode.
function episodeTarget(plan) {
  return plan.steps.findIndex((s) => s.item && (s.item.lane === 'screen' || s.item.lane === 'audio'));
}

// A fixed agent step, run only when Tavily is configured. Qloo picked the
// show or podcast. Tavily finds its calm episodes, a fast Nemotron model
// picks one, and the pick must appear word for word in the search results.
async function episodeStep(state, cfg) {
  const idx = state.pendingEpisode;
  delete state.pendingEpisode;
  state.done = true;
  const s = state.plan.steps[idx];
  const entity = s && s.item && state.scratch.entities[s.item.id];
  if (!entity) return state;
  const llm = createLLM(cfg, { deadline: Date.now() + cfg.agent.stepBudgetMs });
  const search = await searchEpisodes(entity, cfg);
  addTrace(state, {
    kind: 'tavily',
    title: 'Tavily search for one calm episode',
    detail: search.available ? `${entity.name}: ${search.results.length} results` : search.note,
    source: search.available ? 'live' : 'off',
    ms: search.ms,
  });
  state.sources.tavily = (state.sources.tavily || 0) + 1;
  if (!search.available || !search.results.length) return state;
  let pick = null;
  try {
    const { data } = await llm.json('fast', { messages: episodeMessages(entity, search, state.input.favorites || []), purpose: 'pick_episode', maxTokens: 400, temperature: 0.1, context: { entity, search } });
    pick = groundEpisode(data, search);
  } catch (err) {
    state.notes.push('episode pick failed: ' + err.message);
  }
  collectReceipts(state, createQloo(cfg), llm);
  if (!pick) {
    addTrace(state, { kind: 'note', title: 'No episode kept', detail: 'The pick did not appear in the search results, so the step stays as it was.' });
    return state;
  }
  s.episode = { ...pick, source: 'tavily' };
  addTrace(state, { kind: 'tool', title: 'Named one episode', tool: 'episode', detail: `${entity.name}: ${pick.title}${pick.seasonEpisode ? ` (${pick.seasonEpisode})` : ''}` });
  return state;
}

async function fallback(state, reason, cfg) {
  // If the planner model failed before Qloo was asked anything (for example
  // the Token Factory credits ran out), the next step runs the same tool
  // sequence the offline mock uses, so the page still shows a Qloo-grounded
  // plan and says plainly why. It runs as its own step to stay inside the
  // serverless time limit.
  if (!Object.keys(state.scratch.candidates || {}).length && cfg && !state.scripted) {
    state.scripted = reason;
    addTrace(state, { kind: 'fallback', title: 'Planner model unavailable, running the fixed tool sequence next', detail: reason });
    return state;
  }
  return assemble(state, reason, cfg);
}

async function scriptedStep(state, cfg) {
  const reason = state.scripted;
  state.notes.push('The planner model could not be reached, so Offramp ran its fixed tool sequence on the same Qloo data. ' + reason);
  {
    const qloo = createQloo(cfg);
    const llm = createLLM(cfg, { deadline: Date.now() + cfg.agent.stepBudgetMs });
    const ctx = { qloo, llm, scratch: state.scratch, input: state.input, cfg, notes: state.notes, submitted: null, scripted: true };
    for (let i = 0; i < 5; i++) {
      const turn = scriptedTurn({ scratch: state.scratch, intake: state.intake, input: state.input });
      if (turn.tool_calls.some((c) => c.function.name === 'submit_plan')) break;
      for (const call of turn.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          args = {};
        }
        const result = await runTool(call.function.name, args, ctx).catch((err) => ({ error: err.message }));
        addTrace(state, { kind: 'tool', title: toolTitle(call.function.name), tool: call.function.name, detail: toolDetail(call.function.name, args, result) });
      }
    }
    collectReceipts(state, qloo, llm);
  }
  return assemble(state, reason, cfg);
}

function assemble(state, reason, cfg) {
  const plan = autoPlan(state.scratch, state.input);
  const check = validatePlan(plan, state.scratch, state.input);
  addTrace(state, { kind: 'fallback', title: 'Deterministic planner took over', detail: reason });
  if (!plan.steps.length || !check.ok) {
    state.done = true;
    state.error = 'Offramp could not find enough calm, taste-matched options tonight. Try adding one more favorite.';
    state.validationErrors = check.errors;
    return state;
  }
  finish(state, plan, { fallback: true, reason, warnings: check.warnings }, cfg);
  return state;
}

export async function step(state, cfg = getConfig()) {
  if (state.done) return state;
  if (state.pendingEpisode !== undefined) return episodeStep(state, cfg);
  if (state.scripted && !state.plan) return scriptedStep(state, cfg);
  if (state.steps >= cfg.agent.maxSteps) return fallback(state, `planner used all ${cfg.agent.maxSteps} steps`, cfg);
  state.steps += 1;
  const qloo = createQloo(cfg);
  const llm = createLLM(cfg, { deadline: Date.now() + cfg.agent.stepBudgetMs });
  const tools = toolSchemas();
  const ctx = { qloo, llm, scratch: state.scratch, input: state.input, cfg, notes: state.notes, submitted: null };

  let res;
  try {
    res = await llm.chat('planner', {
      messages: state.messages,
      tools: state.toolMode === 'native' ? tools : undefined,
      purpose: 'plan next action',
      maxTokens: 2500,
      temperature: 0.2,
      context: { scratch: state.scratch, input: state.input, intake: state.intake },
    });
  } catch (err) {
    collectReceipts(state, qloo, llm);
    if (state.toolMode === 'native' && err.status === 400) {
      state.toolMode = 'text';
      state.messages[0] = { role: 'system', content: state.messages[0].content + '\n\n' + textProtocolAddendum(tools) };
      addTrace(state, { kind: 'note', title: 'Switched to JSON tool protocol', detail: err.message.slice(0, 160) });
      return state;
    }
    return fallback(state, 'planner call failed: ' + err.message.slice(0, 160), cfg);
  }

  const msg = res.message;
  let calls = (msg.tool_calls || []).slice(0, MAX_TOOL_CALLS_PER_STEP);
  if (!calls.length) {
    const parsed = extractJson(msg.content);
    if (parsed && parsed.tool) {
      calls = [{ id: 'text-' + state.steps, type: 'function', function: { name: parsed.tool, arguments: JSON.stringify(parsed.arguments || {}) } }];
    }
  }
  if (msg.content && msg.content.trim() && !(calls.length && calls[0].id.startsWith('text-'))) {
    addTrace(state, { kind: 'think', title: 'Planner', detail: msg.content.trim().slice(0, 280) });
  }

  if (!calls.length) {
    state.messages.push({ role: 'assistant', content: msg.content || '' });
    state.nudges += 1;
    collectReceipts(state, qloo, llm);
    if (state.nudges > 2) return fallback(state, 'planner stopped calling tools', cfg);
    state.messages.push({ role: 'user', content: 'Please continue by calling a tool. Finish with submit_plan.' });
    return state;
  }

  const textMode = calls[0].id.startsWith('text-');
  if (textMode) state.metrics.textToolTurns += 1;
  state.messages.push(textMode ? { role: 'assistant', content: msg.content } : { role: 'assistant', content: msg.content || '', tool_calls: calls });

  for (const call of calls) {
    let args = {};
    try {
      args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : call.function.arguments || {};
    } catch {
      args = extractJson(call.function.arguments) || {};
    }
    const name = call.function.name;
    let result;
    if (cfg.nebius.enabled && llm.left() < 4000) {
      // Out of time in this serverless step. Hand the call back to the
      // planner instead of letting the request hit the platform limit.
      state.metrics.deferredCalls += 1;
      result = { error: `Out of time in this step. Call ${name} again in your next turn.` };
    } else {
      try {
        result = await runTool(name, args, ctx);
      } catch (err) {
        result = { error: `${name} failed: ${err.message}` };
      }
    }
    addTrace(state, { kind: 'tool', title: toolTitle(name), tool: name, detail: toolDetail(name, args, result) });
    const content = JSON.stringify(result).slice(0, 12000);
    state.messages.push(textMode ? { role: 'user', content: `Result of ${name}: ${content}` } : { role: 'tool', tool_call_id: call.id, content });
    if (ctx.submitted) break;
  }
  collectReceipts(state, qloo, llm);

  if (ctx.submitted) {
    finish(state, ctx.submitted.plan, { fallback: false, warnings: ctx.submitted.warnings }, cfg);
  } else if ((state.scratch.flags.rejected || 0) >= 3) {
    return fallback(state, 'planner drafts were rejected three times', cfg);
  } else {
    const hint = budgetHint(state, cfg);
    if (hint) state.messages.push({ role: 'user', content: hint });
  }
  return state;
}

// The live planner tends to make one tool call per turn and keep looking
// things up until it runs out of turns. Near the end of the step budget it is
// told how many turns are left and to wrap up, so it submits its own plan
// instead of handing over to the safety net.
function budgetHint(state, cfg) {
  const left = cfg.agent.maxSteps - state.steps;
  if (left > 3 || left < 1) return null;
  const hasCandidates = Object.entries(state.scratch.candidates || {}).some(([lane, ids]) => lane !== 'trap_radar' && ids.length);
  if (!hasCandidates) return `${left} planner turn${left === 1 ? '' : 's'} left. Call recommend for the audio and music lanes now, then submit_plan.`;
  if (left === 1) return 'This is your last turn. Call submit_plan now with 2 to 5 steps, using only entity_ids from the tool results above. The last step must be a podcast or an artist.';
  const rate = state.scratch.flags.rated ? '' : 'call rate_arousal once on the candidates you are considering, then ';
  return `${left} planner turns left. Stop looking things up: ${rate}call submit_plan with 2 to 5 steps.`;
}

function toolTitle(name) {
  return (
    {
      resolve_taste: 'Matched your taste in Qloo',
      find_tags: 'Looked up calm tags',
      recommend: 'Asked Qloo for candidates',
      rate_arousal: 'Rated pre-sleep arousal',
      submit_plan: 'Submitted the plan for checks',
    }[name] || name
  );
}

function toolDetail(name, args, result) {
  if (result && result.error) return { error: result.error };
  switch (name) {
    case 'resolve_taste':
      return (result.resolved || []).map((r) => (r.unresolved ? `${r.query} (not in the taste graph, treated as a habit)` : `${r.query} → ${r.name}`));
    case 'find_tags':
      return `${result.entity_type}: ${(result.tags || []).map((t) => t.name).join(', ') || 'no tags found'}`;
    case 'recommend':
      return `${args.lane} (${result.entity_type}): ${(result.candidates || []).slice(0, 6).map((c) => c.name).join(', ')}`;
    case 'rate_arousal': {
      const list = result.ratings || [];
      const byModel = list.filter((r) => r.by === 'model').length;
      return `${list.map((r) => `${r.name} ${r.arousal}`).join(', ')} (${byModel} of ${list.length} rated by the model${byModel < list.length ? ', the rest by the fallback heuristic' : ''})`;
    }
    case 'submit_plan':
      return result.accepted ? 'accepted' : { rejected: result.errors };
    default:
      return result;
  }
}

// "Try to break the checks". Hands the validator the accepted plan plus two
// drafts broken on purpose, so a judge can watch Qloo grounding and the sleep
// rules reject them. No model or Qloo calls, so it is instant and free.
export function probeValidator(state) {
  const plan = state && state.plan;
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length || !state.scratch) return { error: 'Build a plan first.' };
  const scratch = state.scratch;
  const base = plan.steps
    .filter((s) => s.item && s.item.id)
    .map((s) => ({ minutes_before_sleep: s.minutesBeforeSleep, lane: s.item.lane, entity_id: s.item.id, instruction: s.instruction, why: s.why }));
  const check = (label, draft) => {
    const v = validatePlan(draft, scratch, state.input);
    return { label, accepted: v.ok, errors: v.errors };
  };
  const cases = [check('The plan you got tonight', { steps: base })];

  // A title the model knows from training, but Qloo did not return in this run.
  const invented = base.map((s, i) => (i === 0 ? { ...s, entity_id: 'not-returned-by-qloo' } : s));
  cases.push(check('Step 1 swapped for a title the model made up', { steps: invented }));

  // The step keeps a real Qloo id, but its text recommends a title from memory.
  const smuggled = base.map((s, i) => (i === base.length - 1 ? { ...s, instruction: `${s.instruction} Then put on "Weightless" by Marconi Union.` } : s));
  cases.push(check('Last step keeps its Qloo id, but its text slips in a song the model remembers', { steps: smuggled }));

  // Something the person said keeps them up, slipped into the last minutes.
  const trap = Object.values(scratch.resolved || {}).find((r) => r && r.role === 'trap' && r.id && scratch.entities[r.id]);
  const screenId = ((scratch.candidates && scratch.candidates.screen) || []).find((id) => scratch.entities[id]);
  const intruder = trap ? trap.id : screenId;
  if (intruder) {
    const name = scratch.entities[intruder].name;
    const late = [...base, { minutes_before_sleep: 5, entity_id: intruder, instruction: 'Watch this in bed.', why: 'stress test' }];
    cases.push(check(trap ? `${name}, which you said keeps you up, added 5 minutes before sleep` : `${name} moved to 5 minutes before sleep`, { steps: late }));
  }
  return { cases };
}

export function signState(state, cfg = getConfig()) {
  const out = { ...state };
  delete out.sig;
  out.sig = sign(out, cfg.agent.stateSecret);
  return out;
}

export async function runToCompletion(rawInput, cfg = getConfig(), onStep) {
  let state = await startRun(rawInput, cfg);
  if (onStep) onStep(state);
  let guard = 0;
  while (!state.done && guard++ < cfg.agent.maxSteps + 4) {
    state = await step(state, cfg);
    if (onStep) onStep(state);
  }
  return state;
}
