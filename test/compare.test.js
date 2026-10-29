// The compare panel counts what each side did, from the two outputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { compareFacts } = await import('../lib/extras.js');

test('compare facts are measured, including when the baseline names real titles', () => {
  const input = { favorites: ['Spirited Away', 'Serial'], traps: ['Breaking Bad'] };
  const baselineText = '1. Rewatch Spirited Away with the lights low.\n2. Skip Breaking Bad tonight.\n3. Put on Max Richter Sleep at low volume.';
  const plan = [
    { name: 'Midnight Diner', lane: 'TV show', id: 'q1', arousal: 2, because: ['Spirited Away'] },
    { name: 'Nothing Much Happens', lane: 'podcast', id: 'q2', arousal: 1, because: ['Serial'] },
  ];
  const facts = Object.fromEntries(compareFacts(baselineText, plan, input).map((f) => [f.label, f]));
  assert.match(facts['Titles named'].without, /Max Richter/);
  assert.equal(facts['Tied to a Qloo entity id'].with, '2 of 2');
  assert.equal(facts['Repeats what you typed'].without, 'Spirited Away');
  assert.equal(facts['Repeats what you typed'].with, 'none');
  assert.equal(facts['Recommends what keeps you up'].without, 'mentions Breaking Bad');
  assert.equal(facts['Recommends what keeps you up'].with, 'none');
  assert.match(facts['New to you, found from your taste'].with, /^2/);
  assert.match(facts['Each step rated for pre-sleep arousal'].with, /highest 2/);
});
