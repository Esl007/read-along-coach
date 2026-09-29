// Narration: ONE clock for the demo.
//
// ── THE DEFECT THIS REPLACES ────────────────────────────────────────────────
//
// The old player ran two independent clocks:
//
//     const at = Math.max(p.start, cursor);   // buildNarrationPlan(), app.js
//
// `p.start` is the demo script's hand-authored event time, and it drove the
// word highlight, the patience machine and the progress/auto-finish checks.
// `cursor` accumulated the REAL durations of the phrase clips. Nothing ever
// reconciled the two. So:
//
//   * a clip LONGER than its authored slot pushed `cursor` past `p.start`, and
//     because `cursor` is an accumulator that error was CUMULATIVE — the audio
//     slid further behind the highlight with every phrase ("the highlights are
//     way off");
//   * a clip SHORTER than the authored gap left the difference as silence
//     ("very unnatural pauses").
//
// Same root cause, opposite sign. You cannot tune your way out of it: any fixed
// estimate is wrong for some clip, and the error integrates.
//
// ── THE FIX: AUDIO IS THE MASTER CLOCK ─────────────────────────────────────
//
// This module does two things:
//
//   1. buildNarrationTimeline() lays the clips out end-to-end using their REAL
//      measured durations (from voices/phrases/manifest.json, which is built by
//      statting the files) and returns, for every word event index, the single
//      audio-clock time at which that word should be highlighted. There is no
//      second set of times anywhere; the authored event times are consulted
//      only to decide where a genuine stall has to be preserved.
//
//   2. createNarrationDriver() advances that clock from the media element's own
//      `currentTime` on requestAnimationFrame — the standard karaoke pattern —
//      and fires the word events and the shared onTick off it. Because the
//      highlight is DERIVED from the audio position rather than run alongside
//      it, drift is impossible by construction rather than by tuning.
//
// Each segment's start is pinned to its timeline value, and position inside a
// segment comes from the element. So a small disagreement between a clip's
// manifest duration and its real playback length is absorbed at the next
// segment boundary instead of accumulating.
//
// ── PAUSES ARE NOW A DELIBERATE DECISION, NOT A LEFTOVER ───────────────────
//
// Phrases play back-to-back separated by INTER_PHRASE_PAUSE_MS — the natural
// beat between spoken phrases — NOT by the authored gap. The single exception
// is a genuine stall (phrase.stallBefore, see src/phrases.js): that silence is
// the thing the patience machine exists to demonstrate and the coach's
// intervention is timed off it, so it is preserved, capped at MAX_STALL_MS so
// a mis-authored script can never wedge the demo.

import { phrasesForSession } from './phrases.js';

/** The natural beat between two spoken phrases. Replaces the authored gap. */
export const INTER_PHRASE_PAUSE_MS = 200;

/** A preserved stall is never allowed to exceed this. */
export const MAX_STALL_MS = 5000;

/** Quiet time after the last clip before the session is considered over. */
export const NARRATION_TAIL_MS = 600;

// Duration estimate for a clip we do not have measured audio for (a phrase with
// no rendered clip, falling back to single-word clips). Fitted to the rendered
// corpus: see the `estimateClipMs tracks real clip durations` test.
export const ESTIMATE_BASE_MS = 260;
export const ESTIMATE_PER_CHAR_MS = 72;

/** Generous fallback estimate, in ms, for `text` spoken aloud. */
export function estimateClipMs(text) {
  const n = String(text || '').length;
  return ESTIMATE_BASE_MS + ESTIMATE_PER_CHAR_MS * n;
}

