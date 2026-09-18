import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscript } from './transcript.js';
import { alignPrefix, nextExpectedIndex } from './aligner.js';

// ── Synthetic AssemblyAI v3 stream harness ──────────────────────────────────
//
// Regression coverage for the "stuck at several places" complaint: the live
// highlight must advance as soon as a word is provisionally heard, not only
// once it finalizes (finalization lags real speech by hundreds of ms or
// more per AssemblyAI's documented behavior). This harness emits a realistic
// sequence of CUMULATIVE Turn messages — a growing non-final tail, words
// finalizing several messages after they first appeared, one word revised
// while still non-final ("moo" -> "move"), and more than one turn_order —
// exactly the shape the real streaming API produces.

const w = (text, word_is_final, start, end, confidence = 0.9) => ({
  text, word_is_final, start, end, confidence,
});

/**
 * Feed a sequence of cumulative Turn messages into a fresh transcript,
 * recording the RENDER view (transcript.words() — finals + provisional
 * tail) and the SCORE view (transcript.finalWords()) after every message.
 */
function runStream(turns) {
  const t = createTranscript();
  const snapshots = [];
  for (const turn of turns) {
    t.applyTurn(turn);
    snapshots.push({
      render: t.words().map((x) => x.text),
      score: t.finalWords().map((x) => x.text),
    });
  }
  return { transcript: t, snapshots };
}

const reference = ['the', 'cat', 'sat', 'in', 'the', 'sun'];

// Turn 0 messages: "the" finalizes immediately, "cat" appears provisionally
// (non-final) two messages before it finalizes, "sat" arrives provisional
// then gets REVISED (a garbled first guess "sad" -> corrected "sat") before
// finalizing, and "in"/"the"/"sun" arrive similarly staggered. turn_order
// then advances to a second turn for "sun." finalization pattern coverage.
const turns = [
  { turn_order: 0, end_of_turn: false, words: [w('the', true, 0, 100)] },
  { turn_order: 0, end_of_turn: false, words: [w('the', true, 0, 100), w('cat', false, 120, 260, 0.4)] },
  { turn_order: 0, end_of_turn: false, words: [w('the', true, 0, 100), w('cat', true, 120, 260)] },
  {
    turn_order: 0, end_of_turn: false,
    words: [w('the', true, 0, 100), w('cat', true, 120, 260), w('sad', false, 300, 430, 0.35)],
  },
  {
    // revision: "sad" (non-final) becomes "sat" (still non-final) before finalizing
    turn_order: 0, end_of_turn: false,
    words: [w('the', true, 0, 100), w('cat', true, 120, 260), w('sat', false, 300, 430, 0.5)],
  },
  {
    turn_order: 0, end_of_turn: false,
    words: [w('the', true, 0, 100), w('cat', true, 120, 260), w('sat', true, 300, 430)],
  },
  {
    turn_order: 0, end_of_turn: true,
    words: [
      w('the', true, 0, 100), w('cat', true, 120, 260), w('sat', true, 300, 430),
      w('in', true, 450, 560),
    ],
  },
  // Second turn_order: independent bookkeeping, "the sun" provisional then final.
  { turn_order: 1, end_of_turn: false, words: [w('the', false, 600, 700, 0.4)] },
  { turn_order: 1, end_of_turn: false, words: [w('the', true, 600, 700), w('sun', false, 720, 860, 0.45)] },
  { turn_order: 1, end_of_turn: true, words: [w('the', true, 600, 700), w('sun', true, 720, 860)] },
];

test('RENDER view: highlight boundary reflects a word as soon as it appears provisionally, without waiting for it to finalize', () => {
  const { snapshots } = runStream(turns);

  // After message index 1, "cat" has appeared provisionally (non-final) but
  // has NOT finalized. The OLD render-from-final-only behavior would only
  // have ['the'] in the render list here, so nextExpectedIndex would still
  // be 1 (expecting "cat") — this is exactly the "stuck" symptom: the reader
  // has already said "cat" but the highlight hasn't moved on. The fix must
  // include the provisional word in the render list so the boundary advances
  // to 2 (expecting "sat") immediately, not after finalization catches up.
  const afterProvisionalCat = snapshots[1];
  assert.deepEqual(afterProvisionalCat.render, ['the', 'cat']);
  const opsRender = alignPrefix(reference, [
    { text: 'the', confidence: 0.9 },
    { text: 'cat', confidence: 0.4 },
  ]);
  assert.equal(nextExpectedIndex(opsRender), 2, 'render boundary must advance on a provisional word, not stall at the last finalized one');

  // Same story for the revised-then-finalized "sat": after message index 4
  // (the "sad" -> "sat" revision, still non-final), the render view should
  // already show 'sat' (the latest guess), not the stale earlier guess "sad"
  // and not nothing.
  const afterRevision = snapshots[4];
  assert.deepEqual(afterRevision.render, ['the', 'cat', 'sat']);

  // And the render view must never show a word twice for the same slot
  // across the sad->sat revision.
  assert.equal(afterRevision.render.filter((x) => x === 'sad').length, 0);
});

test('SCORE view: counts only finalized words, and a revised provisional word never double-counts', () => {
  const { snapshots } = runStream(turns);

  // While "cat" is still provisional (message index 1), it must NOT appear
  // in the score view at all.
  assert.deepEqual(snapshots[1].score, ['the']);

  // Once "cat" finalizes (message index 2), it enters the score view exactly once.
  assert.deepEqual(snapshots[2].score, ['the', 'cat']);

  // The "sad" -> "sat" revision: at no point does 'sad' ever appear in the
  // score view (it was never final), and once 'sat' finalizes it appears
  // exactly once, never twice (no double-count from the revision).
  for (const s of snapshots) assert.ok(!s.score.includes('sad'));
  const finalSnapshot = snapshots[snapshots.length - 1];
  assert.equal(finalSnapshot.score.filter((x) => x === 'sat').length, 1);

  // Full session: score view ends up with exactly the finalized words, in
  // order, across both turn_orders, with no duplicates anywhere.
  assert.deepEqual(finalSnapshot.score, ['the', 'cat', 'sat', 'in', 'the', 'sun']);
});

test('RENDER view converges to the same final word list as the SCORE view once everything finalizes', () => {
  const { snapshots } = runStream(turns);
  const last = snapshots[snapshots.length - 1];
  assert.deepEqual(last.render, last.score);
});
