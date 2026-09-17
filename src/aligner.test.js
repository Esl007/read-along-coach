import { test } from 'node:test';
import assert from 'node:assert/strict';
import { align, wcpm, struggleWords } from './aligner.js';

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
