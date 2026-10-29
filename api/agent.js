import { getConfig } from '../lib/config.js';
import { startRun, step, signState, verify, probeValidator } from '../lib/agent.js';
import { readJson, send, rateLimited } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (rateLimited(req)) return send(res, 429, { error: 'Too many requests from this address. Try again in a few minutes.' });
  const cfg = getConfig();
  try {
    const body = await readJson(req);
    if (body.action === 'start') {
      const state = await startRun(body.input || {}, cfg);
      return send(res, 200, signState(state, cfg));
    }
    if (body.action === 'step' || body.action === 'probe') {
      const state = body.state;
      if (!verify(state, cfg.agent.stateSecret)) return send(res, 400, { error: 'State signature did not match. Start a new run.' });
      if (body.action === 'probe') return send(res, 200, probeValidator(state));
      const next = await step(state, cfg);
      return send(res, 200, signState(next, cfg));
    }
    return send(res, 400, { error: 'action must be start, step or probe' });
  } catch (err) {
    return send(res, 500, { error: 'Agent error: ' + err.message });
  }
}
