import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPatience, State } from './patience.js';

test('clean words keep state listening', () => {
  const p = createPatience();
  p.onWord({ text: 'cat', confidence: 0.9, end: 1000 });
  assert.equal(p.tick(2000), State.LISTENING);
});

test('silence past threshold becomes stalled', () => {
  const p = createPatience({ baseStallMs: 3000 });
  p.onWord({ text: 'cat', confidence: 0.9, end: 1000 });
  assert.equal(p.tick(4500), State.STALLED);
});

test('sounding-out extends patience beyond base stall', () => {
  const p = createPatience({ baseStallMs: 3000, workingBonusMs: 4000 });
  p.onWord({ text: 'the', confidence: 0.9, end: 1000 });
  p.onWord({ text: 'ca', confidence: 0.3, end: 3500 }); // effort fragment
  assert.equal(p.tick(4500), State.WORKING);            // would've stalled at 4000
  assert.equal(p.tick(8000), State.STALLED);            // eventually stalls
});

test('helped() resets the clock', () => {
  const p = createPatience({ baseStallMs: 3000 });
  p.onWord({ text: 'cat', confidence: 0.9, end: 1000 });
  p.tick(5000);
  p.helped(5000);
  assert.equal(p.tick(6000), State.LISTENING);
});
