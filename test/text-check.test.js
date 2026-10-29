// The free-text scan in the validator. A step can carry a real Qloo id and
// still recommend something else in its instruction. The scan catches quoted
// titles and capitalized names that no Qloo call returned in this run.
process.env.OFFRAMP_FORCE_MOCK_LLM = '1';
process.env.OFFRAMP_FORCE_SAMPLE_QLOO = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { getConfig } = await import('../lib/config.js');
const { runToCompletion } = await import('../lib/agent.js');
const { validatePlan, unknownNames, namesInText, autoPlan } = await import('../lib/plan.js');
const personas = JSON.parse(readFileSync(new URL('../data/personas.json', import.meta.url), 'utf8'));

const scratch = {
  entities: { a: { name: 'Sleep With Me' }, b: { name: 'Brian Eno' }, c: { name: 'The House in the Cerulean Sea' } },
  resolved: { 'Joe Hisaishi': { name: 'Joe Hisaishi' } },
};
const input = { favorites: ['The Great British Bake Off', 'Spirited Away'], traps: ['Breaking Bad'] };

test('names Qloo returned, or the person typed, pass the scan', () => {
  for (const text of [
    'Lights low. Put on Sleep With Me with the screen face down.',
    'In bed. Brian Eno at low volume with a 30 minute sleep timer.',
    'Because you like The Great British Bake Off and Spirited Away.',
    'Turn on Do Not Disturb first. Unlike Breaking Bad, nothing here ends on a cliffhanger.',
    'Still awake? Read a few pages of The House in the Cerulean Sea in dim light.',
    'Your taste, but low stakes and with a clear end.',
  ]) {
    assert.deepEqual(unknownNames(text, scratch, input), [], text);
  }
});

test('titles from memory are caught', () => {
  assert.ok(unknownNames('Then put on "Weightless" by Marconi Union.', scratch, input).length);
  assert.ok(unknownNames('Marconi Union at low volume.', scratch, input).includes('Marconi Union'));
  assert.ok(unknownNames('Watch The Office, season 2.', scratch, input).length);
  assert.ok(unknownNames('Because you like Spirited Away and Studio Ghibli Classics.', scratch, input).length);
  assert.deepEqual(namesInText('no names here at all.'), []);
});

test('the validator rejects a grounded step whose text smuggles in another title', async () => {
  const state = await runToCompletion(personas[0].input, getConfig());
  const plan = autoPlan(state.scratch, state.input);
  assert.equal(validatePlan(plan, state.scratch, state.input).ok, true);
  plan.steps[plan.steps.length - 1].instruction += ' Or try "Weightless" by Marconi Union instead.';
  const check = validatePlan(plan, state.scratch, state.input);
  assert.equal(check.ok, false);
  assert.match(check.errors.join(' '), /text names "Weightless/);
});
