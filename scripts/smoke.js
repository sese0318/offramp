// End-to-end run of the agent for each example persona, printed to the
// terminal. Works with no keys (mock Nemotron, sample taste data) and with
// real keys from .env or the environment.
//   node scripts/smoke.js            all personas
//   node scripts/smoke.js one-more-boss

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { getConfig, publicStatus } = await import('../lib/config.js');
const { runToCompletion } = await import('../lib/agent.js');
const { baseline } = await import('../lib/extras.js');
const personas = JSON.parse(readFileSync(join(root, 'data', 'personas.json'), 'utf8'));

const only = process.argv[2];
const cfg = getConfig();
console.log('Status', JSON.stringify(publicStatus(cfg)));
let failures = 0;

for (const p of personas.filter((x) => !only || x.id === only)) {
  const t0 = Date.now();
  const state = await runToCompletion(p.input, cfg);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n=== ${p.label} (${secs}s, ${state.steps} planner steps)`);
  if (!state.plan) {
    failures++;
    console.log('NO PLAN', state.error || '', state.validationErrors || '');
    continue;
  }
  console.log('Qloo sources', JSON.stringify(state.sources.qloo), '| Nemotron', state.sources.nemotron, '| fallback', Boolean(state.plan.meta.fallback));
  for (const [tier, u] of Object.entries(state.usage)) console.log(`  ${tier.padEnd(7)} ${u.model}  calls ${u.calls}  tokens ${u.tokens}`);
  for (const s of state.plan.steps) {
    console.log(`  ${s.at}  ${s.item.lane.padEnd(6)} ${s.item.name}  (affinity ${s.item.affinity}, arousal ${s.item.arousal})`);
    if (s.episode) console.log(`         episode "${s.episode.title}"${s.episode.seasonEpisode ? ` (${s.episode.seasonEpisode})` : ''}  ${s.episode.url}`);
  }
  const ep = state.trace.filter((t) => t.kind === 'tavily' || (t.kind === 'note' && /episode/i.test(t.title)) || t.tool === 'episode');
  for (const t of ep) console.log(`  [${t.kind}] ${t.title}: ${typeof t.detail === 'string' ? t.detail : JSON.stringify(t.detail)}${t.ms ? ` (${t.ms} ms)` : ''}`);
  if (state.plan.ifAwake) console.log(`  if awake  ${state.plan.ifAwake.item.name}`);
  console.log('  skip tonight', state.plan.skipTonight.map((s) => `${s.item.name} (arousal ${s.item.arousal})`).join(', ') || 'none');
  if (process.env.SMOKE_BASELINE === '1') {
    const b = await baseline(p.input, cfg);
    console.log('  baseline (no Qloo)\n   ', b.text.replace(/\n/g, '\n    '));
  }
}
if (failures) {
  console.log(`\n${failures} persona(s) produced no plan`);
  process.exit(1);
}
console.log('\nsmoke ok');
