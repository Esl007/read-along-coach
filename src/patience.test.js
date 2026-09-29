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

// ── Hardening ───────────────────────────────────────────────────────────────

test('stalled stays stalled across repeated ticks until the coach helps', () => {
  const p = createPatience({ baseStallMs: 3000 });
  p.onWord({ text: 'cat', confidence: 0.9, end: 1000 });
  assert.equal(p.tick(4500), State.STALLED);
  assert.equal(p.tick(4750), State.STALLED, 'the coach must not lose the stall between ticks');
  assert.equal(p.state, State.STALLED);
  p.helped(5000);
  assert.equal(p.state, State.LISTENING);
});

test('a reader who only sounds out, never producing a clean word, still eventually gets help', () => {
  // Previously the machine bailed out of tick() whenever no confident word had
  // arrived yet, so a reader stuck mumbling at the very first word got
  // infinite patience and zero coaching.
  const p = createPatience({ baseStallMs: 3000, workingBonusMs: 4000 });
  assert.equal(p.onWord({ text: 'lll', confidence: 0.2, end: 1000 }), State.WORKING);
  assert.equal(p.tick(3000), State.WORKING, 'still sounding out — the coach waits');
  assert.equal(p.tick(5500), State.STALLED, 'effort ran out; the coach may now help');
});

test('total opening silence gets one nudge instead of waiting forever', () => {
  // Nothing has been heard at all: a frozen reader, or a microphone that never
  // worked. Measured from the first clock reading, with the most patient
  // window the machine has.
  const p = createPatience({ baseStallMs: 3000, workingBonusMs: 4000 });
  assert.equal(p.tick(0), State.LISTENING);
  assert.equal(p.tick(5000), State.LISTENING, 'well inside the opening grace');
  assert.equal(p.tick(6999), State.LISTENING, 'still inside baseStall + workingBonus');
  assert.equal(p.tick(7500), State.STALLED);
});

test('opening grace is configurable and does not fire once speech has started', () => {
  const p = createPatience({ baseStallMs: 3000, openingGraceMs: 1000 });
  assert.equal(p.tick(0), State.LISTENING);
  p.onWord({ text: 'the', confidence: 0.9, end: 400 });
  // Now that a real word exists, baseStallMs governs — the 1000ms opening
  // grace must not leak in and stall the reader at 1100.
  assert.equal(p.tick(1100), State.LISTENING);
  assert.equal(p.tick(3500), State.STALLED);
});

test('a revised word re-delivered with an older timestamp never rewinds the patience clock', () => {
  // AssemblyAI revises its non-final tail in place, so the same slot can
  // arrive again carrying an earlier timestamp. Regressing lastWordAt there
  // would manufacture a stall out of time that has already elapsed.
  const p = createPatience({ baseStallMs: 3000 });
  p.onWord({ text: 'sun', confidence: 0.9, end: 5000 }, 5000);
  p.onWord({ text: 'sad', confidence: 0.9, end: 4200 }, 4200); // stale revision
  assert.equal(p.tick(6000), State.LISTENING, 'clock must still be anchored at 5000');
  assert.equal(p.tick(8500), State.STALLED);
});

test('sounding-out after a stall re-earns patience rather than repeating the prompt', () => {
  const p = createPatience({ baseStallMs: 3000, workingBonusMs: 4000 });
  p.onWord({ text: 'the', confidence: 0.9, end: 1000 });
  assert.equal(p.tick(4500), State.STALLED);
  p.helped(4500);
  // The reader takes the hint and starts sounding the word out.
  assert.equal(p.onWord({ text: 'wa', confidence: 0.3, end: 5200 }), State.WORKING);
  assert.equal(p.tick(7000), State.WORKING, 'effort must buy the reader more time');
  assert.equal(p.tick(9500), State.STALLED);
});

test('onWord tolerates a word with no usable timestamp and a missing confidence', () => {
  const p = createPatience({ baseStallMs: 3000 });
  assert.equal(p.onWord({ text: 'cat' }, 1000), State.LISTENING, 'missing confidence reads as confident');
  assert.equal(p.tick(2000), State.LISTENING);
  assert.equal(p.tick(4500), State.STALLED);
  // No timestamp anywhere at all must not poison the clock with NaN.
  const q = createPatience({ baseStallMs: 3000 });
  q.onWord({ text: 'cat', confidence: 0.9 });
  assert.equal(q.tick(4500), State.STALLED);
});

test('tick with a non-finite clock is ignored rather than corrupting the state', () => {
  const p = createPatience({ baseStallMs: 3000 });
  p.onWord({ text: 'cat', confidence: 0.9, end: 1000 });
  assert.equal(p.tick(NaN), State.LISTENING);
  assert.equal(p.tick(undefined), State.LISTENING);
  assert.equal(p.tick(4500), State.STALLED);
});
