// Integrity tests for the passage ladder. These are cheap but they guard the
// two things that silently break the app: an id changing (saved history rows
// and recorded demo sessions dereference passages by id, and a stale id shows
// up as a blank title or a demo that refuses to start), and the exported order
// drifting out of level order (app.js feeds PASSAGES straight into the <select>
// by index, so the ladder the user sees IS the array order).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PASSAGES, words } from './passages.js';
import { SESSIONS } from './sessions/index.js';

test('every passage has a unique id, a numeric level, and non-empty text', () => {
  assert.ok(PASSAGES.length >= 10, `expected a real ladder, got ${PASSAGES.length} passages`);
  const seen = new Set();
  for (const p of PASSAGES) {
    assert.equal(typeof p.id, 'string');
    assert.match(p.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `id "${p.id}" is not kebab-case`);
    assert.ok(!seen.has(p.id), `duplicate passage id "${p.id}"`);
    seen.add(p.id);

    assert.equal(typeof p.level, 'number', `level of "${p.id}" is not a number`);
    assert.ok(Number.isInteger(p.level) && p.level > 0, `level of "${p.id}" is not a positive integer`);

    assert.equal(typeof p.title, 'string');
    assert.ok(p.title.trim().length > 0, `"${p.id}" has an empty title`);
    assert.equal(typeof p.text, 'string');
    assert.ok(p.text.trim().length > 0, `"${p.id}" has empty text`);
    assert.ok(words(p).length > 0, `"${p.id}" yields no words`);
  }
});

test('PASSAGES is exported in ascending level order, so the UI select renders the ladder in order', () => {
  const levels = PASSAGES.map((p) => p.level);
  for (let i = 1; i < levels.length; i++) {
    assert.ok(levels[i] >= levels[i - 1],
      `level order breaks at index ${i}: ${levels[i - 1]} then ${levels[i]}`);
  }
  // Sorting is therefore a no-op — the exported order already IS level order.
  assert.deepEqual(PASSAGES.slice().sort((a, b) => a.level - b.level).map((p) => p.id),
    PASSAGES.map((p) => p.id));
});

test('the ladder spans grade 1 through 8', () => {
  const levels = new Set(PASSAGES.map((p) => p.level));
  for (let g = 1; g <= 8; g++) assert.ok(levels.has(g), `no passage at level ${g}`);
});

test('ids the rest of the app hard-codes still exist', () => {
  // Referenced by saved localStorage history and/or the demo scripts. Never
  // rename these.
  for (const id of ['cat-1', 'caterpillar-2', 'lighthouse-4', 'esl-news-adult']) {
    assert.ok(PASSAGES.some((p) => p.id === id), `stable passage id "${id}" disappeared`);
  }
});

// Target for new passages is 25-60 words. The floor is 20 rather than 25 only
// because `esl-news-adult` predates the ladder at 23 words and its text is
// frozen (recorded demo events and saved history are keyed to it).
test('passages stay demo-length so a read finishes inside a demo', () => {
  for (const p of PASSAGES) {
    const n = words(p).length;
    assert.ok(n >= 20 && n <= 60, `"${p.id}" is ${n} words — outside demo range`);
    if (p.id !== 'esl-news-adult') {
      assert.ok(n >= 25, `"${p.id}" is ${n} words — new passages should be 25-60`);
    }
  }
});

test('every demo session targets a real passage and only emits well-formed word events', () => {
  assert.ok(SESSIONS.length >= 5, `expected at least 5 demo sessions, got ${SESSIONS.length}`);
  const ids = new Set();
  for (const s of SESSIONS) {
    assert.ok(!ids.has(s.id), `duplicate session id "${s.id}"`);
    ids.add(s.id);
    assert.ok(s.title && s.title.trim().length > 0, `session "${s.id}" has no title`);
    assert.ok(PASSAGES.some((p) => p.id === s.passageId),
      `session "${s.id}" references unknown passage "${s.passageId}"`);
    assert.ok(s.events.length > 0, `session "${s.id}" has no events`);
    let prevEnd = -1;
    for (const e of s.events) {
      assert.equal(typeof e.text, 'string', `session "${s.id}" event has no text`);
      assert.ok(e.confidence >= 0 && e.confidence <= 1,
        `session "${s.id}" word "${e.text}" has confidence ${e.confidence}`);
      assert.ok(e.end > e.start, `session "${s.id}" word "${e.text}" ends before it starts`);
      // Replay assumes monotonic event times (it schedules one timeout per
      // event off `end`); out-of-order events would replay out of order.
      assert.ok(e.end >= prevEnd, `session "${s.id}" word "${e.text}" goes back in time`);
      prevEnd = e.end;
    }
  }
});
