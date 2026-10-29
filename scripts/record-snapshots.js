// Records real Qloo responses for the example personas into a private cache.
// Qloo switches hackathon keys off after its judging ends, so the deployed
// demo can keep showing real Qloo data for the examples after that (labeled
// "Qloo recorded" in the UI).
//
// Qloo's hackathon guide allows private server-side caching but asks builders
// not to store Qloo response data in a public repository. So this script
// writes two gitignored files and nothing else.
//   data/qloo-snapshots.local.json   read by the local server
//   qloo-snapshots.env.local.txt     one line to paste into the hosting
//                                    dashboard as QLOO_SNAPSHOTS_GZ_B64
//
//   npm run record      (needs QLOO_API_KEY, NEBIUS_API_KEY is optional)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { loadEnv, root } from './env.js';
loadEnv();
if (!process.env.QLOO_API_KEY) {
  console.log('Set QLOO_API_KEY in .env first.');
  process.exit(1);
}
process.env.QLOO_RECORD = '1';
const { getConfig } = await import('../lib/config.js');
const { runToCompletion } = await import('../lib/agent.js');
const { snapshotCount, allSnapshots, SNAPSHOT_PATH } = await import('../lib/qloo.js');
const personas = JSON.parse(readFileSync(join(root, 'data', 'personas.json'), 'utf8'));

// Pass 1 with the deterministic planner, so offline runs replay exactly.
process.env.OFFRAMP_FORCE_MOCK_LLM = '1';
for (const p of personas) {
  const s = await runToCompletion(p.input, getConfig());
  console.log('mock planner', p.id, s.plan ? 'plan ok' : 'no plan', JSON.stringify(s.sources.qloo));
}
// Pass 2 with live Nemotron if a key is present, to cover the calls it tends to make.
delete process.env.OFFRAMP_FORCE_MOCK_LLM;
if (process.env.NEBIUS_API_KEY) {
  for (const p of personas) {
    const s = await runToCompletion(p.input, getConfig());
    console.log('live planner', p.id, s.plan ? 'plan ok' : 'no plan', JSON.stringify(s.sources.qloo));
  }
}

const packed = gzipSync(Buffer.from(JSON.stringify(allSnapshots()), 'utf8'), { level: 9 }).toString('base64');
const envFile = join(root, 'qloo-snapshots.env.local.txt');
writeFileSync(envFile, packed + '\n');
console.log(`snapshots now hold ${snapshotCount()} responses`);
console.log(`private cache file  ${SNAPSHOT_PATH}`);
console.log(`dashboard value     ${envFile} (${packed.length} characters)`);
if (packed.length > 60000) {
  console.log('The value is over 60,000 characters. Vercel allows about 64 KB of environment variables in total,');
  console.log('so record fewer personas or skip the hosted fallback. The local file still works.');
} else {
  console.log('Paste the line from that file into the hosting dashboard as QLOO_SNAPSHOTS_GZ_B64. Never commit either file.');
}
