import { baseline } from '../lib/extras.js';
import { readJson, send, rateLimited } from '../lib/http.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
  if (rateLimited(req)) return send(res, 429, { error: 'Too many requests. Try again in a few minutes.' });
  try {
    const body = await readJson(req);
    // planItems only feeds the side-by-side counts on the page. It is never
    // sent to a model.
    return send(res, 200, await baseline(body.input || {}, undefined, Array.isArray(body.planItems) ? body.planItems : null));
  } catch (err) {
    return send(res, 500, { error: 'Baseline error: ' + err.message });
  }
}
