// Tests for src/narration.js — the single narration clock.
//
// WHAT THESE ARE PROTECTING
//
// The defect being fixed was two clocks: the word highlight ran on the demo
// script's authored times while the audio ran on the clips' real durations, and
// the difference accumulated. The fix makes the audio the master clock and
// derives the highlight from it. The regression risk is therefore concentrated
// in two places, and that is where these tests are:
//
//   1. The TIMELINE. It must be monotonic, it must not leave dead air between
//      phrases, and it must preserve the one silence that carries meaning (the
//      halting reader's stall, which the coach's intervention is timed off).
//   2. The DRIVER. Every word event must fire exactly once and in order — each
//      one lands in the scored transcript, so a double-fire silently corrupts
//      WCPM and accuracy — including across a pause/resume cycle, and including
//      when a clip is missing or never plays.
//
// NO AUDIO DEVICE IS REQUIRED. The driver takes `now` and `play` as arguments;
// the harness below supplies a simulated wall clock and a fake media element
// whose currentTime advances with it. That is also the only honest way to test
// this: real playback timing is not reproducible.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  buildNarrationTimeline,
  createNarrationDriver,
  distributeWords,
  estimateClipMs,
  INTER_PHRASE_PAUSE_MS,
  MAX_STALL_MS,
  NARRATION_TAIL_MS,
  SEGMENT_WATCHDOG_MS,
} from './narration.js';

import { phrasesForSession, PHRASE_STALL_MS } from './phrases.js';
import { SESSIONS } from './sessions/index.js';

// The REAL manifest: real measured clip durations and the real per-word offsets
// the build validated. Testing the timeline against invented durations would
// test nothing — the durations are the input the old design got wrong.
const MANIFEST = JSON.parse(
  readFileSync(new URL('../voices/phrases/manifest.json', import.meta.url), 'utf8')
);

/** Clip resolver over the real manifest, optionally pretending some are absent. */
const clipFor = (absent = new Set()) => (id) => {
  if (absent.has(id)) return null;
  const e = MANIFEST[id];
  if (!e || !(e.seconds > 0)) return null;
  return { src: `/voices/phrases/${e.file}`, ms: e.seconds * 1000, words: e.words };
};

const timelineFor = (session, opts = {}) =>
  buildNarrationTimeline(session, { clip: clipFor(opts.absent), wordClip: opts.wordClip || (() => null) });

/**
 * Run a timeline on a simulated clock with fake media elements.
 *
 * `unplayable` names sources whose play() returns null — a clip that fails to
 * load or is blocked. `frozen` names sources whose element accepts play() but
 * whose currentTime never moves, which is what an undecodable file looks like.
 */
function harness(session, timeline, { unplayable = new Set(), frozen = new Set(), stepMs = 16 } = {}) {
  const durationBySrc = new Map(timeline.segments.map((s) => [s.src, s.durMs]));
  let wall = 0;
  let live = null;
  const played = [];
  const words = [];
  const ticks = [];

  const play = (src) => {
    played.push(src);
    if (unplayable.has(src)) return null;
    const h = { pos: 0, done: false, paused: false, moves: !frozen.has(src) };
    live = h;
    return {
      positionMs: () => h.pos,
      ended: () => h.done,
      failed: () => false,
      pause: () => { h.paused = true; },
      resume: () => { h.paused = false; },
      stop: () => { if (live === h) live = null; },
    };
  };

  const driver = createNarrationDriver({
    timeline,
    events: session.events,
    play,
    now: () => wall,
    onWord: (w, t) => words.push({ text: w.text, t }),
    onTick: (t) => ticks.push(t),
    onEnd: (t) => ticks.push(t),
    tickMs: 50,
  });

  /** Advance simulated time by `ms`, ticking the driver like a rAF loop would. */
  const advance = (ms) => {
    for (let spent = 0; spent < ms; spent += stepMs) {
      wall += stepMs;
      if (live && !live.paused && live.moves) {
        live.pos += stepMs;
        // A real element fires 'ended' when it reaches the end of the media.
        const dur = durationBySrc.get(played[played.length - 1]);
        if (dur !== undefined && live.pos >= dur) live.done = true;
      }
      driver.tick();
    }
  };

  /** Run to completion, with a hard step cap so a hang fails rather than hangs. */
  const runToEnd = (limitMs = timeline.totalMs + 60000) => {
    let spent = 0;
    while (!driver.finished && spent < limitMs) { advance(stepMs); spent += stepMs; }
    return driver.finished;
  };

  return { driver, advance, runToEnd, played, words, ticks, wallNow: () => wall };
}

