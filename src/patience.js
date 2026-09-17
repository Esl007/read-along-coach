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
};

export function createPatience(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let lastWordAt = null;    // last clean (confident) word end time
  let lastEffortAt = null;  // last low-confidence fragment time
  let state = State.LISTENING;

  return {
    /** Feed every word/fragment from the realtime stream. */
    onWord(word, now = word.end) {
      if (word.confidence >= cfg.workingConfidence) {
        lastWordAt = now;
        state = State.LISTENING;
      } else {
        lastEffortAt = now;             // they're trying — grant more time
        state = State.WORKING;
      }
      return state;
    },
    /** Call on a timer (e.g. every 250ms) with the current stream clock. */
    tick(now) {
      if (lastWordAt === null) return state; // haven't started yet
      let deadline = lastWordAt + cfg.baseStallMs;
      if (lastEffortAt !== null && lastEffortAt > lastWordAt) {
        deadline = lastEffortAt + cfg.workingBonusMs;
        state = State.WORKING;
      }
      if (now > deadline) state = State.STALLED;
      return state;
    },
    /** After the coach supplies a word, reset the clock. */
    helped(now) {
      lastWordAt = now;
      lastEffortAt = null;
      state = State.LISTENING;
    },
    get state() { return state; },
  };
}
