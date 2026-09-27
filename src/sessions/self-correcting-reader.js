// Session script (d): a mid-level reader on "The Castle That Would Not Stay"
// (sandcastle-3) who MONITORS HIMSELF — the behaviour reading teachers
// actually care about and most fluency scorers punish.
//
// Three distinct kinds of self-repair, all in one read:
//   1. sub-word build-up: "sand" → "sandcastle", "mo" → "moat", "pro" →
//      "proved". These arrive as low-confidence NON-FINAL fragments, so the
//      patience machine sees effort (WORKING → extended wait, coach stays
//      quiet) and the scorer never sees them at all (finalWords() only).
//   2. a full out-loud miscue immediately repaired: he says "wanted", hears
//      himself, and says "warned". The aligner does NOT charge this as an
//      error or an insertion — it absorbs "wanted" as a failed attempt at the
//      same reference word and emits a single `correct` op carrying
//      `attempts: 1`. So catching your own error costs nothing in the score
//      while still being visible in the op stream. Verified: the whole read
//      aligns as 41/41 correct with no `ins` op anywhere.
//   3. one genuine stall on "walls" — no fragments, just silence — which is
//      the only place the coach speaks.
const w = (text, start, end, confidence = 0.9, final = true) =>
  ({ text, confidence, start, end, final });

export const session = {
  id: 'self-correcting-reader',
  title: 'Self-correcting reader',
  passageId: 'sandcastle-3',
  events: [
    w('we', 600, 900),
    w('built', 1300, 1700),
    w('a', 2100, 2250),
    w('sand', 3100, 3400, 0.32, false),   // building the word → WORKING
    w('sandcastle', 4600, 5400),
    w('close', 5900, 6300),
    w('to', 6700, 6850),
    w('the', 7200, 7350),
    w('water', 7700, 8100),
    w('with', 8600, 8900),
    w('four', 9300, 9650),
    w('towers', 10100, 10600),
    w('and', 11000, 11200),
    w('a', 11600, 11750),
    w('deep', 12100, 12450),
    w('mo', 13400, 13600, 0.30, false),   // building "moat" → WORKING again
    w('moat', 14700, 15100),
    w('around', 15600, 16100),
    w('it', 16500, 16700),
    w('my', 17300, 17500),
    w('cousin', 17900, 18450),
    // Out-loud miscue, caught and repaired by the reader himself, unprompted.
    w('wanted', 18900, 19450),
    w('warned', 19900, 20400, 0.93),
    w('me', 20800, 21000),
    w('that', 21400, 21650),
    w('the', 22000, 22150),
    w('tide', 22500, 22850),
    w('was', 23250, 23450),
    w('coming', 23850, 24350),
    w('in', 24750, 24900),
    w('i', 25500, 25650),
    w('told', 26000, 26350),
    w('her', 26750, 26950),
    w('the', 27300, 27450),
    // Genuine stall: silence, no effort fragments at all. Patience expires
    // ~3s after 27450 → STALLED, coach supplies "walls" and the read resumes.
    w('walls', 32200, 32700),
    w('were', 33100, 33350),
    w('strong', 33750, 34250),
    w('the', 34900, 35050),
    w('next', 35450, 35800),
    w('wave', 36200, 36600),
    w('pro', 37600, 37800, 0.28, false),  // building "proved" → WORKING
    w('proved', 38900, 39450),
    w('my', 39900, 40100),
    w('cousin', 40500, 41050),
    w('right', 41450, 41850),
  ],
};