/**
 * Where each word of a phrase falls inside its clip.
 *
 * Prefers true per-word timings when the manifest carries them. Kokoro's token
 * timestamps are phoneme-group aligned and espeak-ng merges function words
 * during phonemization, so "the cat" can come back as ONE span — which is why
 * the build validates the count per clip and only writes `words` when it got
 * exactly one span per word. Here we re-check the count and the ordering
 * before trusting it, and fall back rather than trusting it blindly.
 *
 * The fallback weights each word by its character count (+1 for the space it
 * is followed by), which is a decent proxy for spoken length. A ~100ms error
 * inside a 2s phrase is invisible; the cumulative multi-second drift is the
 * defect being fixed, and that is handled by the segment pinning above.
 *
 * @returns {{offsets: number[], source: 'timings'|'weighted'}}
 */
export function distributeWords(texts, durMs, timings) {
  const usable =
    Array.isArray(timings) &&
    timings.length === texts.length &&
    timings.every((t, i) => Number.isFinite(t) && t >= 0 && (i === 0 || t >= timings[i - 1]));

  if (usable) {
    // Clamp into the clip: a timing past the end would break monotonicity
    // against the next segment.
    return { offsets: timings.map((t) => Math.min(t, durMs)), source: 'timings' };
  }

  const weights = texts.map((t) => String(t).length + 1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const offsets = [];
  let acc = 0;
  for (const w of weights) {
    offsets.push((acc / total) * durMs);
    acc += w;
  }
  return { offsets, source: 'weighted' };
}

/**
 * Build the single narration timeline for a demo session.
 *
 * @param {object} session a demo session from src/sessions/
 * @param {object} [opts]
 * @param {(id: string) => ({src: string, ms: number, words?: number[]}|null)} [opts.clip]
 *   resolve a phrase id to a rendered clip. `ms` is its REAL measured duration;
 *   `words` (optional) is one offset in ms per word of the phrase.
 * @param {(text: string) => (string|null)} [opts.wordClip]
 *   resolve a single word to a single-word clip, for phrases with no clip.
 * @param {Array} [opts.phrases] override the grouping (tests).
 * @returns {{
 *   segments: Array<{at: number, durMs: number, src: (string|null), phraseId: string, indices: number[]}>,
 *   wordTimes: number[],
 *   totalMs: number,
 *   stats: {phraseClips: number, wordFallbacks: number, silentSegments: number, timedPhrases: number, weightedPhrases: number}
 * }}
 */
export function buildNarrationTimeline(session, opts = {}) {
  const events = session.events || [];
  const phrases = opts.phrases || phrasesForSession(session);
  const clip = opts.clip || (() => null);
  const wordClip = opts.wordClip || (() => null);

  const segments = [];
  const wordTimes = new Array(events.length).fill(0);
  const stats = {
    phraseClips: 0, wordFallbacks: 0, silentSegments: 0,
    timedPhrases: 0, weightedPhrases: 0,
  };

  let t = 0;
  let prevIndex = null;   // last event index placed, for the authored-gap check

  for (const p of phrases) {
    // ── The gap in front of this phrase ──────────────────────────────────
    // Default is the natural beat. A genuine stall is preserved, because the
    // coach's intervention is timed off it. Nothing else uses authored time.
    let gap = INTER_PHRASE_PAUSE_MS;
    if (p.stallBefore && prevIndex !== null) {
      const authored = events[p.indices[0]].start - events[prevIndex].end;
      gap = Math.min(Math.max(authored, INTER_PHRASE_PAUSE_MS), MAX_STALL_MS);
    }
    t += gap;

    const entry = clip(p.id);
    if (entry && entry.src && entry.ms > 0) {
      const durMs = entry.ms;
      const texts = p.indices.map((i) => events[i].text);
      const { offsets, source } = distributeWords(texts, durMs, entry.words);
      p.indices.forEach((evIdx, k) => { wordTimes[evIdx] = t + offsets[k]; });
      segments.push({ at: t, durMs, src: entry.src, phraseId: p.id, indices: p.indices.slice() });
      stats.phraseClips++;
      if (source === 'timings') stats.timedPhrases++; else stats.weightedPhrases++;
      t += durMs;
    } else {
      // No clip for this phrase: degrade to the single-word clips that already
      // exist. Worse prosody, but audible — and the clock still advances, word
      // by word, so the highlight stays on the audio even here.
      stats.wordFallbacks++;
      p.indices.forEach((evIdx, k) => {
        const ev = events[evIdx];
        const src = wordClip(ev.text);
        const durMs = estimateClipMs(ev.text);
        if (!src) stats.silentSegments++;
        wordTimes[evIdx] = t;
        segments.push({ at: t, durMs, src: src || null, phraseId: `${p.id}#${k}`, indices: [evIdx] });
        t += durMs;
      });
    }
    prevIndex = p.indices[p.indices.length - 1];
  }

  const totalMs = t + NARRATION_TAIL_MS;

  // ── Assert the invariant the whole design rests on. ───────────────────────
  for (let i = 1; i < wordTimes.length; i++) {
    if (wordTimes[i] < wordTimes[i - 1]) {
      throw new Error(
        `narration timeline for ${session.id} is not monotonic: ` +
        `word ${i - 1} at ${wordTimes[i - 1]}ms, word ${i} at ${wordTimes[i]}ms`
      );
    }
  }

  return { segments, wordTimes, totalMs, stats };
}

/**
 * How long a stuck segment is tolerated before the driver gives up on it.
 *
 * A clip that never loads, an autoplay block, a decode error — any of these
 * leave the element's currentTime at 0 forever. The demo must not hang on that,
 * so wall-clock time beyond the segment's own duration plus this slack ends the
 * segment regardless of what the element says. This is the only place wall
 * clock can override audio position, and it exists so that a missing clip
 * degrades to silence rather than to a dead demo.
 */
export const SEGMENT_WATCHDOG_MS = 1500;

/** Position past a segment's nominal end that still counts as "still playing". */
const SEGMENT_END_TOLERANCE_MS = 150;

/**
 * Drive a narration timeline off the audio clock.
 *
 * Everything external is injected, so the whole driver runs headless with no
 * audio device: tests pass a fake `now` and a fake `play`.
 *
 * @param {object} args
 * @param {ReturnType<typeof buildNarrationTimeline>} args.timeline
 * @param {Array} args.events the session's word events (indexed by wordTimes)
 * @param {(src: string) => (object|null)} args.play start a clip; return a handle
 *   {positionMs(), ended(), failed(), pause(), resume(), stop()} or null.
 * @param {() => number} [args.now] wall clock, ms
 * @param {(word: object, t: number) => void} args.onWord
 * @param {(t: number) => void} [args.onTick]
 * @param {(t: number) => void} [args.onEnd]
 * @param {number} [args.tickMs] minimum clock advance between onTick calls
 */
export function createNarrationDriver({
  timeline, events, play, now = () => performance.now(),
  onWord, onTick, onEnd, tickMs = 50,
}) {
  const { segments, wordTimes, totalMs } = timeline;

  let idx = 0;
  let phase = 'idle';        // idle | gap | play | tail | ended
  let base = 0;              // timeline ms at which the current wall-clock phase began
  let wallAccum = 0;         // wall ms spent in the current phase while running
  let wallMark = 0;          // now() at the last (re)start of the current phase
  let handle = null;
  let running = false;
  let started = false;
  let nextWord = 0;
  let lastTickAt = -Infinity;
  let endFired = false;

  const wallElapsed = () => wallAccum + (running ? Math.max(0, now() - wallMark) : 0);
  const resetWall = () => { wallAccum = 0; wallMark = now(); };

  /** The one clock. Monotonic non-decreasing by construction. */
  function clockMs() {
    if (phase === 'ended') return totalMs;
    if (phase === 'idle') return 0;
    if (phase === 'gap') {
      const seg = segments[idx];
      return Math.min(seg.at, base + wallElapsed());
    }
    if (phase === 'tail') return Math.min(totalMs, base + wallElapsed());
    const seg = segments[idx];
    return seg.at + Math.min(seg.durMs, segmentPosition(seg));
  }

  /** Position inside the playing segment, in ms. */
  function segmentPosition(seg) {
    if (!handle || handle.failed()) return wallElapsed();
    const pos = handle.positionMs();
    // A handle that reports nothing useful must not freeze the clock; the
    // watchdog below still ends the segment, but until it does we keep the
    // clock moving on the only other evidence we have.
    if (!Number.isFinite(pos)) return wallElapsed();
    return Math.max(0, pos);
  }

  function startSegment() {
    const seg = segments[idx];
    phase = 'play';
    resetWall();
    handle = null;
    if (seg.src) {
      try { handle = play(seg.src); } catch { handle = null; }
    }
  }

  function endSegment() {
    if (handle) { try { handle.stop(); } catch { /* already gone */ } handle = null; }
    const seg = segments[idx];
    base = seg.at + seg.durMs;
    idx++;
    resetWall();
    phase = idx < segments.length ? 'gap' : 'tail';
  }

  /** Advance the state machine as far as the clock allows. */
  function step() {
    // Bounded: every branch either returns or strictly increases `idx`/`phase`.
    for (let guard = 0; guard <= segments.length * 2 + 4; guard++) {
      if (phase === 'ended') return;
      if (phase === 'tail') {
        if (base + wallElapsed() >= totalMs) { phase = 'ended'; return; }
        return;
      }
      const seg = segments[idx];
      if (phase === 'gap') {
        if (base + wallElapsed() < seg.at) return;
        startSegment();
        continue;
      }
      // phase === 'play'
      const pos = segmentPosition(seg);
      const ended = handle ? handle.ended() : false;
      const overrun = wallElapsed() > seg.durMs + SEGMENT_WATCHDOG_MS;
      if (ended || pos >= seg.durMs + SEGMENT_END_TOLERANCE_MS || overrun) {
        endSegment();
        continue;
      }
      return;
    }
  }

  const api = {
    start() {
      if (started) return;
      started = true; running = true;
      idx = 0; nextWord = 0; endFired = false;
      base = 0; phase = segments.length ? 'gap' : 'tail';
      resetWall();
      api.tick();
    },

    /**
     * One frame. Called from requestAnimationFrame. Everything downstream —
     * the word highlight, patience, progress, auto-finish — reads the `t`
     * produced here, so they are all on the clock the audio is on.
     */
    tick() {
      if (!started || !running || phase === 'ended') return;
      step();
      const t = clockMs();

      let fired = false;
      while (nextWord < wordTimes.length && wordTimes[nextWord] <= t) {
        const i = nextWord++;
        onWord(events[i], t);
        fired = true;
      }

      // onTick after the words, so patience sees this frame's words before it
      // judges the silence — and always immediately after a word, matching the
      // old replay driver's behaviour.
      if (fired || t - lastTickAt >= tickMs) {
        lastTickAt = t;
        onTick?.(t);
      }

      if (phase === 'ended' && !endFired) {
        endFired = true;
        running = false;
        onEnd?.(totalMs);
      }
    },

    pause() {
      if (!started || !running) return;
      wallAccum = wallElapsed();
      running = false;
      if (handle) { try { handle.pause(); } catch { /* gone */ } }
    },

    resume() {
      if (!started || running || phase === 'ended') return;
      running = true;
      wallMark = now();
      if (handle) { try { handle.resume(); } catch { /* gone */ } }
    },

    stop() {
      started = false; running = false;
      if (handle) { try { handle.stop(); } catch { /* gone */ } handle = null; }
    },

    get clockMs() { return clockMs(); },
    get running() { return started && running; },
    get paused() { return started && !running && phase !== 'ended'; },
    get finished() { return phase === 'ended'; },
    /** Diagnostic: how many word events have been dispatched. */
    get wordsFired() { return nextWord; },
  };

  return api;
}
