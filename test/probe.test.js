// The "Try to break the checks" button. The accepted plan passes, and the three
// drafts broken on purpose are rejected for the right reasons.
process.env.OFFRAMP_FORCE_MOCK_LLM = '1';
process.env.OFFRAMP_FORCE_SAMPLE_QLOO = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { getConfig } = await import('../lib/config.js');
const { runToCompletion, probeValidator, signState, verify } = await import('../lib/agent.js');
const personas = JSON.parse(readFileSync(new URL('../data/personas.json', import.meta.url), 'utf8'));

test('validator stress test accepts the plan and rejects the broken drafts', async () => {
  const cfg = getConfig();
  for (const p of personas) {
    const state = signState(await runToCompletion(p.input, cfg), cfg);
    assert.ok(verify(state, cfg.agent.stateSecret));
    const { cases, error } = probeValidator(state);
    assert.equal(error, undefined);
    assert.equal(cases[0].accepted, true, `${p.id} ${cases[0].errors}`);
    assert.equal(cases[1].accepted, false);
    assert.ok(cases[1].errors.some((e) => /no Qloo tool returned/.test(e)), cases[1].errors.join(' | '));
    assert.equal(cases.length, 4);
    assert.equal(cases[2].accepted, false);
    assert.ok(cases[2].errors.some((e) => /text names "Weightless by Marconi Union"/.test(e)), cases[2].errors.join(' | '));
    assert.equal(cases[3].accepted, false);
    assert.ok(cases[3].errors.some((e) => /keeps them up|Screens must start|audio only/.test(e)), cases[3].errors.join(' | '));
  }
  assert.deepEqual(probeValidator({}), { error: 'Build a plan first.' });
});
