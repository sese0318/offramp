import { createHash } from 'node:crypto';

// Central configuration. Every external service is optional: with no keys the
// app runs end to end on bundled sample data and a deterministic mock model,
// and each response says which source it came from.

const env = (name, fallback = '') => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
};

export function getConfig() {
  const nebiusKey = env('NEBIUS_API_KEY');
  const qlooKey = env('QLOO_API_KEY');
  const tavilyKey = env('TAVILY_API_KEY');
  const globalBase = 'https://api.tokenfactory.nebius.com/v1';
  const regionalBase = 'https://api.tokenfactory.us-central1.nebius.com/v1';

  return {
    appName: 'Offramp',
    nebius: {
      enabled: Boolean(nebiusKey) && env('OFFRAMP_FORCE_MOCK_LLM') !== '1',
      apiKey: nebiusKey,
      timeoutMs: Number(env('NEBIUS_TIMEOUT_MS', '40000')),
      extraBody: safeJson(env('NEBIUS_EXTRA_BODY', '')),
      // Three tiers, routed by job. Fast model for parsing and rating,
      // Super for the tool-calling planner, Ultra for the weekly reflection.
      models: {
        fast: {
          id: env('NEBIUS_MODEL_FAST', 'nvidia/Nemotron-3_5-Lightning'),
          baseUrl: env('NEBIUS_BASE_URL_FAST', globalBase),
        },
        planner: {
          id: env('NEBIUS_MODEL_PLANNER', 'nvidia/nemotron-3-super-120b-a12b'),
          baseUrl: env('NEBIUS_BASE_URL_PLANNER', regionalBase),
        },
        deep: {
          id: env('NEBIUS_MODEL_DEEP', 'nvidia/Nemotron-3-Ultra-550b-a55b'),
          baseUrl: env('NEBIUS_BASE_URL_DEEP', regionalBase),
        },
      },
    },
    qloo: {
      enabled: Boolean(qlooKey) && env('OFFRAMP_FORCE_SAMPLE_QLOO') !== '1',
      forceSample: env('OFFRAMP_FORCE_SAMPLE_QLOO') === '1',
      apiKey: qlooKey,
      baseUrl: env('QLOO_BASE_URL', 'https://hackathon.api.qloo.com'),
      timeoutMs: Number(env('QLOO_TIMEOUT_MS', '12000')),
      paceMs: Number(env('QLOO_PACE_MS', '120')),
      record: env('QLOO_RECORD') === '1',
    },
    tavily: {
      enabled: Boolean(tavilyKey),
      apiKey: tavilyKey,
      baseUrl: env('TAVILY_BASE_URL', 'https://api.tavily.com'),
    },
    agent: {
      // Live Nemotron usually makes one tool call per turn, and a full run
      // needs about ten (resolve, tags, lanes, rating, submit).
      maxSteps: Number(env('OFFRAMP_MAX_STEPS', '12')),
      // One serverless request runs one agent step. vercel.json allows 60
      // seconds, so a step stops starting new model calls after this budget.
      stepBudgetMs: Number(env('OFFRAMP_STEP_BUDGET_MS', '52000')),
      stateSecret: env('OFFRAMP_STATE_SECRET', '') || deriveSecret(nebiusKey + qlooKey),
    },
  };
}

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function deriveSecret(seed) {
  // Stable per deployment without storing anything. Only used to sign the
  // agent state that travels through the browser between steps. A full
  // SHA-256 of the secret keys, so the signing key cannot be brute forced
  // from a signed state. Setting OFFRAMP_STATE_SECRET is still preferred.
  return 'derived-' + createHash('sha256').update('offramp-state:' + seed).digest('hex');
}

export function publicStatus(cfg = getConfig(), snapshotCount = 0) {
  return {
    app: cfg.appName,
    nemotron: cfg.nebius.enabled ? 'live' : 'mock',
    qloo: cfg.qloo.enabled ? 'live' : snapshotCount > 0 && !cfg.qloo.forceSample ? 'snapshot' : 'sample',
    tavily: cfg.tavily.enabled ? 'live' : 'off',
    models: Object.fromEntries(Object.entries(cfg.nebius.models).map(([k, v]) => [k, v.id])),
  };
}