// ── The timeline ────────────────────────────────────────────────────────────

test('the timeline is monotonically non-decreasing for all 5 sessions', () => {
  assert.equal(SESSIONS.length, 5);
  for (const session of SESSIONS) {
    const { wordTimes } = timelineFor(session);
    assert.equal(wordTimes.length, session.events.length);
    for (let i = 1; i < wordTimes.length; i++) {
      assert.ok(
        wordTimes[i] >= wordTimes[i - 1],
        `${session.id}: word ${i} at ${wordTimes[i]}ms is before word ${i - 1} at ${wordTimes[i - 1]}ms`
      );
    }
  }
});

test('buildNarrationTimeline throws rather than returning a non-monotonic timeline', () => {
  // A deliberately corrupt per-word timing, to prove the assertion is live and
  // not just a comment. distributeWords rejects non-monotonic timings, so the
  // way in is a clip that claims to be negative length... instead, feed a
  // phrase override that reorders the indices.
  const session = SESSIONS[0];
  const phrases = phrasesForSession(session);
  const swapped = [phrases[1], phrases[0], ...phrases.slice(2)];
  assert.throws(
    () => buildNarrationTimeline(session, { phrases: swapped, clip: clipFor() }),
    /not monotonic/
  );
});

// The dead-air half of the user's complaint. The old player put the AUTHORED gap
// between clips, so wherever a clip was shorter than the authored interval the
// remainder was audible silence. Ordinary phrase joins now get the natural beat.
test('no dead air: an ordinary phrase join is exactly INTER_PHRASE_PAUSE_MS', () => {
  let checked = 0;
  for (const session of SESSIONS) {
    const phrases = phrasesForSession(session);
    const { segments } = timelineFor(session);
    // One segment per phrase here: every phrase in the corpus has a clip.
    assert.equal(segments.length, phrases.length, `${session.id}: expected one segment per phrase`);

    for (let i = 1; i < segments.length; i++) {
      const gap = segments[i].at - (segments[i - 1].at + segments[i - 1].durMs);
      if (phrases[i].stallBefore) continue;
      assert.equal(
        gap, INTER_PHRASE_PAUSE_MS,
        `${session.id}: join before ${phrases[i].id} is ${gap}ms, not the natural beat`
      );
      checked++;
    }
  }
  assert.ok(checked > 20, `only ${checked} ordinary joins checked`);
});

// The other half: the silence that DOES mean something has to survive. The coach
// intervention in the halting-early-reader demo is timed off this stall; collapse
// it and the patience machine never reaches STALLED and the demo shows nothing.
test('a genuine stall IS preserved — the halting reader\'s 4.4s silence survives', () => {
  const session = SESSIONS.find((s) => s.id === 'halting-early-reader');
  const phrases = phrasesForSession(session);
  const { segments, wordTimes } = timelineFor(session);

  const k = phrases.findIndex((p) => p.indices[0] === 7);   // "the" at authored 11500ms
  assert.ok(k > 0);
  assert.equal(phrases[k].stallBefore, true);

  const authored = session.events[7].start - session.events[6].end;   // 4400ms
  assert.equal(authored, 4400);
  const gap = segments[k].at - (segments[k - 1].at + segments[k - 1].durMs);
  assert.equal(gap, authored, 'the authored stall must be reproduced as-is');
  assert.ok(gap <= MAX_STALL_MS);

  // And it is a real silence on the word clock too: patience.tick() sees more
  // than its 3000ms baseStallMs of nothing, which is what makes it STALL.
  const silence = wordTimes[7] - wordTimes[6];
  assert.ok(silence > 3000, `only ${silence}ms of silence reaches the patience machine`);
});

