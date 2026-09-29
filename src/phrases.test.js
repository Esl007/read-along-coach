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
  PHRASE_STALL_MS,
  PHRASE_MAX_WORDS,
  phrasesForSession,
  passageTokens,
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

test('a gap >= PHRASE_STALL_MS splits the phrase, and is flagged as a stall', () => {
  const session = mk('s', [
    ['the', 0, 300],
    ['cat', 300 + PHRASE_STALL_MS, 300 + PHRASE_STALL_MS + 300],
  ]);
  const phrases = phrasesForSession(session);
  assert.equal(phrases.length, 2);
  assert.deepEqual(phrases.map((p) => p.text), ['the', 'cat']);
  // The flag is what tells src/narration.js to PRESERVE this silence instead of
  // collapsing it to the natural inter-phrase beat.
  assert.deepEqual(phrases.map((p) => p.stallBefore), [false, true]);
});

// This is the regression the whole boundary rewrite is about. The old rule split
// on any gap >= 600ms, which is an ordinary in-sentence interval in these demo
// scripts, so it chopped mid-clause and the player then reproduced the authored
// silence between the pieces — audible dead air where the language has none.
test('an ordinary in-sentence gap (600-1199ms) does NOT split', () => {
  for (const gap of [600, 700, 900, PHRASE_STALL_MS - 1]) {
    const session = mk('s', [
      ['the', 0, 300],
      ['cat', 300 + gap, 300 + gap + 300],
    ]);
    const phrases = phrasesForSession(session);
    assert.equal(phrases.length, 1, `gap ${gap}ms should not split`);
    assert.equal(phrases[0].text, 'the cat');
    assert.deepEqual(phrases[0].indices, [0, 1]);
    assert.equal(phrases[0].stallBefore, false);
    // The phrase spans from the first word's start to the last word's end.
    assert.equal(phrases[0].start, 0);
    assert.equal(phrases[0].end, 300 + gap + 300);
  }
});

// ── Clause boundaries ───────────────────────────────────────────────────────
// The recorded events carry no punctuation (a recogniser does not emit any), so
// the boundary comes from the passage the session is reading.

test('passageTokens marks clause ends and the words that open a clause', () => {
  const toks = passageTokens('The cat sat. A dog ran, slowly.');
  assert.deepEqual(toks.map((t) => t.norm), ['the', 'cat', 'sat', 'a', 'dog', 'ran', 'slowly']);
  assert.deepEqual(toks.map((t) => t.endsClause), [false, false, true, false, false, true, true]);
  assert.deepEqual(toks.map((t) => t.startsClause), [false, false, false, true, false, false, true]);
});

test('a sentence boundary in the passage splits the phrase even with a tiny gap', () => {
  const session = mk('s', [
    ['the', 0, 300],
    ['cat', 350, 650],
    ['sat', 700, 1000],
    ['a', 1050, 1350],
    ['dog', 1400, 1700],
    ['ran', 1750, 2050],
  ]);
  const phrases = phrasesForSession(session, { passageText: 'The cat sat. A dog ran.' });
  assert.deepEqual(phrases.map((p) => p.text), ['the cat sat', 'a dog ran']);
});

test('a comma in the passage splits the phrase', () => {
  const session = mk('s', [
    ['red', 0, 300],
    ['hens', 350, 650],
    ['eat', 700, 1000],
  ]);
  const phrases = phrasesForSession(session, { passageText: 'Red hens, eat.' });
  assert.deepEqual(phrases.map((p) => p.text), ['red hens', 'eat']);
});

// A substitution or a garble means the word that CARRIED the period never
// matched, so the boundary is only visible from the word after it. Without the
// startsClause half of the rule, a garbled sentence-final word glues two
// sentences into one clip.
test('a garbled clause-final word still yields a boundary, seen from the next word', () => {
  const session = mk('s', [
    ['the', 0, 300],
    ['cat', 350, 650],
    ['moo', 700, 1000],          // garbled "move."
    ['the', 1050, 1350],
    ['cat', 1400, 1700],
  ]);
  const phrases = phrasesForSession(session, { passageText: 'The cat move. The cat.' });
  assert.deepEqual(phrases.map((p) => p.text), ['the cat moo', 'the cat']);
});

