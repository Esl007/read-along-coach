import { test } from 'node:test';
import assert from 'node:assert/strict';
import { align, alignPrefix, wcpm, struggleWords, nextExpectedIndex } from './aligner.js';
import { PASSAGES, words } from './passages.js';

const w = (text, confidence = 0.95, start = 0, end = 100) => ({ text, confidence, start, end });

test('perfect read aligns as all correct', () => {
  const ref = ['the', 'cat', 'sat'];
  const ops = align(ref, [w('the'), w('cat'), w('sat')]);
  assert.deepEqual(ops.map((o) => o.verdict), ['correct', 'correct', 'correct']);
});

test('skipped word is a deletion', () => {
  const ops = align(['the', 'big', 'cat'], [w('the'), w('cat')]);
  assert.equal(ops.filter((o) => o.verdict === 'skipped').length, 1);
});

test('low-confidence mismatch is unscorable, never wrong', () => {
  const ops = align(['caterpillar'], [w('battle pillar', 0.3)]);
  assert.equal(ops[0].verdict, 'unscorable');
});

test('wcpm counts only correct words', () => {
  const ops = align(['a', 'b', 'c'], [w('a'), w('x'), w('c')]);
  assert.equal(wcpm(ops, 60000), 2);
});

test('long pause before a word marks it a struggle word', () => {
  const ref = ['the', 'caterpillar'];
  const heard = [w('the', 0.95, 0, 300), w('caterpillar', 0.95, 4000, 4600)];
  assert.ok(struggleWords(align(ref, heard), ref).includes('caterpillar'));
});

test('struggleWords normalizes punctuation and de-duplicates case-insensitively', () => {
  const ref = ['The', 'cat', 'was', 'warm.'];
  // "The" skipped, plus a substitution on "warm." heard as something else,
  // and a duplicate-looking skip elsewhere in the passage that normalizes
  // to the same key ("the") must collapse to one entry.
  const ops = [
    { op: 'del', refIndex: 0, verdict: 'skipped' },
    { op: 'sub', refIndex: 3, verdict: 'substituted', word: w('warn') },
  ];
  const result = struggleWords(ops, ref);
  assert.equal(result.length, 2);
  assert.ok(result.includes('the'), 'punctuation-free, lowercased "The" -> "the"');
  assert.ok(result.includes('warm'), 'trailing period stripped from "warm."');
});

// ── Defect 1: prefix alignment for live/partial transcripts ────────────────
// Reproduction from the spec: global align() on a short partial transcript
// of the 41-word lighthouse-4 passage smears the traceback to the end,
// landing nextExpectedIndex near/at 40 instead of the true count of words
// heard so far. alignPrefix() must not do this.

const lighthouse = words(PASSAGES.find((p) => p.id === 'lighthouse-4'));

test('lighthouse-4 has 41 words (sanity check for the repro)', () => {
  assert.equal(lighthouse.length, 41);
});

for (const k of [1, 2, 3, 5, 10]) {
  test(`alignPrefix: clean prefix read of first ${k} word(s) of lighthouse-4 gives nextExpectedIndex === ${k}`, () => {
    const heard = lighthouse.slice(0, k).map((t) => w(t));
    const ops = alignPrefix(lighthouse, heard);
    const idx = nextExpectedIndex(ops);
    assert.equal(idx, k, `expected nextExpectedIndex to equal ${k}, the count of words actually heard`);
    // No reference word at/after the boundary may be marked as reached.
    for (const o of ops) {
      if (o.refIndex !== undefined && o.refIndex >= k) {
        assert.notEqual(o.verdict, 'correct');
        assert.notEqual(o.verdict, 'substituted');
        assert.notEqual(o.verdict, 'skipped');
      }
    }
  });
}

test('alignPrefix: k=1 does not spuriously land on index 40 (the historical bug)', () => {
  const heard = [w(lighthouse[0])];
  const ops = alignPrefix(lighthouse, heard);
  assert.notEqual(nextExpectedIndex(ops), 40);
  assert.equal(nextExpectedIndex(ops), 1);
});