test('every preserved stall is capped at MAX_STALL_MS', () => {
  const session = {
    id: 'runaway',
    events: [
      { text: 'the', start: 0, end: 300, final: true },
      { text: 'cat', start: 600000, end: 600300, final: true },
    ],
  };
  const phrases = phrasesForSession(session, { passageText: '' });
  assert.equal(phrases[1].stallBefore, true);
  const { segments } = buildNarrationTimeline(session, {
    phrases,
    clip: () => ({ src: 'x.wav', ms: 500 }),
  });
  assert.equal(segments[1].at - (segments[0].at + segments[0].durMs), MAX_STALL_MS);
});

test('distributeWords uses real timings when they are one-per-word, else weights by length', () => {
  const texts = ['the', 'cat', 'sat'];
  const good = distributeWords(texts, 1000, [0, 300, 600]);
  assert.equal(good.source, 'timings');
  assert.deepEqual(good.offsets, [0, 300, 600]);

  // The failure mode src/phrases.js warns about: espeak-ng merged "the cat" into
  // ONE span, so there are fewer timings than words. Must fall back, not stretch.
  const merged = distributeWords(texts, 1000, [0, 600]);
  assert.equal(merged.source, 'weighted');
  assert.equal(merged.offsets[0], 0);
  for (let i = 1; i < merged.offsets.length; i++) {
    assert.ok(merged.offsets[i] > merged.offsets[i - 1]);
    assert.ok(merged.offsets[i] < 1000);
  }

  // Non-monotonic timings are rejected too.
  assert.equal(distributeWords(texts, 1000, [0, 600, 300]).source, 'weighted');
  // A timing past the end of the clip is clamped, never allowed to overrun.
  assert.deepEqual(distributeWords(texts, 1000, [0, 300, 5000]).offsets, [0, 300, 1000]);
});

test('the shipped manifest gives real per-word timings for every phrase', () => {
  // If this ever regresses to the char-weighted fallback the highlight gets
  // looser inside a phrase. That is survivable, but it must not happen quietly.
  let timed = 0, weighted = 0;
  for (const session of SESSIONS) {
    const { stats } = timelineFor(session);
    timed += stats.timedPhrases;
    weighted += stats.weightedPhrases;
    assert.equal(stats.wordFallbacks, 0, `${session.id} has a phrase with no clip`);
  }
  assert.equal(weighted, 0, `${weighted} phrase(s) fell back to character weighting`);
  assert.ok(timed >= 39, `only ${timed} phrases carry real per-word timings`);
});

test('estimateClipMs is in the right ballpark for the real corpus', () => {
  // Only used for phrases with no rendered clip, but a wild estimate there would
  // make the fallback's highlight visibly wrong, so keep it honest.
  const errs = Object.values(MANIFEST).map((m) => estimateClipMs(m.text) / (m.seconds * 1000));
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  assert.ok(mean > 0.75 && mean < 1.35, `estimate is off by a factor of ${mean.toFixed(2)} on average`);
});

// ── The driver ──────────────────────────────────────────────────────────────

test('every word event fires exactly once, in order, across a full run of all 5 sessions', () => {
  for (const session of SESSIONS) {
    const timeline = timelineFor(session);
    const h = harness(session, timeline);
    h.driver.start();
    assert.ok(h.runToEnd(), `${session.id}: driver never finished`);

    assert.equal(h.words.length, session.events.length, `${session.id}: wrong number of word events`);
    assert.deepEqual(
      h.words.map((w) => w.text),
      session.events.map((e) => e.text),
      `${session.id}: word events out of order or duplicated`
    );
    // And the clock they were fired on never went backwards.
    for (let i = 1; i < h.words.length; i++) {
      assert.ok(h.words[i].t >= h.words[i - 1].t, `${session.id}: clock went backwards at word ${i}`);
    }
    // Every clip was played, once, in timeline order.
    assert.deepEqual(h.played, timeline.segments.map((s) => s.src));
  }
});

