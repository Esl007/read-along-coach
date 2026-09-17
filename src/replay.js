// Replay: feeds a recorded session script through the same pipeline as live
// audio. A script is an array of {text, confidence, start, end, final?} word
// events with stream-clock timings in ms (final defaults to true; final:false
// fragments feed the patience machine but are never scored).

/**
 * Real-time playback. Drives onWord at each event's `end` time and onTick on a
 * fixed interval, exactly like the live WebSocket + timer pair.
 */
export function createReplay(script, { onWord, onTick, onEnd, tickMs = 250, tailMs = 1000 } = {}) {
  const endAt = (script.length ? script[script.length - 1].end : 0) + tailMs;
  let timer = null, i = 0, t0 = null;

  return {
    start() {
      t0 = performance.now();
      timer = setInterval(() => {
        const now = performance.now() - t0;
        while (i < script.length && script[i].end <= now) onWord(script[i++], now);
        onTick?.(now);
        if (now >= endAt) { this.stop(); onEnd?.(endAt); }
      }, tickMs);
    },
    stop() { clearInterval(timer); timer = null; },
    get running() { return timer !== null; },
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
