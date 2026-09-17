import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFast } from './replay.js';
import { align, nextExpectedIndex } from './aligner.js';
import { createPatience, State } from './patience.js';
import { PASSAGES, words } from './passages.js';
import { SESSIONS } from './sessions/index.js';

// Mirror of the browser pipeline: words + ticks → patience → help on stall.
function runSession(session) {
  const ref = words(PASSAGES.find((p) => p.id === session.passageId));
  const heard = [];
  const patience = createPatience();
  const helps = [];
  runFast(session.events, {
    onWord(word, now) {
      if (word.final !== false) heard.push(word);
      patience.onWord(word, now);
    },
    onTick(now) {
      if (patience.tick(now) === State.STALLED) {
        const idx = nextExpectedIndex(align(ref, heard));
        if (idx < ref.length) { helps.push({ idx, word: ref[idx], now }); patience.helped(now); }
      }
    },
  });
  return { ref, ops: align(ref, heard), helps };
}

const byId = (id) => SESSIONS.find((s) => s.id === id);

test('halting early reader stalls at least once and gets help', () => {
  const { helps } = runSession(byId('halting-early-reader'));
  assert.ok(helps.length >= 1, 'expected at least one STALLED help event');
});

test('halting early reader passes through WORKING before stalling', () => {
  const session = byId('halting-early-reader');
  const patience = createPatience();
  const states = new Set();
  runFast(session.events, {
    onWord: (w, now) => states.add(patience.onWord(w, now)),
    onTick: (now) => states.add(patience.tick(now)),
  });
  assert.ok(states.has(State.WORKING), 'expected WORKING (sounding-out) state');
  assert.ok(states.has(State.STALLED), 'expected STALLED state');
});

test('halting early reader verdicts: skipped, substituted, unscorable', () => {
  const { ops } = runSession(byId('halting-early-reader'));
  const verdicts = new Set(ops.map((o) => o.verdict));
  assert.ok(verdicts.has('skipped'), 'expected a skipped word ("big")');
  assert.ok(verdicts.has('substituted'), 'expected a substitution ("run" for "ran")');
  assert.ok(verdicts.has('unscorable'), 'low-confidence "moo" must be unscorable, not wrong');
});

test('fluent adult read: 100% accuracy, zero helps', () => {
  const { ops, helps } = runSession(byId('fluent-adult'));
  const scoreable = ops.filter((o) => o.verdict !== 'unscorable' && o.op !== 'ins');
  const correct = ops.filter((o) => o.verdict === 'correct').length;
  assert.equal(helps.length, 0);
  assert.equal(correct, scoreable.length);
  assert.ok(scoreable.length > 0);
});

test('esl careful read: low-confidence miss is unscorable, never wrong', () => {
  const { ops } = runSession(byId('esl-careful'));
  assert.ok(ops.some((o) => o.verdict === 'unscorable'));
  assert.ok(!ops.some((o) => o.verdict === 'skipped' || o.verdict === 'substituted'));
});