test('the same holds across a pause/resume cycle, and the clock freezes while paused', () => {
  for (const session of SESSIONS) {
    const timeline = timelineFor(session);
    const h = harness(session, timeline);
    h.driver.start();

    // Pause a third of the way in, sit there a long time, then resume.
    h.advance(Math.floor(timeline.totalMs / 3));
    const wordsBefore = h.words.length;
    assert.ok(wordsBefore > 0, `${session.id}: nothing fired before the pause`);

    h.driver.pause();
    const clockAtPause = h.driver.clockMs;
    h.advance(5000);            // wall time passes; the narration clock must not
    assert.equal(h.driver.clockMs, clockAtPause, `${session.id}: clock ran on while paused`);
    assert.equal(h.words.length, wordsBefore, `${session.id}: a word fired while paused`);

    h.driver.resume();
    assert.ok(h.runToEnd(), `${session.id}: driver never finished after resume`);

    assert.deepEqual(
      h.words.map((w) => w.text),
      session.events.map((e) => e.text),
      `${session.id}: pause/resume lost, duplicated or reordered a word`
    );
  }
});

test('repeated pause() / resume() calls are no-ops, and pause survives many cycles', () => {
  const session = SESSIONS.find((s) => s.id === 'halting-early-reader');
  const timeline = timelineFor(session);
  const h = harness(session, timeline);
  h.driver.start();

  for (let i = 0; i < 6; i++) {
    h.advance(1200);
    h.driver.pause(); h.driver.pause();
    h.advance(400);
    h.driver.resume(); h.driver.resume();
  }
  assert.ok(h.runToEnd());
  assert.deepEqual(h.words.map((w) => w.text), session.events.map((e) => e.text));
});

test('onTick is called with the same clock the word events are fired on', () => {
  const session = SESSIONS.find((s) => s.id === 'halting-early-reader');
  const timeline = timelineFor(session);
  const h = harness(session, timeline);
  h.driver.start();
  h.runToEnd();

  // Monotonic, and it reaches the end of the timeline — that is what the
  // auto-finish silence check and the progress readout are measuring against.
  for (let i = 1; i < h.ticks.length; i++) assert.ok(h.ticks[i] >= h.ticks[i - 1]);
  assert.equal(h.ticks[h.ticks.length - 1], timeline.totalMs);
  // Each word's fire time is a value onTick also saw at or after that moment.
  for (const w of h.words) {
    assert.ok(h.ticks.some((t) => t === w.t), `no tick carried the clock value ${w.t}`);
  }
});

// ── Failure must degrade to silence, never to a hang ────────────────────────

test('a phrase with NO clip still advances the clock and still fires its words', () => {
  const session = SESSIONS.find((s) => s.id === 'halting-early-reader');
  const absent = new Set(['halting-early-reader-2', 'halting-early-reader-25']);
  const timeline = timelineFor(session, { absent });   // and no word clips either

  assert.equal(timeline.stats.wordFallbacks, 2);
  assert.ok(timeline.stats.silentSegments > 0, 'expected segments with no audio at all');
  // The silent segments still occupy time, so the highlight keeps a sane pace.
  for (const seg of timeline.segments) assert.ok(seg.durMs > 0);

  const h = harness(session, timeline);
  h.driver.start();
  assert.ok(h.runToEnd(), 'a missing clip must not hang the demo');
  assert.deepEqual(h.words.map((w) => w.text), session.events.map((e) => e.text));
  assert.equal(h.driver.clockMs, timeline.totalMs);
});

test('a clip whose play() fails still advances the clock', () => {
  const session = SESSIONS.find((s) => s.id === 'esl-careful');
  const timeline = timelineFor(session);
  const unplayable = new Set([timeline.segments[2].src, timeline.segments[4].src]);

  const h = harness(session, timeline, { unplayable });
  h.driver.start();
  assert.ok(h.runToEnd(), 'a clip that will not play must not hang the demo');
  assert.deepEqual(h.words.map((w) => w.text), session.events.map((e) => e.text));
});

test('a clip that loads but never advances is abandoned by the watchdog', () => {
  const session = SESSIONS.find((s) => s.id === 'esl-careful');
  const timeline = timelineFor(session);
  const frozen = new Set([timeline.segments[1].src]);

  const h = harness(session, timeline, { frozen });
  h.driver.start();
  assert.ok(h.runToEnd(), 'a frozen element must not hang the demo');
  assert.deepEqual(h.words.map((w) => w.text), session.events.map((e) => e.text));
  // It cost the segment's own length plus the watchdog slack, and no more.
  assert.ok(h.wallNow() < timeline.totalMs + SEGMENT_WATCHDOG_MS + 2000);
});