test('a skipped word does not desynchronise the punctuation lookup', () => {
  const session = mk('s', [
    ['a', 0, 300],
    ['dog', 350, 650],           // "big" skipped
    ['ran', 700, 1000],
    ['the', 1050, 1350],
  ]);
  const phrases = phrasesForSession(session, { passageText: 'A big dog ran. The end.' });
  assert.deepEqual(phrases.map((p) => p.text), ['a dog ran', 'the']);
});

test('a fragment does not consume a passage word', () => {
  // If "ca" advanced the cursor, the real "cat" would match "sat" and the
  // period after "sat." would be attributed to the wrong event.
  const session = mk('s', [
    ['the', 0, 300],
    ['ca', 350, 450, false],
    ['cat', 500, 800],
    ['sat', 850, 1150],
    ['a', 1200, 1500],
  ]);
  const phrases = phrasesForSession(session, { passageText: 'The cat sat. A dog.' });
  assert.deepEqual(phrases.map((p) => p.text), ['the', 'ca', 'cat sat', 'a']);
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
});

// The cap used to fire wherever the running count happened to land, which left
// orphaned one-word tails: "Her light guided each one safely past the" then
// "rocks." — a whole clip for one function-word-led scrap. An over-long clause
// is now divided into near-equal chunks instead.
test('the cap splits an over-long clause into near-equal chunks, never a 1-word tail', () => {
  const n = PHRASE_MAX_WORDS + 1;            // worst case for the old rule
  const phrases = phrasesForSession(mk('s', run(n, { gap: 100 })));
  assert.equal(phrases.length, 2);
  const sizes = phrases.map((p) => p.indices.length).sort((a, b) => a - b);
  assert.ok(sizes[0] >= Math.floor(n / 2), `chunks are lopsided: ${sizes}`);
  assert.equal(sizes[0] + sizes[1], n);
});

test('a cap-induced seam inside a clause is never flagged as a stall', () => {
  const phrases = phrasesForSession(mk('s', run(PHRASE_MAX_WORDS * 2, { gap: 100 })));
  assert.ok(phrases.length > 1);
  assert.deepEqual(phrases.map((p) => p.stallBefore), phrases.map(() => false));
});

test('ids are stable across calls and unique within a session', () => {
  const session = mk('s', run(20, { gap: 100 }));
  const a = phrasesForSession(session).map((p) => p.id);
  const b = phrasesForSession(session).map((p) => p.id);
  assert.deepEqual(a, b, 'grouping the same session twice must give the same ids');
  assert.equal(new Set(a).size, a.length, 'ids must be unique');
  // Derived from session id + index of the phrase's first event.
  assert.equal(a[0], 's-0');
  assert.equal(a[1], `s-${phrasesForSession(session)[0].indices.length}`);
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

// The stall is the moment the patience machine exists to demonstrate, and the
// coach's intervention is timed off it. If the grouping stops flagging it, the
// player has no way to know that silence must survive playback.
test('the halting reader\'s 4.4s stall is flagged, and every session keeps its stalls', () => {
  const halting = SESSIONS.find((s) => s.id === 'halting-early-reader');
  const phrases = phrasesForSession(halting);
  const stall = phrases.find((p) => p.indices[0] === 7);   // "the" at 11500ms
  assert.ok(stall, 'the phrase after the long silence should start at event 7');
  assert.equal(stall.stallBefore, true);

  // And the flag never fires without a real authored silence behind it.
  for (const session of SESSIONS) {
    for (const p of phrasesForSession(session)) {
      if (!p.stallBefore) continue;
      const first = p.indices[0];
      assert.ok(first > 0, 'the first phrase cannot have a stall before it');
      const gap = session.events[first].start - session.events[first - 1].end;
      assert.ok(
        gap >= PHRASE_STALL_MS,
        `${p.id} claims a stall but the authored gap is only ${gap}ms`
      );
    }
  }
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
