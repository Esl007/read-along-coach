import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFast, createReplay } from './replay.js';
import { align, alignPrefix, nextExpectedIndex } from './aligner.js';
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
        // Mirror app.js: STALLED help must be computed against the PREFIX
        // alignment of the partial transcript-so-far, not the global
        // alignment — global align() smears a short partial heard[] toward
        // the end of the reference (defect 1), which here manifests as
        // nextExpectedIndex landing near/at ref.length and the `idx <
        // ref.length` guard failing, so no help ever fires.
        const idx = nextExpectedIndex(alignPrefix(ref, heard));
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

// ── Real-time termination (createReplay) ────────────────────────────────────
// runFast uses a simulated clock and can't catch bugs that only show up when
// real timers (setInterval/setTimeout) are involved — e.g. a browser
// coalescing/throttling a "250ms" interval down to ~1/sec (observed directly
// against this app: a requested tickMs of 250 was delivered at ~1000ms
// intervals under a headless/automated Chromium). These tests drive
// createReplay with real timers against a scaled-down copy of each bundled
// script (all start/end/tailMs divided by SCALE) so the whole real-time run
// only takes a second or two instead of ~20-30s. patience's own timing
// constants (baseStallMs etc.) are scaled by the same factor so the stall
// window stays proportionally identical to the real, unscaled session —
// scaling the script alone without scaling patience would artificially
// shrink the stall window relative to the tick cadence and invalidate the
// test.

const SCALE = 10;

function scaleScript(events) {
  return events.map((e) => ({ ...e, start: e.start / SCALE, end: e.end / SCALE }));
}

function scaledPatience() {
  return createPatience({
    baseStallMs: 3000 / SCALE,
    workingBonusMs: 4000 / SCALE,
  });
}

// Drives createReplay to completion and returns everything an assertion might
// want: whether onEnd fired, how many real ms it took, and — replaying the
// same pipeline as app.js — the resulting ops/helps, so a scheduler bug that
// starves onWord/onTick (e.g. the "wall of skipped words" regression) shows
// up here even if onEnd still eventually fires.
function runRealTime(session, { tickMs = 250 / SCALE, throttleFactor = 1 } = {}) {
  const ref = words(PASSAGES.find((p) => p.id === session.passageId));
  const heard = [];
  const patience = scaledPatience();
  const helps = [];

  // Simulate a browser delivering a "tickMs" setInterval more slowly than
  // requested (throttled backgrounded tab / busy main thread / automated
  // driver) by wrapping the global setInterval that createReplay uses, exactly
  // like the ~4x slowdown (250ms requested -> ~1000ms delivered) measured
  // live in this app's own preview browser.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => realSetInterval(fn, ms * throttleFactor);

  return new Promise((resolve, reject) => {
    const timeoutGuard = setTimeout(
      () => reject(new Error('createReplay never called onEnd within the bound')),
      10000
    );
    const replay = createReplay(scaleScript(session.events), {
      tickMs,
      tailMs: 1000 / SCALE,
      onWord(word, now) {
        if (word.final !== false) heard.push(word);
        patience.onWord(word, now);
      },
      onTick(now) {
        if (patience.tick(now) === State.STALLED) {
          // Same fix as runSession() above: use prefix alignment for the
          // live/in-progress STALLED check.
          const idx = nextExpectedIndex(alignPrefix(ref, heard));
          if (idx < ref.length) { helps.push({ idx, word: ref[idx], now }); patience.helped(now); }
        }
      },
      onEnd() {
        globalThis.setInterval = realSetInterval;
        clearTimeout(timeoutGuard);
        resolve({ ref, ops: align(ref, heard), helps, heardCount: heard.length });
      },
    });
    replay.start();
  }).finally(() => { globalThis.setInterval = realSetInterval; });
}

for (const session of SESSIONS) {
  test(`createReplay real-time run terminates and calls onEnd: ${session.id}`, async () => {
    const result = await runRealTime(session);
    // Every event that was scheduled must actually have been delivered —
    // this is what catches a scheduler that silently drops/starves word
    // events (the "huge run of skipped words" symptom) even if onEnd fires.
    const expectedFinals = session.events.filter((e) => e.final !== false).length;
    assert.equal(result.heardCount, expectedFinals, 'every final word event must reach onWord');
  });
}

test('createReplay stays correct when the tick interval is throttled 4x slower than requested', async () => {
  // Regression test for the real hang/skip bug: browsers do not guarantee a
  // "250ms" setInterval actually fires every 250ms. Confirm the
  // halting-reader script still, even under a throttled tick: (a) terminates
  // via onEnd within a bound, (b) delivers every word event (no starved
  // onWord calls => no false "skipped" wall), and (c) still detects its one
  // scripted stall and fires a coach-help event, because word delivery,
  // session end, and tick-adjacent patience checks no longer depend solely on
  // the interval's actual cadence.
  const session = SESSIONS.find((s) => s.id === 'halting-early-reader');
  const result = await runRealTime(session, { throttleFactor: 4 });
  const expectedFinals = session.events.filter((e) => e.final !== false).length;
  assert.equal(result.heardCount, expectedFinals, 'every final word event must reach onWord');
  assert.ok(result.helps.length >= 1, 'the scripted stall must still be detected under a throttled tick');
});