test('alignPrefix: unread tail is `pending`, not `skipped`, and excluded from wcpm/accuracy/struggleWords', () => {
  const k = 5;
  const heard = lighthouse.slice(0, k).map((t) => w(t));
  const ops = alignPrefix(lighthouse, heard);
  const tail = ops.filter((o) => o.refIndex !== undefined && o.refIndex >= k);
  assert.ok(tail.length > 0);
  assert.ok(tail.every((o) => o.verdict === 'pending'));
  assert.ok(!tail.some((o) => o.verdict === 'skipped'));

  // wcpm/accuracy denominators exclude pending words.
  const scoreable = ops.filter((o) => o.verdict !== 'unscorable' && o.verdict !== 'pending' && o.op !== 'ins');
  assert.equal(scoreable.length, k, 'only the words actually heard should be scoreable');

  // struggleWords never returns anything from the pending tail.
  const sw = struggleWords(ops, lighthouse);
  for (const word of sw) {
    const idx = lighthouse.findIndex((rw) => rw.toLowerCase().replace(/[^\w']/g, '') === word);
    if (idx !== -1) assert.ok(idx < k, `struggle word "${word}" must come from the read span, not the pending tail`);
  }
});

// ── Measurement-engine hardening ────────────────────────────────────────────
// Everything below covers the accuracy + performance work on the aligner:
// normalization, near-miss tolerance, disfluency repair, the alignPrefix
// boundary invariant, and the live-read time budget.

import {
  normalizeWord, similarity, phoneticKey, isNearMiss, classifyPair,
  areHomophones, resetAlignerCaches,
  COST_MATCH, COST_NEAR, COST_SUB, COST_GAP,
} from './aligner.js';

const verdicts = (ops) => ops.map((o) => o.verdict);
const refVerdict = (ops, i) => (ops.find((o) => o.refIndex === i) || {}).verdict;

// ── 4. Cost model sanity ────────────────────────────────────────────────────

test('cost model: MATCH < NEAR < SUB, and no substitution costs more than the del+ins it replaces', () => {
  assert.ok(COST_MATCH < COST_NEAR, 'an exact match must always beat a near-miss');
  assert.ok(COST_NEAR < COST_SUB, 'a near-miss must always beat an unrelated substitution');
  assert.ok(COST_SUB <= 2 * COST_GAP, 'a substitution must never cost more than del+ins');
  assert.ok(COST_NEAR < COST_GAP, 'a near-miss must never be shredded into a gap');
  // Integer-only cost model: traceback compares DP sums for exact equality,
  // so any fractional cost would make that comparison float-fragile.
  for (const c of [COST_MATCH, COST_NEAR, COST_SUB, COST_GAP]) {
    assert.ok(Number.isInteger(c), `cost ${c} must be an integer`);
  }
});

// ── 3. Normalization: contractions, hyphenation, numbers ────────────────────

test('normalizeWord: contractions match their apostrophe-free and expanded forms', () => {
  assert.equal(normalizeWord("don't"), normalizeWord('dont'));
  assert.equal(normalizeWord('don’t'), normalizeWord('dont'), 'curly apostrophe too');
  assert.equal(normalizeWord("Don't,"), normalizeWord('dont'), 'case + trailing punctuation');
  assert.equal(normalizeWord("can't"), normalizeWord('cannot'));
  assert.equal(normalizeWord("wouldn't"), normalizeWord('wouldnt'));
  // Ambiguous contractions are deliberately NOT expanded: "I'll" must not be
  // conflated with the real word "ill".
  assert.equal(normalizeWord("I'll"), 'ill');
  assert.equal(normalizeWord("we're"), 'were');
});

test('normalizeWord: hyphenation and stutters', () => {
  assert.equal(normalizeWord('well-known'), normalizeWord('wellknown'));
  assert.equal(normalizeWord('twenty-one'), normalizeWord('twentyone'));
  assert.equal(normalizeWord('c-c-cat'), 'cat', 'stutter collapses to the completed word');
  assert.equal(normalizeWord('c-ca-cat'), 'cat', 'sub-word build-up collapses too');
  assert.equal(normalizeWord('b-but'), 'but', 'single one-letter false start collapses');
  assert.equal(normalizeWord('re-read'), 'reread', 'a real prefix is NOT a stutter');
  assert.equal(normalizeWord('mother-in-law'), 'motherinlaw');
});

test('normalizeWord: digits, ordinals and written numbers converge', () => {
  assert.equal(normalizeWord('3'), normalizeWord('three'));
  assert.equal(normalizeWord('21'), normalizeWord('twenty-one'));
  assert.equal(normalizeWord('1,000'), normalizeWord('one-thousand'));
  assert.equal(normalizeWord('1st'), normalizeWord('first'));
  assert.equal(normalizeWord('21st'), normalizeWord('twenty-first'));
  assert.equal(normalizeWord('19'), 'nineteen');
});

test('normalizeWord: punctuation-only tokens normalize to empty and never compare equal', () => {
  assert.equal(normalizeWord('—'), '');
  assert.equal(normalizeWord('...'), '');
  // Two empties must not be scored as a match — that would hand out free
  // credit for a dash.
  const ops = align(['—'], [{ text: '...', confidence: 0.95, start: 0, end: 10 }]);
  assert.notEqual(ops[0].verdict, 'correct');
  assert.equal(classifyPair('', '').cost, COST_SUB);
});

test('numbers and contractions read aloud as separate words still score correct', () => {
  // "3" read as "three", "don't" read as the two ASR tokens "do" + "not".
  let ops = align(['I', 'have', '3', 'cats'], [w('i'), w('have'), w('three'), w('cats')]);
  assert.deepEqual(verdicts(ops), ['correct', 'correct', 'correct', 'correct']);

  ops = align(['I', "don't", 'know'], [w('i'), w('do'), w('not'), w('know')]);
  assert.deepEqual(verdicts(ops), ['correct', 'correct', 'correct']);
  assert.ok(!ops.some((o) => o.op === 'ins'), 'the split contraction is not an insertion');
});

test('a hyphenated compound spoken as two words is one correct word, not a substitution plus an insertion', () => {
  const ops = align(['a', 'well-known', 'fact'], [w('a'), w('well'), w('known'), w('fact')]);
  assert.deepEqual(verdicts(ops), ['correct', 'correct', 'correct']);
  assert.ok(!ops.some((o) => o.op === 'ins'));
});

// ── 1. Near-miss / phonetic tolerance ───────────────────────────────────────

test('similarity and phoneticKey behave as documented', () => {
  assert.ok(similarity('run', 'ran') > 0.6);
  assert.equal(similarity('cat', 'cat'), 1);
  assert.equal(similarity('cat', ''), 0);
  assert.ok(similarity('cat', 'dog') < 0.1);
  // Phonetic second opinion: letter-similarity alone would miss this pair.
  assert.ok(similarity('night', 'nite') < 0.6);
  assert.equal(phoneticKey('night'), phoneticKey('nite'));
  assert.notEqual(phoneticKey('cat'), phoneticKey('dog'));
});

test('near-misses are flagged, aligned in place, and still count as errors', () => {
  const ops = align(['the', 'kitty', 'sat'], [w('the'), w('kitten'), w('sat')]);
  // The near-miss stays PAIRED with its target instead of becoming a
  // deletion plus an insertion, which is what cascades into spurious skips.
  assert.deepEqual(ops.map((o) => o.op), ['match', 'sub', 'match']);
  assert.equal(ops[1].refIndex, 1);
  assert.ok(ops[1].near, 'near-miss must be flagged for gentler feedback');
  assert.ok(ops[1].similarity > 0.6);
  // ...but it is NOT credit. A reading assessment that flatters the reader is
  // worthless: WCPM counts `correct` only, and accuracy counts this in the
  // denominator, not the numerator.
  assert.equal(ops[1].verdict, 'substituted');
  assert.equal(wcpm(ops, 60000), 2, 'a near-miss must not inflate WCPM');
  assert.ok(struggleWords(ops, ['the', 'kitty', 'sat']).includes('kitty'),
    'a near-miss belongs on the practice list');
});

test('near-miss tolerance never upgrades a genuinely wrong word to correct', () => {
  for (const [target, said] of [['elephant', 'dog'], ['lighthouse', 'money'], ['cat', 'dog'], ['sun', 'hat']]) {
    assert.ok(!isNearMiss(target, said), `"${said}" for "${target}" must not read as a near-miss`);
    const ops = align(['the', target, 'here'], [w('the'), w(said), w('here')]);
    const v = refVerdict(ops, 1);
    assert.notEqual(v, 'correct', `"${said}" for "${target}" must never be correct`);
  }
  // And near-flagged pairs are never `correct` either — only exact matches
  // and known homophones are.
  const near = align(['run'], [w('ran')]);
  assert.equal(near[0].verdict, 'substituted');
  assert.ok(near[0].near);
});

test('near-miss alignment stops a single mispronunciation cascading into spurious skips', () => {
  // "lanterns" read as "lantern" mid-passage. With the near-miss cost the
  // word stays in its slot and everything after it is still correct; the
  // failure mode being guarded against is the whole tail sliding by one and
  // coming back as a wall of `skipped`.
  const ref = ['their', 'lanterns', 'swaying', 'like', 'fireflies'];
  const ops = align(ref, [w('their'), w('lantern'), w('swaying'), w('like'), w('fireflies')]);
  assert.deepEqual(verdicts(ops), ['correct', 'substituted', 'correct', 'correct', 'correct']);
  assert.equal(ops.filter((o) => o.verdict === 'skipped').length, 0);
  assert.ok(ops[1].near);
});

test('homophones are correct, not substitutions: the reader produced the right sound', () => {
  assert.ok(areHomophones('son', 'sun'));
  assert.ok(areHomophones('to', 'two'));
  assert.ok(!areHomophones('cat', 'cot'));
  // ASR wrote "son"/"two"; read aloud these are indistinguishable from
  // "sun"/"too", so penalizing them would punish a transcription choice the
  // reader could not influence.
  const ref = ['the', 'sun', 'was', 'too', 'warm'];
  const ops = align(ref, [w('the'), w('son'), w('was'), w('two'), w('warm')]);
  assert.deepEqual(verdicts(ops), ['correct', 'correct', 'correct', 'correct', 'correct']);
  assert.deepEqual(struggleWords(ops, ref), []);
});

// ── 2. Self-correction and repetition ───────────────────────────────────────

test('a repeated word ("the... the cat") is a disfluency, not an insertion or an error', () => {
  const ref = ['the', 'cat', 'sat'];
  const ops = align(ref, [w('the'), w('the'), w('cat'), w('sat')]);
  assert.deepEqual(verdicts(ops), ['correct', 'correct', 'correct']);
  assert.ok(!ops.some((o) => o.op === 'ins'), 'the repetition must not be charged as an insertion');
  assert.deepEqual(struggleWords(ops, ref), [], 'self-monitoring costs the reader nothing');
});

test('a sounded-out build-up ("ca", "cat") credits only the final successful attempt', () => {
  const ref = ['the', 'cat'];
  const ops = align(ref, [w('the'), w('ca'), w('cat')]);
  assert.deepEqual(verdicts(ops), ['correct', 'correct']);
  assert.ok(!ops.some((o) => o.op === 'ins'));
  // The attempt is still visible for reporting, just not scored.
  assert.equal(ops[1].attempts, 1);
});

test('a stutter arriving as one hyphenated token ("c-c-cat") scores as the word', () => {
  const ops = align(['the', 'cat'], [w('the'), w('c-c-cat')]);
  assert.deepEqual(verdicts(ops), ['correct', 'correct']);
});

test('an out-loud miscue the reader repairs himself ("wanted" → "warned") costs nothing', () => {
  const ref = ['my', 'cousin', 'warned', 'me'];
  const ops = align(ref, [w('my'), w('cousin'), w('wanted'), w('warned'), w('me')]);
  assert.deepEqual(verdicts(ops), ['correct', 'correct', 'correct', 'correct']);
  assert.ok(!ops.some((o) => o.verdict === 'inserted' || o.verdict === 'substituted'));
  assert.deepEqual(struggleWords(ops, ref), []);
});

test('a genuinely extra word is still an insertion — repetition repair is not a blanket amnesty', () => {
  const ops = align(['in', 'the', 'sun'], [w('in'), w('the'), w('very'), w('sun')]);
  assert.equal(ops.filter((o) => o.verdict === 'inserted').length, 1);
  assert.equal(ops.find((o) => o.verdict === 'inserted').word.text, 'very');
});

test('a legitimately repeated reference word is matched twice, not collapsed', () => {
  // "very very" in the passage really is two words; the repetition repair
  // must not eat the second one.
  const ref = ['it', 'was', 'very', 'very', 'warm'];
  const ops = align(ref, [w('it'), w('was'), w('very'), w('very'), w('warm')]);
  assert.deepEqual(verdicts(ops), ['correct', 'correct', 'correct', 'correct', 'correct']);
  assert.equal(ops.filter((o) => o.verdict === 'correct').length, 5);
});

test('repetition during a LIVE read keeps the highlight on the word not yet attempted', () => {
  // Reader says "the... the" — they have not reached "cat" yet, so the
  // highlight must stay on "cat" and "cat" must not be marked substituted.
  const ref = ['the', 'cat', 'sat', 'in'];
  const ops = alignPrefix(ref, [w('the'), w('the')]);
  assert.equal(nextExpectedIndex(ops), 1);
  assert.equal(refVerdict(ops, 1), 'pending');
});

// ── 4. alignPrefix boundary invariant ───────────────────────────────────────

test('alignPrefix: NOTHING at or beyond the boundary is ever anything but `pending`', () => {
  const ref = words(PASSAGES.find((p) => p.id === 'cat-1'));
  // A deliberately messy spread of partial reads: clean prefixes, prefixes
  // with a near-miss, with a repetition, with a skip, with pure noise, and
  // with words that also appear later in the passage (the classic source of
  // boundary drift, since "the"/"cat"/"was" all recur in cat-1).
  const partials = [
    [], ['the'], ['the', 'cat'], ['the', 'cat', 'sat'], ['the', 'cot', 'sat'],
    ['the', 'the', 'cat'], ['the', 'sat'], ['zebra'], ['the', 'zebra'],
    ['the', 'cat', 'sat', 'in', 'the', 'sun', 'the', 'sun'],
    ['warm'], ['care'], ['the', 'cat', 'was', 'warm'],
  ];
  for (const partial of partials) {
    const ops = alignPrefix(ref, partial.map((t) => w(t)));
    const B = nextExpectedIndex(ops);
    assert.ok(B >= 0 && B <= ref.length, `boundary ${B} out of range for [${partial}]`);
    for (const o of ops) {
      if (o.refIndex === undefined) continue;
      if (o.refIndex >= B) {
        assert.equal(o.verdict, 'pending',
          `ref[${o.refIndex}] beyond boundary ${B} got "${o.verdict}" for [${partial}]`);
        assert.equal(o.word, undefined, 'a pending word must carry no heard word');
      } else {
        assert.notEqual(o.verdict, 'pending',
          `ref[${o.refIndex}] inside boundary ${B} must be scored for [${partial}]`);
      }
    }
    // Every reference word appears exactly once, so the UI can never render a
    // word with two conflicting verdicts.
    const seen = ops.filter((o) => o.refIndex !== undefined).map((o) => o.refIndex).sort((a, b) => a - b);
    assert.deepEqual(seen, ref.map((_, i) => i), `ref coverage broke for [${partial}]`);
  }
});

test('alignPrefix: near-miss tolerance does not let the boundary run ahead of the reader', () => {
  const ref = words(PASSAGES.find((p) => p.id === 'lighthouse-4'));
  for (let k = 1; k <= 12; k++) {
    const heard = ref.slice(0, k).map((t) => w(t));
    assert.equal(nextExpectedIndex(alignPrefix(ref, heard)), k,
      `clean ${k}-word prefix must put the boundary at exactly ${k}`);
  }
});

// ── PERFORMANCE: live word-by-word arrival ──────────────────────────────────

/**
 * A reference of exactly `n` words of real passage prose. Drawn from the whole
 * bundled library rather than one passage so these budgets do not become
 * hostage to any single passage's length, and so the reference contains
 * genuine English (artificially repeating one passage would make the alignment
 * unrealistically ambiguous and flatter the timing).
 */
function prose(n) {
  const out = [];
  while (out.length < n) for (const p of PASSAGES) out.push(...words(p));
  out.length = n;
  return out;
}

test('a full live read (one alignPrefix per incoming word) is imperceptible', () => {
  // alignPrefix runs on EVERY incoming word, so a 60-word passage re-runs it
  // ~60 times. Simulate that exactly: the reference array identity is stable
  // (as in app.js) and `heard` grows by one word per call.
  const ref = prose(60);
  assert.equal(ref.length, 60);
  resetAlignerCaches();

  const heard = [];
  const t0 = performance.now();
  for (let i = 0; i < ref.length; i++) {
    heard.push(w(ref[i], 0.95, i * 400, i * 400 + 300));
    const ops = alignPrefix(ref, heard);
    assert.equal(nextExpectedIndex(ops), i + 1);
  }
  const elapsed = performance.now() - t0;
  // Generous vs. the real cost (single-digit ms) but far below the
  // O(R*H^2)-per-read behaviour a non-incremental implementation shows, and
  // far below anything a reader could perceive between spoken words.
  assert.ok(elapsed < 60, `live read of ${ref.length} words took ${elapsed.toFixed(1)}ms (budget 60ms)`);
});

test('live alignment stays linear per word: a 300-word passage read word-by-word still finishes fast', () => {
  // Regression guard on the DP column cache. Recomputing the whole matrix on
  // every incoming word is O(R*H^2) — ~13.5M cell evaluations here, each
  // possibly needing an edit distance — which takes seconds. Reusing the
  // columns for the unchanged heard prefix makes the whole read O(R*H).
  const ref = prose(300);
  resetAlignerCaches();

  const heard = [];
  const t0 = performance.now();
  for (let i = 0; i < ref.length; i++) {
    heard.push(w(ref[i], 0.95, i * 400, i * 400 + 300));
    alignPrefix(ref, heard);
  }
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 400, `300-word live read took ${elapsed.toFixed(1)}ms (budget 400ms)`);
});

test('a revised provisional tail invalidates only from the changed word, and gives the same answer as a cold run', () => {
  // AssemblyAI revises its non-final tail in place ("moo" -> "move"), so the
  // cache must not just append — it must re-derive from the first changed
  // word. Compare against a cold, cache-free run.
  const ref = words(PASSAGES.find((p) => p.id === 'cat-1'));
  const warm = [w('the'), w('cat'), w('sat'), w('in'), w('the'), w('sun'), w('the'), w('sad')];
  alignPrefix(ref, warm);                       // populate the cache
  const revised = warm.slice(0, 7).concat([w('sun')]);
  const fromCache = alignPrefix(ref, revised);

  resetAlignerCaches();
  const cold = alignPrefix(ref, revised);
  assert.deepEqual(verdicts(fromCache), verdicts(cold));
  assert.deepEqual(fromCache.map((o) => o.refIndex), cold.map((o) => o.refIndex));
  assert.equal(nextExpectedIndex(fromCache), nextExpectedIndex(cold));
});

test('interleaving align() and alignPrefix() over different passages never leaks cached state', () => {
  const a = words(PASSAGES.find((p) => p.id === 'cat-1'));
  const b = words(PASSAGES.find((p) => p.id === 'red-hen-1'));
  const cleanA = a.map((t) => w(t));
  const cleanB = b.map((t) => w(t));

  resetAlignerCaches();
  const expectA = verdicts(align(a, cleanA));
  resetAlignerCaches();
  const expectB = verdicts(alignPrefix(b, cleanB));

  resetAlignerCaches();
  for (let round = 0; round < 3; round++) {
    assert.deepEqual(verdicts(alignPrefix(a, cleanA.slice(0, 4))), ['correct', 'correct', 'correct', 'correct']
      .concat(a.slice(4).map(() => 'pending')));
    assert.deepEqual(verdicts(alignPrefix(b, cleanB)), expectB);
    assert.deepEqual(verdicts(align(a, cleanA)), expectA);
  }
});
