// Session script (b): a halting early reader on "The Cat and the Sun".
// Exercises the whole patience machine: sounding-out fragments (WORKING),
// one genuine stall after "sun." (STALLED → coach help), one skipped word
// ("big"), one substitution ("run" for "ran"), and one low-confidence final
// ("moo" for "move") that must land as unscorable, not wrong.
const w = (text, start, end, confidence = 0.9, final = true) =>
  ({ text, confidence, start, end, final });

export const session = {
  id: 'halting-early-reader',
  title: 'Halting early reader',
  passageId: 'cat-1',
  events: [
    w('the', 500, 800),
    w('ca', 2500, 2700, 0.3, false),   // sounding out → WORKING
    w('cat', 4000, 4300),
    w('sat', 4800, 5100),
    w('in', 5500, 5800),
    w('the', 6100, 6400),
    w('sun', 6800, 7100),
    // long silence, no effort fragments → STALLED just after 10100; coach helps
    w('the', 11500, 11800),
    w('sun', 12300, 12600),
    w('was', 13000, 13300),
    w('wa', 14500, 14700, 0.35, false), // sounding out "warm" → WORKING again
    w('warm', 16000, 16300),
    w('the', 17000, 17300),
    w('cat', 17800, 18100),
    w('was', 18500, 18800),
    w('happy', 19200, 19500),
    w('a', 20200, 20500),
    // "big" skipped entirely
    w('dog', 21000, 21300),
    w('run', 21800, 22100),             // substitution for "ran"
    w('by', 22500, 22800),
    w('the', 23500, 23800),
    w('cat', 24200, 24500),
    w('did', 24900, 25200),
    w('not', 25600, 25900),
    w('moo', 26500, 26800, 0.4),        // garbled "move" → unscorable
    w('the', 27800, 28100),
    w('cat', 28500, 28800),
    w('was', 29200, 29500),
    w('too', 29900, 30200),
    w('warm', 30600, 30900),
    w('to', 31300, 31600),
    w('care', 32000, 32300),
  ],
};
