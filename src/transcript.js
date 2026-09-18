// Transcript accumulator for AssemblyAI v3 streaming Turn messages.
//
// Per AssemblyAI's v3 streaming API reference, each Turn message's `words`
// array is CUMULATIVE: it re-sends every word currently in that turn
// (finalized words plus a revisable non-final tail), not just newly-heard
// words. The documented client contract is to REPLACE the stored words for
// a given `turn_order` on every message (never append/concat), treat
// `word_is_final: true` words as immutable once seen, and seal a turn when
// `end_of_turn: true` arrives.
//
// Network-free and unit-testable: this module knows nothing about
// WebSockets, only about turn_order -> words bookkeeping.

/**
 * @typedef {{text: string, start: number, end: number, confidence: number, word_is_final: boolean}} AAIWord
 */

export function createTranscript() {
  const turns = new Map();        // turn_order -> latest words[] for that turn
  const turnOrders = [];          // insertion order of turn_order keys
  const seenFinal = new Set();    // `${turn_order}:${index}` already reported as newly-final
  const seenAny = new Set();      // `${turn_order}:${index}` already reported as newly-appeared at all

  return {
    /**
     * Apply one Turn message. Replaces (never appends to) the stored words
     * for that turn_order, and reports what's newly relevant since the last
     * call: words that appeared for the first time, or that finalized for
     * the first time (either counts as "added" so the patience machine sees
     * each genuine word/fragment exactly once).
     */
    applyTurn({ turn_order, end_of_turn, words }) {
      if (!turns.has(turn_order)) turnOrders.push(turn_order);
      turns.set(turn_order, words); // REPLACE, never concat

      const added = [];
      words.forEach((w, idx) => {
        const anyKey = `${turn_order}:${idx}`;
        const finalKey = `${turn_order}:${idx}:final`;
        if (w.word_is_final) {
          if (!seenFinal.has(finalKey)) {
            seenFinal.add(finalKey);
            seenAny.add(anyKey);
            added.push(w);
          }
        } else if (!seenAny.has(anyKey)) {
          seenAny.add(anyKey);
          added.push(w);
        }
      });

      return { words: this.words(), added, end_of_turn: !!end_of_turn };
    },

    /**
     * Adapter for non-Turn-based sources (the demo replay path): each call
     * appends one word as its own singleton "turn". Replay events are
     * emitted exactly once, in order, and are all final by default — so
     * there is no cumulative-replace or revision behavior to model here,
     * just a single shared place both paths write into so render/score
     * downstream (refresh(), finishSession()) never has to know which
     * source produced the word.
     */
    addWord(word) {
      const turn_order = `replay:${turnOrders.length}`;
      const w = { text: word.text, start: word.start, end: word.end, confidence: word.confidence, word_is_final: word.final !== false };
      turnOrders.push(turn_order);
      turns.set(turn_order, [w]);
      seenAny.add(`${turn_order}:0`);
      if (w.word_is_final) seenFinal.add(`${turn_order}:0:final`);
      return w;
    },

    /** All words across all turns, in turn_order then in-turn order. */
    words() {
      return turnOrders.flatMap((t) => turns.get(t));
    },

    /** Only word_is_final === true words — the scoreable transcript. */
    finalWords() {
      return this.words().filter((w) => w.word_is_final === true);
    },
  };
}
