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
