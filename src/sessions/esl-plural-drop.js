// Session script (e): an adult ESL learner on "How Bees Share Directions"
// (honeybees-5) with ONE systematic error, not scattered noise.
//
// Her L1 has no word-final consonant clusters, so she drops the English -s
// ending every single time it appears: third-person verbs (finds → find,
// returns → return, dances → dance, points → point, tells → tell) and plurals
// alike (others → other, Hundreds → hundred, bees → bee, directions →
// direction). Her word order, her function words and her long content words
// are all perfect — the fluency number alone would just say "79%" and tell a
// teacher nothing.
//
// What makes the report worth looking at: the read scores 79% accuracy, and
// the struggle list comes back as ten words — nine of which end in -s (the
// tenth is "honeybee", the compound she hesitated on). That is a diagnosis,
// not a score. Fifteen minutes on one morpheme fixes nine of the ten items.
//
// Also demonstrated:
//   - "clove" for "clover" arrives at 0.45 confidence → UNSCORABLE, not
//     wrong. We do not mark a reader down on audio we could not trust.
//   - a hesitation fragment ("hon") before the unfamiliar compound
//     "honeybee" → WORKING, coach waits instead of interrupting.
//   - one real stall before "Hundreds" → the coach's single intervention.
const w = (text, start, end, confidence = 0.92, final = true) =>
  ({ text, confidence, start, end, final });

export const session = {
  id: 'esl-plural-drop',
  title: 'ESL reader: dropped endings',
  passageId: 'honeybees-5',
  events: [
    w('when', 700, 950),
    w('a', 1350, 1500),
    w('hon', 2400, 2600, 0.30, false),    // unfamiliar compound → WORKING
    w('honeybee', 3700, 4400),
    w('find', 4900, 5300),                // finds → find
    w('a', 5700, 5850),
    w('field', 6250, 6650),
    w('of', 7050, 7200),
    w('clove', 7600, 8050, 0.45),         // low confidence → unscorable
    w('it', 8500, 8700),
    w('return', 9100, 9600),              // returns → return
    w('to', 10000, 10150),
    w('the', 10550, 10700),
    w('hive', 11100, 11450),
    w('and', 11850, 12050),
    w('dance', 12450, 12900),             // dances → dance
    w('the', 13400, 13550),
    w('angle', 13950, 14400),
    w('of', 14800, 14950),
    w('its', 15350, 15550),
    w('dance', 15950, 16400),
    w('point', 16800, 17200),             // points → point
    w('toward', 17600, 18100),
    w('the', 18500, 18650),
    w('sun', 19050, 19400),
    w('the', 20000, 20150),
    w('length', 20550, 21000),
    w('tell', 21400, 21750),              // tells → tell
    w('the', 22150, 22300),
    w('other', 22700, 23100),             // others → other
    w('how', 23500, 23750),
    w('far', 24150, 24400),
    w('to', 24800, 24950),
    w('travel', 25350, 25850),
    // Genuine stall at the sentence boundary: she cannot get "Hundreds"
    // started, and produces no effort fragments. Coach supplies it once.
    w('hundred', 30600, 31100),           // Hundreds → hundred
    w('of', 31500, 31650),
    w('bee', 32050, 32350),               // bees → bee
    w('leave', 32750, 33100),
    w('on', 33500, 33650),
    w('direction', 34050, 34700),         // directions → direction
    w('given', 35100, 35450),
    w('without', 35850, 36350),
    w('a', 36750, 36900),
    w('single', 37300, 37750),
    w('word', 38150, 38500),
  ],
};
