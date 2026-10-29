// Tools the planner model can call. Each tool runs real Qloo requests (or the
// labeled fallback) and stores what came back in the run's scratch space, which
// is what submit_plan is validated against.

import { ENTITY_TYPES } from './qloo.js';
import { arousalPrompt, compactForRating, heuristicArousal } from './arousal.js';
import { LANES, validatePlan } from './plan.js';

const KIND_TO_TYPE = {
  artist: ENTITY_TYPES.artist,
  music: ENTITY_TYPES.artist,
  band: ENTITY_TYPES.artist,
  movie: ENTITY_TYPES.movie,
  film: ENTITY_TYPES.movie,
  tv_show: ENTITY_TYPES.tv_show,
  tv: ENTITY_TYPES.tv_show,
  show: ENTITY_TYPES.tv_show,
  podcast: ENTITY_TYPES.podcast,
  book: ENTITY_TYPES.book,
  videogame: ENTITY_TYPES.videogame,
  video_game: ENTITY_TYPES.videogame,
  game: ENTITY_TYPES.videogame,
};

export function toEntityType(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (v.startsWith('urn:entity:')) {
    const short = v.replace('urn:entity:', '');
    return KIND_TO_TYPE[short] || null;
  }
  return KIND_TO_TYPE[v] || null;
}

// Tavily is not a planner tool. When it is configured, the agent runs a fixed
// episode step after the plan is accepted (see lib/agent.js), so the first
// step always names one episode instead of depending on the model to ask.
export function toolSchemas() {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'resolve_taste',
        description:
          'Look up the things the person named in the Qloo taste graph and get their entity ids. Use role favorite for what they love and trap for what keeps them up at night. Skip habits that are not titles (for example scrolling).',
        parameters: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  kind: { type: 'string', enum: ['artist', 'movie', 'tv_show', 'podcast', 'book', 'videogame', 'unknown'] },
                  role: { type: 'string', enum: ['favorite', 'trap'] },
                },
                required: ['name', 'role'],
              },
            },
          },
          required: ['items'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'find_tags',
        description: 'Search Qloo tag ids for a mood or genre word (for example calm, relaxing, ambient, cozy, sleep) within one entity type.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            entity_type: { type: 'string', enum: ['artist', 'movie', 'tv_show', 'podcast', 'book'] },
          },
          required: ['query', 'entity_type'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recommend',
        description:
          'Ask Qloo for taste-matched candidates of one entity type, using the person\'s resolved entity ids as signals. Use lane screen, audio, music or page for the plan, with calm tag ids to keep it gentle. Use lane trap_radar without tags to see the high-affinity titles most likely to keep this person up.',
        parameters: {
          type: 'object',
          properties: {
            lane: { type: 'string', enum: ['screen', 'audio', 'music', 'page', 'trap_radar'] },
            entity_type: { type: 'string', enum: ['artist', 'movie', 'tv_show', 'podcast', 'book'] },
            signal_entity_ids: { type: 'array', items: { type: 'string' } },
            tag_ids: { type: 'array', items: { type: 'string' } },
            exclude_entity_ids: { type: 'array', items: { type: 'string' } },
            take: { type: 'integer', minimum: 3, maximum: 15 },
          },
          required: ['lane', 'entity_type', 'signal_entity_ids'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'rate_arousal',
        description: 'Rate candidates for pre-sleep arousal from 0 (calming) to 10 (keeps you up). Call this before choosing what goes in the plan.',
        parameters: {
          type: 'object',
          properties: { entity_ids: { type: 'array', items: { type: 'string' } } },
          required: ['entity_ids'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'submit_plan',
        description:
          'Submit tonight\'s plan. Steps go from earliest to latest, every entity_id must come from a tool result, screens start at least 45 minutes before sleep, every step has arousal 5 or less, and the last step is a podcast or an artist.',
        parameters: {
          type: 'object',
          properties: {
            headline: { type: 'string' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  minutes_before_sleep: { type: 'integer' },
                  lane: { type: 'string', enum: ['screen', 'audio', 'music', 'page'] },
                  entity_id: { type: 'string' },
                  instruction: { type: 'string' },
                  why: { type: 'string' },
                },
                required: ['minutes_before_sleep', 'lane', 'entity_id', 'instruction', 'why'],
              },
            },
            if_awake: {
              type: 'object',
              properties: { entity_id: { type: 'string' }, instruction: { type: 'string' }, why: { type: 'string' } },
            },
            skip_tonight: {
              type: 'array',
              items: { type: 'object', properties: { entity_id: { type: 'string' }, why: { type: 'string' } }, required: ['entity_id', 'why'] },
            },
            note: { type: 'string' },
          },
          required: ['steps'],
        },
      },
    },
  ];
  return tools;
}

