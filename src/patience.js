// Patience state machine: decides when the coach may speak.
// Core rule: sounding-out is not silence. If we heard partial phonemes or a
// low-confidence fragment recently, the reader is WORKING — we extend the wait.
// The coach only offers the next expected word after a genuine stall.

export const State = {
  LISTENING: 'listening',   // reader is producing scoreable words
  WORKING: 'working',       // hesitation / sounding-out detected — extend patience
  STALLED: 'stalled',       // genuine stall — coach may gently supply the word
};

export const DEFAULTS = {
  baseStallMs: 3000,        // silence this long after a clean word → stalled
  workingBonusMs: 4000,     // extra patience granted while sounding-out is heard
  workingConfidence: 0.55,  // fragments below this = evidence of effort, not error
  // Opening grace: how long to wait at the START of a session, before any
  // speech at all has arrived, before offering the first word. Without this
  // the machine has no clock to measure against and a reader who freezes on
  // word one (or whose microphone never worked) gets silence forever instead
  // of the one nudge that unblocks them. Defaults to the most patient window
  // the machine can produce mid-read — baseStallMs + workingBonusMs — so
  // opening silence is treated at least as generously as a mid-passage stall.
  openingGraceMs: null,     // null → baseStallMs + workingBonusMs
};

export function createPatience(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const openingGraceMs = cfg.openingGraceMs === null || cfg.openingGraceMs === undefined
    ? cfg.baseStallMs + cfg.workingBonusMs
    : cfg.openingGraceMs;

  let lastWordAt = null;    // last clean (confident) word end time
  let lastEffortAt = null;  // last low-confidence fragment time
  let firstTickAt = null;   // first clock reading we ever saw (session start)
  let state = State.LISTENING;

  // The stream clock is not guaranteed monotonic: AssemblyAI revises its
  // non-final tail in place, so the same word (or an earlier one) can be
  // re-delivered with an older timestamp. Taking the max means a revision can
  // only ever extend the reader's credit, never rewind the patience clock and
  // manufacture a stall that already elapsed.
  const advance = (prev, now) => (prev === null || now > prev ? now : prev);

  return {
    /** Feed every word/fragment from the realtime stream. */
    onWord(word, now) {
      const at = Number.isFinite(now) ? now
        : Number.isFinite(word && word.end) ? word.end
          : Number.isFinite(word && word.start) ? word.start
            : (firstTickAt !== null ? firstTickAt : 0);
      if (firstTickAt === null) firstTickAt = at;
      const confidence = word && Number.isFinite(word.confidence) ? word.confidence : 1;
      if (confidence >= cfg.workingConfidence) {
        lastWordAt = advance(lastWordAt, at);
        state = State.LISTENING;
      } else {
        lastEffortAt = advance(lastEffortAt, at); // they're trying — grant more time
        state = State.WORKING;
      }
      return state;
    },

    /** Call on a timer (e.g. every 250ms) with the current stream clock. */
    tick(now) {
      if (!Number.isFinite(now)) return state;
      if (firstTickAt === null) firstTickAt = now;

      let deadline;
      if (lastEffortAt !== null && (lastWordAt === null || lastEffortAt > lastWordAt)) {
        // Sounding-out is the most recent evidence: the reader is working.
        deadline = lastEffortAt + cfg.workingBonusMs;
        state = State.WORKING;
      } else if (lastWordAt !== null) {
        deadline = lastWordAt + cfg.baseStallMs;
      } else {
        // Nothing has been heard at all yet — measure against session start.
        deadline = firstTickAt + openingGraceMs;
      }
      if (now > deadline) state = State.STALLED;
      return state;
    },

    /** After the coach supplies a word, reset the clock. */
    helped(now) {
      const at = Number.isFinite(now) ? now : (lastWordAt !== null ? lastWordAt : 0);
      lastWordAt = at;
      lastEffortAt = null;
      if (firstTickAt === null) firstTickAt = at;
      state = State.LISTENING;
    },

    get state() { return state; },
  };
}
