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
  let interval = null, timeouts = [], t0 = null;

  return {
    start() {
      t0 = performance.now();
      for (const word of script) {
        const delay = Math.max(0, word.end - (performance.now() - t0));
        // Also poke onTick right after each word lands: if the periodic
        // interval below is running coarser than tickMs (throttled tab,
        // busy main thread), a stall window between two word events could
        // otherwise never be sampled by any tick at all.
        timeouts.push(setTimeout(() => {
          const now = performance.now() - t0;
          onWord(word, now);
          onTick?.(now);
        }, delay));
      }
      interval = setInterval(() => onTick?.(performance.now() - t0), tickMs);
      const endDelay = Math.max(0, endAt - (performance.now() - t0));
      timeouts.push(setTimeout(() => { this.stop(); onEnd?.(endAt); }, endDelay));
    },
    stop() {
      clearInterval(interval); interval = null;
      timeouts.forEach(clearTimeout); timeouts = [];
    },
    get running() { return interval !== null; },
  };
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
