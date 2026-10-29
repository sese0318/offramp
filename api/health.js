import { getConfig, publicStatus } from '../lib/config.js';
import { snapshotCount } from '../lib/qloo.js';
import { send } from '../lib/http.js';

// Reports which services are live. Never returns key values.
export default function handler(req, res) {
  return send(res, 200, publicStatus(getConfig(), snapshotCount()));
}
