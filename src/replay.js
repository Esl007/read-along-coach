// Replay: feeds a recorded session script through the same pipeline as live
// audio. A script is an array of {text, confidence, start, end, final?} word
// events with stream-clock timings in ms (final defaults to true; final:false
// fragments feed the patience machine but are never scored).

/**
 * Real-time playback. Drives onWord at each event's `end` time and onTick on a
 * fixed interval, exactly like the live WebSocket + timer pair.
 *
 * `setInterval` timers are not reliable messengers of wall-clock time: browsers
 * routinely coalesce/throttle them (backgrounded tabs, heavy main-thread load,
 * automated/headless drivers have all been observed firing a "250ms" interval
 * once a second or slower). Correctness here must not depend on a tick landing
 * inside any particular time window — only on `performance.now()` itself, which
 * is always accurate whenever a callback *does* run. So:
 *   - every word event gets its own `setTimeout` fired at its exact `end` time,
 *     instead of being polled for inside the interval tick;
 *   - session end is its own dedicated `setTimeout` at `endAt`, so `onEnd` fires
 *     on schedule even if the periodic tick is running slow or has been starved;
 *   - `onTick` still runs on the periodic interval for UI/patience polling, but
 *     a throttled or skipped tick can no longer suppress a word event or delay
 *     completion — worst case it just makes STALLED detection resolve on the
 *     next tick that manages to run, rather than losing the session entirely.
 */
export function createReplay(script, { onWord, onTick, onEnd, tickMs = 250, tailMs = 1000 } = {}) {
  const endAt = (script.length ? script[script.length - 1].end : 0) + tailMs;

  // ── Pause/resume: one declarative schedule, not a pile of live timers ──────
  //
  // The old shape kept an anonymous `timeouts` array whose entries could not be
  // told apart, so there was no way to reschedule "only the events that have
  // not fired yet" — pausing meant losing events and resuming meant replaying
  // them. So the schedule is now DATA: one entry per word event (plus the end
  // event), each carrying its own stream-clock time `at`, its own live timer
  // handle, and a `fired` latch.
  //
  // The `fired` latch is what makes double-firing structurally impossible:
  // it is set inside the callback before anything is dispatched, and both
  // pause() and the (re)scheduler skip any entry that already has it. A word
  // therefore reaches onWord exactly once across any number of pause/resume
  // cycles — which matters because every onWord lands in the scored
  // transcript, so a double-fire would silently corrupt WCPM and accuracy.
  //
  // Time is kept as `elapsed` (ms since the replay's own start), derived from
  // t0. Pausing freezes it (`heldElapsed`); resuming re-derives a new t0 from
  // it, so all remaining entries stay at their original positions relative to
  // each other and to the script — the replay clock simply stops during the
  // pause rather than running on under the hood.
  const entries = script.map((word) => ({
    at: word.end,
    fired: false,
    timer: null,
    dispatch(now) {
      onWord(word, now);
      // Also poke onTick right after each word lands: if the periodic
      // interval below is running coarser than tickMs (throttled tab,
      // busy main thread), a stall window between two word events could
      // otherwise never be sampled by any tick at all.
      onTick?.(now);
    },
  }));

  let interval = null, t0 = null, started = false, paused = false, heldElapsed = 0;

  const elapsed = () => (paused || t0 === null ? heldElapsed : performance.now() - t0);

  /** Arm timers for every entry that has not fired yet, plus the tick interval. */
  function arm() {
    const base = elapsed();
    for (const e of entries) {
      if (e.fired || e.timer !== null) continue;
      // A pause longer than the script's remaining runtime leaves a negative
      // delay; clamping at 0 makes those entries fire immediately on resume
      // (in schedule order) rather than being dropped — notably the end event,
      // which is the only thing that can finish the session.
      const delay = Math.max(0, e.at - base);
      e.timer = setTimeout(() => {
        e.timer = null;
        if (e.fired) return;     // exactly-once, belt and suspenders
        e.fired = true;
        if (e.isEnd) { api.stop(); onEnd?.(endAt); return; }
        e.dispatch(elapsed());
      }, delay);
    }
    interval = setInterval(() => onTick?.(elapsed()), tickMs);
  }

  /** Disarm every live timer without touching any `fired` latch. */
  function disarm() {
    clearInterval(interval); interval = null;
    for (const e of entries) {
      if (e.timer !== null) { clearTimeout(e.timer); e.timer = null; }
    }
  }

  entries.push({ at: endAt, fired: false, timer: null, isEnd: true });

  const api = {
    start() {
      if (started) return;
      started = true; paused = false; heldElapsed = 0;
      t0 = performance.now();
      arm();
    },

    /**
     * Freeze the replay clock and tear down every pending timer. Idempotent:
     * a second pause() while already paused is a no-op (it must not re-snapshot
     * heldElapsed, which by then has stopped advancing anyway, nor disarm
     * timers that are already gone).
     */
    pause() {
      if (!started || paused) return;
      heldElapsed = performance.now() - t0;
      paused = true;
      disarm();
    },

    /** Re-derive t0 from the frozen elapsed time and re-arm only unfired events. */
    resume() {
      if (!started || !paused) return;
      paused = false;
      t0 = performance.now() - heldElapsed;
      arm();
    },

    stop() {
      started = false; paused = false;
      disarm();
    },

    /** False while paused as well as before start/after stop. */
    get running() { return started && !paused; },
    get paused() { return started && paused; },
    /** Stream-clock ms consumed so far — frozen while paused. Test/diagnostic aid. */
    get elapsedMs() { return started ? elapsed() : heldElapsed; },
  };

  return api;
}

/**
 * Fast mode for tests: same event/tick ordering on a simulated clock, runs
 * instantly and synchronously. Returns the final simulated elapsed ms.
 */
export function runFast(script, { onWord, onTick, tickMs = 250, tailMs = 1000 } = {}) {
  const endAt = (script.length ? script[script.length - 1].end : 0) + tailMs;
  let i = 0;
  for (let now = 0; now <= endAt; now += tickMs) {
    while (i < script.length && script[i].end <= now) onWord(script[i], now), i++;
    onTick?.(now);
  }
  return endAt;
}
