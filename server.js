// Local server. Serves public/ and routes /api/* to the same handlers Vercel
// runs, so local and deployed behavior match. Reads .env if present.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

function loadDotEnv() {
  const p = join(root, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const routes = {
  '/api/agent': () => import('./api/agent.js'),
  '/api/baseline': () => import('./api/baseline.js'),
  '/api/reflect': () => import('./api/reflect.js'),
  '/api/health': () => import('./api/health.js'),
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (routes[url.pathname]) {
    const mod = await routes[url.pathname]();
    return mod.default(req, res);
  }
  let path = normalize(join(root, 'public', url.pathname === '/' ? 'index.html' : url.pathname));
  if (!path.startsWith(join(root, 'public')) || !existsSync(path) || statSync(path).isDirectory()) {
    path = join(root, 'public', 'index.html');
  }
  res.setHeader('content-type', TYPES[extname(path)] || 'application/octet-stream');
  res.end(readFileSync(path));
});

const port = Number(process.env.PORT || 5174);
server.listen(port, () => {
  console.log(`Offramp running at http://localhost:${port}`);
});
