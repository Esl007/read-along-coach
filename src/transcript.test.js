import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscript } from './transcript.js';

const w = (text, word_is_final, start = 0, end = 100, confidence = 0.9) => ({
  text, word_is_final, start, end, confidence,
});

// AssemblyAI v3 Turn.words is CUMULATIVE: each message re-sends every word
// currently in the turn (finalized + a revisable non-final tail), never just
// the new ones. The accumulator must REPLACE per turn_order, never append,
// and report `added` exactly once per genuine word (including a non-final
// word that later gets revised before finalizing).
test('cumulative turn handling: growing words array does not duplicate, revised tail word counts once', () => {
  const t = createTranscript();

  // Turn 0 grows word-by-word, cumulatively, exactly as AssemblyAI sends it.
  const r1 = t.applyTurn({ turn_order: 0, end_of_turn: false, words: [w('the', true)] });
  assert.deepEqual(r1.added.map((x) => x.text), ['the']);

  const r2 = t.applyTurn({ turn_order: 0, end_of_turn: false, words: [w('the', true), w('cat', true)] });
  assert.deepEqual(r2.added.map((x) => x.text), ['cat']);

  const r3 = t.applyTurn({
    turn_order: 0, end_of_turn: false,
    words: [w('the', true), w('cat', true), w('sat', true)],
  });
  assert.deepEqual(r3.added.map((x) => x.text), ['sat']);

  // A non-final tail word ("moo") appears, then gets revised to "move" and
  // finalized in a later message within the SAME turn. The non-final
  // fragment should be reported once as "added" (feeding patience as
  // effort), and the finalized revision should be reported once more (so
  // scoring picks it up) — but the transcript's final word list must end up
  // with exactly ONE word at that slot, not two.
  const r4 = t.applyTurn({
    turn_order: 0, end_of_turn: false,
    words: [w('the', true), w('cat', true), w('sat', true), w('moo', false)],
  });
  assert.deepEqual(r4.added.map((x) => x.text), ['moo']);

  const r5 = t.applyTurn({
    turn_order: 0, end_of_turn: true,
    words: [w('the', true), w('cat', true), w('sat', true), w('move', true)],
  });
  assert.deepEqual(r5.added.map((x) => x.text), ['move']);

  // Second turn, independent bookkeeping.
  const r6 = t.applyTurn({ turn_order: 1, end_of_turn: false, words: [w('quick', true)] });
  assert.deepEqual(r6.added.map((x) => x.text), ['quick']);

  // Overall transcript: no duplication anywhere, exactly the distinct words.
  const all = t.words().map((x) => x.text);
  assert.deepEqual(all, ['the', 'cat', 'sat', 'move', 'quick']);

  // finalWords() only returns finalized words — the revised "move", not a
  // stray "moo", and not the not-yet-final tail of any in-progress turn.
  const finals = t.finalWords().map((x) => x.text);
  assert.deepEqual(finals, ['the', 'cat', 'sat', 'move', 'quick']);

  // Exactly one word at that slot, never two ("moo" AND "move").
  assert.equal(t.words().filter((x) => x.text === 'moo' || x.text === 'move').length, 1);
});

test('applyTurn never appends across replacement — resending the same words array is a no-op for `added`', () => {
  const t = createTranscript();
  t.applyTurn({ turn_order: 0, end_of_turn: false, words: [w('hello', true), w('world', true)] });
  const r = t.applyTurn({ turn_order: 0, end_of_turn: false, words: [w('hello', true), w('world', true)] });
  assert.deepEqual(r.added, []);
  assert.equal(t.words().length, 2);
});