export function compactEntity(e, scratch) {
  return {
    entity_id: e.id,
    name: e.name,
    type: String(e.type || '').replace('urn:entity:', ''),
    affinity: e.affinity,
    tags: (e.tags || []).slice(0, 5).map((t) => t.name),
    because_you_like: (e.because || []).map((b) => scratch.entities[b.id] && scratch.entities[b.id].name).filter(Boolean),
    description: (e.description || '').slice(0, 120),
  };
}

function remember(scratch, entity, source) {
  if (!entity || !entity.id) return;
  const prev = scratch.entities[entity.id];
  scratch.entities[entity.id] = { ...(prev || {}), ...entity, source: prev && prev.source === 'live' ? 'live' : source };
}

function knownIds(scratch, ids) {
  const out = [];
  for (const raw of ids || []) {
    if (scratch.entities[raw]) out.push(raw);
    else if (scratch.resolved && scratch.resolved[raw] && scratch.resolved[raw].id) out.push(scratch.resolved[raw].id);
  }
  return [...new Set(out)];
}

export async function runTool(name, args, ctx) {
  const { qloo, llm, scratch, input, cfg } = ctx;
  args = args || {};
  switch (name) {
    case 'resolve_taste': {
      const items = (args.items || []).slice(0, 10);
      const results = [];
      for (const it of items) {
        const nameQ = String(it.name || '').slice(0, 80);
        if (!nameQ) continue;
        const type = toEntityType(it.kind);
        const { source, results: hits } = await qloo.search(nameQ, type ? { types: type, take: 3 } : { take: 3 });
        const hit = hits[0];
        if (hit) {
          remember(scratch, hit, source);
          scratch.resolved[nameQ] = { id: hit.id, name: hit.name, role: it.role || 'favorite', type: hit.type };
          results.push({ query: nameQ, role: it.role, entity_id: hit.id, name: hit.name, type: String(hit.type).replace('urn:entity:', '') });
        } else {
          scratch.resolved[nameQ] = { id: null, role: it.role || 'favorite' };
          results.push({ query: nameQ, role: it.role, unresolved: true });
        }
      }
      scratch.flags.resolved = true;
      return { resolved: results };
    }
    case 'find_tags': {
      const type = toEntityType(args.entity_type);
      if (!type) return { error: 'entity_type must be artist, movie, tv_show, podcast or book' };
      const query = String(args.query || 'calm').slice(0, 40);
      const lookup = `${type}|${query.toLowerCase().trim()}`;
      const seen = (scratch.flags.tagLookups = scratch.flags.tagLookups || []);
      if (seen.includes(lookup)) {
        // The live planner sometimes repeats a lookup. Answer from this run
        // and point it at the next job instead of spending another Qloo call.
        const key = type.replace('urn:entity:', '');
        return { entity_type: key, tags: (scratch.tags[key] || []).map((t) => ({ id: t.id, name: t.name })), note: 'Already looked up in this run. Use these tag ids with recommend and move on.' };
      }
      seen.push(lookup);
      const { tags } = await qloo.tags(query, { parentType: type, take: 8 });
      const key = type.replace('urn:entity:', '');
      scratch.tags[key] = [...new Map([...(scratch.tags[key] || []), ...tags].map((t) => [t.id, t])).values()];
      scratch.flags.tags = true;
      return { entity_type: key, tags: tags.map((t) => ({ id: t.id, name: t.name })) };
    }
    case 'recommend': {
      const lane = args.lane;
      const type = toEntityType(args.entity_type);
      if (!type) return { error: 'entity_type must be artist, movie, tv_show, podcast or book' };
      if (lane !== 'trap_radar' && !(LANES[lane] || []).includes(type)) {
        return { error: `lane ${lane} takes ${(LANES[lane] || []).map((t) => t.replace('urn:entity:', '')).join(' or ')}` };
      }
      const signals = knownIds(scratch, args.signal_entity_ids);
      if (!signals.length) return { error: 'signal_entity_ids must be entity ids returned by resolve_taste' };
      const exclude = knownIds(scratch, args.exclude_entity_ids);
      const { source, entities } = await qloo.insights({
        type,
        signalEntities: signals,
        tags: (args.tag_ids || []).slice(0, 8),
        excludeEntities: exclude,
        take: Math.max(3, Math.min(15, Number(args.take) || 8)),
        trendBias: lane === 'trap_radar' ? undefined : 'low',
      });
      entities.forEach((e) => remember(scratch, e, source));
      const ids = entities.map((e) => e.id);
      scratch.candidates[lane] = [...new Set([...(scratch.candidates[lane] || []), ...ids])];
      return { lane, entity_type: type.replace('urn:entity:', ''), candidates: entities.map((e) => compactEntity(e, scratch)) };
    }
    case 'rate_arousal': {
      const ids = knownIds(scratch, args.entity_ids).slice(0, 30);
      if (!ids.length) return { error: 'entity_ids must come from earlier tool results' };
      if (llm.mode === 'live' && !ctx.scripted && llm.left() < Math.min(15000, cfg.nebius.timeoutMs + 2000)) {
        // Not enough time left in this serverless step for a model call. Ask
        // the planner to repeat it next turn instead of silently falling back
        // to the heuristic.
        return { error: 'Not enough time left in this step to rate these. Call rate_arousal again with the same ids in your next turn.' };
      }
      const items = ids.map((id) => compactForRating(scratch.entities[id]));
      let ratings = [];
      try {
        const { data } = await llm.json('fast', { messages: arousalPrompt(items), purpose: 'rate_arousal', maxTokens: 1500, temperature: 0.1, context: { items } });
        ratings = (data && data.ratings) || [];
      } catch (err) {
        ratings = [];
        ctx.notes.push('arousal model call failed, used heuristic: ' + err.message);
      }
      const byId = new Map(ratings.map((r) => [r.id, r]));
      const out = ids.map((id) => {
        const r = byId.get(id);
        const h = heuristicArousal(scratch.entities[id]);
        const arousal = r && Number.isFinite(Number(r.arousal)) ? Math.max(0, Math.min(10, Math.round(Number(r.arousal)))) : h;
        scratch.ratings[id] = { arousal, heuristic: h, reason: (r && String(r.reason || '').slice(0, 100)) || '', by: r ? 'model' : 'heuristic' };
        return { entity_id: id, name: scratch.entities[id].name, arousal, reason: scratch.ratings[id].reason, by: scratch.ratings[id].by };
      });
      scratch.flags.rated = true;
      return { ratings: out };
    }
    case 'submit_plan': {
      const check = validatePlan(args, scratch, input);
      scratch.flags.drafts = (scratch.flags.drafts || 0) + 1;
      if (!check.ok) {
        scratch.flags.rejected = (scratch.flags.rejected || 0) + 1;
        // Counted for the benchmark: ids and names the model made up.
        scratch.flags.invented = (scratch.flags.invented || 0) + check.errors.filter((e) => /no Qloo tool returned/.test(e)).length;
        return { accepted: false, errors: check.errors, warnings: check.warnings, hint: 'Fix these and call submit_plan again.' };
      }
      scratch.flags.submitted = true;
      ctx.submitted = { plan: args, warnings: check.warnings };
      return { accepted: true, warnings: check.warnings };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