test('onEnd fires exactly once, at totalMs, after the tail', () => {
  const session = SESSIONS.find((s) => s.id === 'fluent-adult');
  const timeline = timelineFor(session);
  let ends = 0;
  let endT = null;
  const durationBySrc = new Map(timeline.segments.map((s) => [s.src, s.durMs]));
  let wall = 0, live = null, lastSrc = null;
  const driver = createNarrationDriver({
    timeline,
    events: session.events,
    play: (src) => {
      lastSrc = src;
      const h = { pos: 0, done: false };
      live = h;
      return {
        positionMs: () => h.pos, ended: () => h.done, failed: () => false,
        pause() {}, resume() {}, stop() { if (live === h) live = null; },
      };
    },
    now: () => wall,
    onWord: () => {},
    onEnd: (t) => { ends++; endT = t; },
  });
  driver.start();
  for (let i = 0; i < 20000 && !driver.finished; i++) {
    wall += 16;
    if (live) { live.pos += 16; if (live.pos >= durationBySrc.get(lastSrc)) live.done = true; }
    driver.tick();
  }
  assert.equal(ends, 1);
  assert.equal(endT, timeline.totalMs);
  // Extra ticks after the end must not fire it again.
  for (let i = 0; i < 20; i++) { wall += 16; driver.tick(); }
  assert.equal(ends, 1);
});

test('the last word is comfortably inside the timeline, with the tail after it', () => {
  for (const session of SESSIONS) {
    const { wordTimes, totalMs, segments } = timelineFor(session);
    const last = wordTimes[wordTimes.length - 1];
    const audioEnd = segments[segments.length - 1].at + segments[segments.length - 1].durMs;
    assert.ok(last <= audioEnd, `${session.id}: last word is after the last clip ends`);
    assert.equal(totalMs, audioEnd + NARRATION_TAIL_MS);
  }
});

test('an empty session produces an empty timeline and finishes', () => {
  const session = { id: 'empty', events: [] };
  const timeline = buildNarrationTimeline(session, { clip: () => null });
  assert.deepEqual(timeline.segments, []);
  assert.deepEqual(timeline.wordTimes, []);
  assert.equal(timeline.totalMs, NARRATION_TAIL_MS);

  const h = harness(session, timeline);
  h.driver.start();
  assert.ok(h.runToEnd());
  assert.equal(h.words.length, 0);
});

// ── The drift the fix removes, measured ─────────────────────────────────────

test('the new timeline removes the cumulative authored-vs-real drift', () => {
  // The old scheduler advanced a cursor by each clip's real duration while the
  // highlight kept the authored time, so the two diverged without bound. Here
  // the clip layout and the word times ARE the same numbers, so the divergence
  // cannot exist: the last word's audio position is, by construction, inside
  // the last clip.
  for (const session of SESSIONS) {
    const phrases = phrasesForSession(session);
    const { wordTimes, segments } = timelineFor(session);
    for (let i = 0; i < phrases.length; i++) {
      for (const evIdx of phrases[i].indices) {
        assert.ok(
          wordTimes[evIdx] >= segments[i].at &&
          wordTimes[evIdx] <= segments[i].at + segments[i].durMs,
          `${session.id}: word ${evIdx} is highlighted outside the clip that speaks it`
        );
      }
    }
  }
});

test('PHRASE_STALL_MS is the one threshold that decides a preserved pause', () => {
  // Guards against the thresholds drifting apart: phrases.js decides where to
  // cut, narration.js decides which cuts keep their silence, and they must agree
  // on what a stall is.
  const mk = (gapMs) => ({
    id: 'g',
    events: [
      { text: 'the', start: 0, end: 300, final: true },
      { text: 'cat', start: 300 + gapMs, end: 600 + gapMs, final: true },
    ],
  });
  const layout = (gapMs) => {
    const session = mk(gapMs);
    const phrases = phrasesForSession(session, { passageText: '' });
    const { segments } = buildNarrationTimeline(session, {
      phrases, clip: () => ({ src: 'x.wav', ms: 400 }),
    });
    if (segments.length < 2) return null;
    return segments[1].at - (segments[0].at + segments[0].durMs);
  };
  assert.equal(layout(PHRASE_STALL_MS - 1), null, 'sub-stall gap should not even split');
  assert.equal(layout(PHRASE_STALL_MS), PHRASE_STALL_MS);
});
