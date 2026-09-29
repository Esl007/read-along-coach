// Tests for src/phrases.js — the grouping contract shared by
// scripts/build-phrases.mjs (which renders one clip per phrase) and the player.
//
// The unit tests below pin the three grouping rules stated in phrases.js.
// The last test is the one that actually protects the demo: whatever the
// grouping does, the words that come out must be the words that went in, in
// the same order. A regression there is silent — the audio would still play,
// it would just say something the highlight never says.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PHRASE_GAP_MS,
  PHRASE_MAX_WORDS,
  phrasesForSession,
  allPhrases,
} from './phrases.js';

import { SESSIONS } from './sessions/index.js';

/** Build a synthetic session from [text, start, end, final?] tuples. */
const mk = (id, rows) => ({
  id,
  events: rows.map(([text, start, end, final = true]) => ({ text, start, end, final })),
});

/** A run of `n` words, `gap` ms apart, each `dur` ms long. */
const run = (n, { gap = 100, dur = 300, from = 0 } = {}) => {
  const rows = [];
  let t = from;
  for (let i = 0; i < n; i++) {
    rows.push([`w${i}`, t, t + dur]);
    t = t + dur + gap;
  }
  return rows;
};

test('a gap >= PHRASE_GAP_MS splits the phrase', () => {
  const session = mk('s', [
    ['the', 0, 300],
    ['cat', 300 + PHRASE_GAP_MS, 300 + PHRASE_GAP_MS + 300],
  ]);
  const phrases = phrasesForSession(session);
  assert.equal(phrases.length, 2);
  assert.deepEqual(phrases.map((p) => p.text), ['the', 'cat']);
});

test('a gap just under PHRASE_GAP_MS joins into one phrase', () => {
  const gap = PHRASE_GAP_MS - 1;
  const session = mk('s', [
    ['the', 0, 300],
    ['cat', 300 + gap, 300 + gap + 300],
  ]);
  const phrases = phrasesForSession(session);
  assert.equal(phrases.length, 1);
  assert.equal(phrases[0].text, 'the cat');
  assert.deepEqual(phrases[0].indices, [0, 1]);
  // The phrase spans from the first word's start to the last word's end.
  assert.equal(phrases[0].start, 0);
  assert.equal(phrases[0].end, 300 + gap + 300);
});

test('a non-final fragment is alone, and absorbs neither neighbour', () => {
  // All gaps here are small enough to join, so any absorption would show up.
  const session = mk('s', [
    ['the', 0, 300],
    ['ca', 400, 500, false], // fragment
    ['cat', 600, 900],
  ]);
  const phrases = phrasesForSession(session);
  assert.deepEqual(phrases.map((p) => p.text), ['the', 'ca', 'cat']);
  assert.deepEqual(phrases.map((p) => p.fragment), [false, true, false]);
  assert.deepEqual(phrases.map((p) => p.indices), [[0], [1], [2]]);
});

test('two adjacent fragments stay separate clips', () => {
  const session = mk('s', [
    ['ca', 0, 200, false],
    ['caa', 300, 500, false],
  ]);
  assert.deepEqual(phrasesForSession(session).map((p) => p.text), ['ca', 'caa']);
});

test('PHRASE_MAX_WORDS caps a run with no qualifying gaps', () => {
  const n = PHRASE_MAX_WORDS * 2 + 3;
  const phrases = phrasesForSession(mk('s', run(n, { gap: 100 })));

  for (const p of phrases) {
    assert.ok(
      p.indices.length <= PHRASE_MAX_WORDS,
      `phrase ${p.id} has ${p.indices.length} words, cap is ${PHRASE_MAX_WORDS}`
    );
  }
  assert.equal(phrases.length, Math.ceil(n / PHRASE_MAX_WORDS));
  assert.equal(phrases[0].indices.length, PHRASE_MAX_WORDS);
  assert.equal(phrases.at(-1).indices.length, n % PHRASE_MAX_WORDS);
});

test('ids are stable across calls and unique within a session', () => {
  const session = mk('s', run(20, { gap: 100 }));
  const a = phrasesForSession(session).map((p) => p.id);
  const b = phrasesForSession(session).map((p) => p.id);
  assert.deepEqual(a, b, 'grouping the same session twice must give the same ids');
  assert.equal(new Set(a).size, a.length, 'ids must be unique');
  // Derived from session id + index of the phrase's first event.
  assert.equal(a[0], 's-0');
  assert.equal(a[1], `s-${PHRASE_MAX_WORDS}`);
});

test('ids are unique across every real session', () => {
  const ids = SESSIONS.flatMap((s) => phrasesForSession(s).map((p) => p.id));
  assert.equal(new Set(ids).size, ids.length);
});

test('ids are filesystem-safe (they are used as clip basenames)', () => {
  for (const p of allPhrases(SESSIONS)) {
    assert.match(p.id, /^[A-Za-z0-9_-]+$/, `id ${p.id} is not safe as a filename`);
  }
});

test('allPhrases dedupes by id across sessions', () => {
  const rows = run(3, { gap: 100 });
  const dup = [mk('same', rows), mk('same', rows), mk('other', rows)];
  const all = allPhrases(dup);

  const ids = all.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids survive');
  assert.deepEqual(ids.sort(), ['other-0', 'same-0']);
  // The surviving entry is tagged with the session it came from.
  assert.equal(all.find((p) => p.id === 'same-0').sessionId, 'same');
});

test('allPhrases returns every phrase of every real session', () => {
  const expected = SESSIONS.reduce((n, s) => n + phrasesForSession(s).length, 0);
  assert.equal(allPhrases(SESSIONS).length, expected);
});

test('grouping an empty session yields no phrases', () => {
  assert.deepEqual(phrasesForSession({ id: 'empty', events: [] }), []);
});

// ── The invariant that actually matters ──────────────────────────────────────
// Grouping is a partition of the event stream, nothing more. If it ever loses,
// duplicates or reorders a word, the narration stops matching the passage the
// learner is looking at — and that is not something a duration check catches.
test('for every session, phrase text concatenation === event text concatenation', () => {
  for (const session of SESSIONS) {
    const phrases = phrasesForSession(session);

    const fromEvents = session.events.map((e) => e.text).join(' ');
    const fromPhrases = phrases.map((p) => p.text).join(' ');
    assert.equal(
      fromPhrases,
      fromEvents,
      `session ${session.id}: grouped text does not match event text`
    );

    // Same thing at index level: the indices must be 0..n-1 exactly once each,
    // in order. This catches a reorder that happens to be text-identical
    // (e.g. a repeated word like "the cat" / "the cat").
    const indices = phrases.flatMap((p) => p.indices);
    assert.deepEqual(
      indices,
      session.events.map((_, i) => i),
      `session ${session.id}: indices are not an in-order partition of the events`
    );

    // And each phrase's own text is its own events' text.
    for (const p of phrases) {
      assert.equal(
        p.text,
        p.indices.map((i) => session.events[i].text).join(' '),
        `phrase ${p.id}: text does not match its indices`
      );
    }
  }
});
