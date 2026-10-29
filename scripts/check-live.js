// Checks a deployed copy of Offramp from the outside, the way a judge would
// use it. Run it after every deploy and again on December 1, before the
// Nebius judging period.
//   npm run check-live -- https://your-app.vercel.app

const base = String(process.argv[2] || '').replace(/\/$/, '');
if (!/^https?:\/\//.test(base)) {
  console.log('Usage: npm run check-live -- https://your-app.vercel.app');
  process.exit(1);
}

async function post(path, body) {
  const t = Date.now();
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ms: Date.now() - t, data };
}

let ok = true;
const health = await fetch(base + '/api/health').then((r) => r.json()).catch((err) => ({ error: err.message }));
console.log('health', JSON.stringify(health));
if (health.nemotron !== 'live') {
  ok = false;
  console.log('  Nemotron is not live. Check NEBIUS_API_KEY in the hosting dashboard. Nebius stage one needs a runtime call to Token Factory.');
}
if (health.qloo === 'sample') console.log('  Qloo is on the offline sample. Add QLOO_API_KEY, or QLOO_SNAPSHOTS_GZ_B64 after the key is switched off.');

const input = { favorites: ['Spirited Away', 'Phoebe Bridgers', 'Serial', 'The Great British Bake Off'], traps: ['Breaking Bad'], sleepBy: '00:30', windDownMinutes: 90 };
let r = await post('/api/agent', { action: 'start', input });
const stepMs = [r.ms];
let state = r.data;
for (let i = 0; i < 16 && state && !state.done && !state.error; i++) {
  r = await post('/api/agent', { action: 'step', state });
  stepMs.push(r.ms);
  if (r.status !== 200) {
    ok = false;
    console.log(`  step ${i + 1} returned HTTP ${r.status} after ${r.ms} ms: ${JSON.stringify(r.data).slice(0, 200)}`);
    break;
  }
  state = r.data;
}
const plan = state && state.plan;
console.log('steps (ms)', stepMs.join(', '), '| slowest', Math.max(...stepMs));
if (Math.max(...stepMs) > 55000) console.log('  A step came close to the 60 second limit. Lower NEBIUS_TIMEOUT_MS or OFFRAMP_STEP_BUDGET_MS.');
if (!plan) {
  ok = false;
  console.log('NO PLAN', state && (state.error || ''));
} else {
  console.log('plan ok,', plan.steps.length, 'steps | fallback', Boolean(plan.meta.fallback), plan.meta.fallback ? `(${plan.meta.reason})` : '');
  console.log('sources', JSON.stringify(state.sources), '| usage', Object.entries(state.usage || {}).map(([t, u]) => `${t} ${u.calls} calls`).join(', '));
  if (plan.meta.fallback) ok = false;
}
console.log(ok ? '\nLive check passed.' : '\nLive check found a problem, see above.');
process.exit(ok ? 0 : 1);
