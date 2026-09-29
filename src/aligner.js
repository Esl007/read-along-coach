// Reference-text aligner: Needleman-Wunsch alignment between the passage the
// reader is *supposed* to say and what ASR heard. This is the core instrument —
// it turns a transcript into per-word verdicts: correct / substituted /
// skipped / inserted / unscorable (low ASR confidence → never penalized) /
// pending (not reached yet, live reads only).
//
// Design commitments, in priority order:
//   1. NEVER flatter the reader. A near-miss is still an error in every
//      number we report (WCPM counts `correct` only; accuracy counts a
//      near-miss in the denominator and not the numerator). Near-miss
//      detection exists to get the ALIGNMENT right, not to hand out credit.
//   2. NEVER punish the microphone. Low ASR confidence → `unscorable`.
//   3. NEVER punish self-monitoring. Repetitions, sounded-out fragments and
//      out-loud self-corrections are disfluencies, not errors; the final
//      successful attempt is what gets scored.
//
// VERDICT VOCABULARY IS UNCHANGED by this file's near-miss work: the set is
// still { correct, substituted, skipped, inserted, unscorable, pending }, so
// styles.css and app.js need no new classes. Near-misses are surfaced as
// EXTRA fields on the existing ops — `near: true` plus a `similarity` score —
// on an op whose verdict remains `substituted`.

export const UNSCORABLE_CONFIDENCE = 0.55; // below this we refuse to judge the reader

// ── Alignment cost model ────────────────────────────────────────────────────
//
// Integers only, deliberately: the DP compares sums for exact equality during
// traceback, and integers make that exact by construction (no float epsilon).
//
//   MATCH (0)  exact match after normalization, or a known homophone pair —
//              free, and always strictly preferred over everything else.
//   NEAR  (1)  a near-miss ("ran" for "run", "kitten" for "kitty"): HALF the
//              price of a plain substitution, so the DP pairs a near-miss
//              with its target instead of splitting it into a
//              deletion+insertion, which is what cascades into a run of
//              spurious `skipped` words further down the passage.
//   SUB   (2)  an unrelated word in the right slot.
//   GAP   (2)  a skipped reference word (del) or an extra spoken word (ins).
//
// The two invariants that matter:
//   * MATCH < NEAR < SUB — an exact match can never lose to a near-miss, so
//     near-miss tolerance can never upgrade a genuinely wrong word to correct.
//   * NEAR < GAP and SUB <= 2*GAP — one substitution is never more expensive
//     than the del+ins pair that would otherwise replace it, so the aligner
//     keeps words in their slots rather than shredding the alignment.
// SUB:GAP is 2:2 == 1:1, exactly the ratio of the original 1:1 model, so
// alignment topology for non-near pairs is bit-for-bit what it was before.
export const COST_MATCH = 0;
export const COST_NEAR = 1;
export const COST_SUB = 2;
export const COST_GAP = 2;

/** Normalized edit-similarity at/above which two words are a near-miss. */
export const NEAR_SIMILARITY = 0.6;
/**
 * Lower similarity floor that still counts as a near-miss *if* the two words
 * share a phonetic key ("night"/"nite" are only 0.4 similar in letters but
 * identical in sound).
 */
export const NEAR_PHONETIC_SIMILARITY = 0.4;

// ── Normalization ───────────────────────────────────────────────────────────

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const ORDINALS = {
  1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', 6: 'sixth', 7: 'seventh',
  8: 'eighth', 9: 'ninth', 10: 'tenth', 11: 'eleventh', 12: 'twelfth', 13: 'thirteenth',
  20: 'twentieth', 30: 'thirtieth', 40: 'fortieth', 50: 'fiftieth', 60: 'sixtieth',
  70: 'seventieth', 80: 'eightieth', 90: 'ninetieth', 100: 'hundredth', 1000: 'thousandth',
};

function intToWords(n) {
  if (!Number.isFinite(n) || n < 0) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? ONES[n % 10] : '');
  if (n < 1000) return ONES[Math.floor(n / 100)] + 'hundred' + (n % 100 ? intToWords(n % 100) : '');
  if (n < 1e6) return intToWords(Math.floor(n / 1000)) + 'thousand' + (n % 1000 ? intToWords(n % 1000) : '');
  if (n < 1e9) return intToWords(Math.floor(n / 1e6)) + 'million' + (n % 1e6 ? intToWords(n % 1e6) : '');
  return String(n);
}

function ordinalToWords(n) {
  if (ORDINALS[n]) return ORDINALS[n];
  if (n < 100 && n % 10 && ORDINALS[n % 10]) return TENS[Math.floor(n / 10)] + ORDINALS[n % 10];
  return intToWords(n) + 'th';
}

// Contractions are canonicalized to their EXPANDED, space-free form so that
// "don't", "dont" and (via the compound-split repair below) the two tokens
// "do" + "not" all land on the same string. Only unambiguous entries are
// listed: "I'll"/"ill", "he'd"/"hed", "it's"/"its", "we're"/"were" and
// "we'll"/"well" are deliberately ABSENT because expanding them would break
// the real English word that shares the apostrophe-free spelling.
const CONTRACTIONS = {
  cant: 'cannot', cannot: 'cannot', dont: 'donot', doesnt: 'doesnot', didnt: 'didnot',
  isnt: 'isnot', arent: 'arenot', wasnt: 'wasnot', werent: 'werenot', aint: 'isnot',
  wont: 'willnot', hasnt: 'hasnot', havent: 'havenot', hadnt: 'hadnot',
  couldnt: 'couldnot', wouldnt: 'wouldnot', shouldnt: 'shouldnot', mustnt: 'mustnot',
  im: 'iam', ive: 'ihave', youre: 'youare', youve: 'youhave', theyre: 'theyare',
  theyve: 'theyhave', weve: 'wehave', lets: 'letus', thats: 'thatis', whats: 'whatis',
  theres: 'thereis', heres: 'hereis', wheres: 'whereis',
};

const APOSTROPHES = /['‘’ʼ´`]/g;
const SPLITTERS = /[-‐‑‒–—_/]+/;

const normCache = new Map();

/**
 * Canonical comparison form of a single token. Handles, in order:
 *   - case and every flavour of apostrophe ("don't" === "dont" === "don’t");
 *   - stutters and sub-word build-ups written with hyphens ("c-c-cat" →
 *     "cat", "b-but" → "but") — every leading segment is a prefix of the
 *     last, which is what a stutter looks like and a real compound does not;
 *   - hyphenated compounds ("well-known" → "wellknown", "twenty-one" →
 *     "twentyone") so they can meet a two-token spoken rendering halfway;
 *   - digits and ordinals ("3" → "three", "21" → "twentyone", "1st" →
 *     "first", "1,000" → "onethousand");
 *   - contractions (see CONTRACTIONS).
 * Returns '' for tokens with no alphanumeric content; '' never compares equal
 * to anything, including another ''.
 */
export function normalizeWord(raw) {
  if (typeof raw !== 'string') return '';
  const hit = normCache.get(raw);
  if (hit !== undefined) return hit;

  const lowered = raw.toLowerCase().replace(APOSTROPHES, '');
  const segments = lowered.split(SPLITTERS)
    .map((s) => s.replace(/[^a-z0-9]/g, ''))
    .filter((s) => s.length > 0);

  let base;
  if (segments.length === 0) {
    base = '';
  } else if (segments.length === 1) {
    base = segments[0];
  } else {
    const last = segments[segments.length - 1];
    const leading = segments.slice(0, -1);
    // Stutter / build-up: "c-c-cat", "c-ca-cat", "b-but". Requires either two
    // or more leading fragments, or a single one-character fragment —
    // otherwise "re-read" would collapse to "read".
    const isStutter = leading.every((s) => s.length < last.length && last.startsWith(s))
      && (leading.length >= 2 || leading[0].length === 1);
    base = isStutter ? last : segments.join('');
  }

  let out = base;
  if (/^\d+$/.test(base)) {
    out = intToWords(Number(base));
  } else {
    const ord = /^(\d+)(?:st|nd|rd|th)$/.exec(base);
    if (ord) out = ordinalToWords(Number(ord[1]));
    else if (CONTRACTIONS[base]) out = CONTRACTIONS[base];
  }

  if (normCache.size > 20000) normCache.clear();
  normCache.set(raw, out);
  return out;
}

// ── Homophones ──────────────────────────────────────────────────────────────
//
// Reading aloud, a homophone is INDISTINGUISHABLE from its partner: the
// passage says "sun", the reader says /sʌn/, and the ASR happens to write
// "son". The reader produced the correct phonemes, so this is `correct` —
// treating it as a substitution would penalize a reader for a transcription
// choice they had no way to influence. The list is intentionally restricted to
// pairs that are homophones in ALL common senses; "read"/"red" and
// "lead"/"led" are excluded because there the spelling really does pick out a
// different pronunciation.
const HOMOPHONE_GROUPS = [
  ['to', 'too', 'two'], ['there', 'their'], ['here', 'hear'], ['see', 'sea'],
  ['be', 'bee'], ['for', 'four', 'fore'], ['one', 'won'], ['son', 'sun'],
  ['no', 'know'], ['right', 'write', 'rite'], ['our', 'hour'], ['by', 'buy', 'bye'],
  ['new', 'knew'], ['blue', 'blew'], ['would', 'wood'], ['been', 'bean'],
  ['hi', 'high'], ['ate', 'eight'], ['made', 'maid'], ['wait', 'weight'],
  ['road', 'rode', 'rowed'], ['week', 'weak'], ['peace', 'piece'], ['whole', 'hole'],
  ['meet', 'meat'], ['mail', 'male'], ['plain', 'plane'], ['tail', 'tale'],
  ['threw', 'through'], ['wear', 'where', 'ware'], ['brake', 'break'],
  ['cell', 'sell'], ['cent', 'sent', 'scent'], ['deer', 'dear'], ['fair', 'fare'],
  ['flee', 'flea'], ['heal', 'heel'], ['knight', 'night'], ['knot', 'not'],
  ['mane', 'main'], ['pail', 'pale'], ['pear', 'pair', 'pare'],
  ['rain', 'reign', 'rein'], ['sail', 'sale'], ['steal', 'steel'], ['sum', 'some'],
  ['toe', 'tow'], ['waist', 'waste'], ['way', 'weigh'], ['flour', 'flower'],
  ['bare', 'bear'], ['board', 'bored'], ['coarse', 'course'], ['die', 'dye'],
  ['eye', 'i'], ['feat', 'feet'], ['flew', 'flu'], ['grate', 'great'],
  ['groan', 'grown'], ['hair', 'hare'], ['hoarse', 'horse'], ['loan', 'lone'],
  ['medal', 'meddle'], ['missed', 'mist'], ['need', 'knead'], ['none', 'nun'],
  ['oar', 'or', 'ore'], ['pain', 'pane'], ['past', 'passed'], ['pause', 'paws'],
  ['praise', 'prays'], ['principal', 'principle'], ['rap', 'wrap'], ['real', 'reel'],
  ['ring', 'wring'], ['role', 'roll'], ['rose', 'rows'], ['scene', 'seen'],
  ['seam', 'seem'], ['sight', 'site', 'cite'], ['soar', 'sore'], ['sole', 'soul'],
  ['stair', 'stare'], ['tea', 'tee'], ['thrown', 'throne'], ['tide', 'tied'],
  ['vain', 'vane', 'vein'], ['wave', 'waive'], ['weather', 'whether'],
  ['which', 'witch'], ['whine', 'wine'], ['yoke', 'yolk'],
];

const HOMOPHONE_OF = new Map();
for (let g = 0; g < HOMOPHONE_GROUPS.length; g++) {
  for (const word of HOMOPHONE_GROUPS[g]) HOMOPHONE_OF.set(word, g);
}

/** True when two already-normalized words are a known homophone pair. */
export function areHomophones(a, b) {
  if (!a || !b || a === b) return false;
  const ga = HOMOPHONE_OF.get(a);
  return ga !== undefined && ga === HOMOPHONE_OF.get(b);
}

// ── Similarity ──────────────────────────────────────────────────────────────

let lvPrev = new Int32Array(64);
let lvCur = new Int32Array(64);

/** Levenshtein distance, two rolling rows over reused buffers. */
export function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  if (lvPrev.length < n + 1) { lvPrev = new Int32Array(n + 1); lvCur = new Int32Array(n + 1); }
  let prev = lvPrev, cur = lvCur;
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const sub = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return prev[n];
}

/** Edit distance normalized by the longer word: 1 = identical, 0 = disjoint. */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longest = a.length > b.length ? a.length : b.length;
  return 1 - editDistance(a, b) / longest;
}

const phoneticCache = new Map();

/**
 * Light phonetic key: a consonant skeleton with the common English
 * spelling-to-sound rewrites applied. Not a full metaphone — just enough to
 * make "night"/"nite" and "phone"/"fone" collide while keeping "cat"/"dog"
 * apart. Only consulted as a SECOND opinion (see NEAR_PHONETIC_SIMILARITY),
 * and only when the key is at least 2 symbols long, because short keys
 * (and the empty key) collide far too easily to mean anything.
 */
export function phoneticKey(word) {
  if (!word) return '';
  const hit = phoneticCache.get(word);
  if (hit !== undefined) return hit;

  let s = word
    .replace(/^(?:kn|gn|pn)/, 'n')
    .replace(/^ps/, 's')
    .replace(/^wr/, 'r')
    .replace(/sch/g, 'sk')
    .replace(/[sc]h/g, 'X')   // sh / ch → one sibilant-ish symbol
    .replace(/th/g, 'T')
    .replace(/ph/g, 'f')
    .replace(/gh/g, '')       // silent: night, though, light
    .replace(/ck/g, 'k')
    .replace(/qu/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/g(?=[eiy])/g, 'j')
    .replace(/z/g, 's')
    .replace(/h/g, '')
    .replace(/w(?![aeiou])/g, '')
    .replace(/e$/, '');       // trailing silent e
  if (s.length > 1) s = s[0] + s.slice(1).replace(/[aeiouy]/g, '');
  s = s.replace(/(.)\1+/g, '$1');

  if (phoneticCache.size > 20000) phoneticCache.clear();
  phoneticCache.set(word, s);
  return s;
}

const pairCache = new Map();

/**
 * Classify a (reference, heard) pair of NORMALIZED words.
 * @returns {{cost: number, kind: 'match'|'near'|'sub', similarity: number,
 *            homophone?: boolean, phonetic?: boolean}}
 */
export function classifyPair(a, b) {
  if (!a || !b) return { cost: COST_SUB, kind: 'sub', similarity: 0 };
  if (a === b) return { cost: COST_MATCH, kind: 'match', similarity: 1 };

  const key = a + ' ' + b;
  const hit = pairCache.get(key);
  if (hit !== undefined) return hit;

  let result;
  if (areHomophones(a, b)) {
    result = { cost: COST_MATCH, kind: 'match', similarity: 1, homophone: true };
  } else {
    const sim = similarity(a, b);
    if (sim >= NEAR_SIMILARITY) {
      result = { cost: COST_NEAR, kind: 'near', similarity: sim };
    } else if (sim >= NEAR_PHONETIC_SIMILARITY) {
      const ka = phoneticKey(a);
      result = (ka.length >= 2 && ka === phoneticKey(b))
        ? { cost: COST_NEAR, kind: 'near', similarity: sim, phonetic: true }
        : { cost: COST_SUB, kind: 'sub', similarity: sim };
    } else {
      result = { cost: COST_SUB, kind: 'sub', similarity: sim };
    }
  }

  if (pairCache.size > 50000) pairCache.clear();
  pairCache.set(key, result);
  return result;
}

/** Convenience predicate: are these two normalized words a near-miss? */
export function isNearMiss(a, b) {
  return classifyPair(a, b).kind === 'near';
}

function pairCost(a, b) {
  return a === b && a ? COST_MATCH : classifyPair(a, b).cost;
}

// ── Normalized-reference cache ──────────────────────────────────────────────
// app.js passes the SAME `refWords` array on every live word, so normalizing
// the whole passage per call is pure waste. Keyed weakly on the array itself.
const refNormCache = new WeakMap();

function normalizeReference(reference) {
  const hit = refNormCache.get(reference);
  if (hit && hit.length === reference.length) return hit;
  const normed = reference.map(normalizeWord);
  refNormCache.set(reference, normed);
  return normed;
}

// ── DP matrix, column-major, reused across calls ────────────────────────────
//
// PERFORMANCE. alignPrefix() runs on EVERY incoming word of a live read, so a
// naive implementation is O(R*H) per call and O(R*H^2) over a whole passage —
// for a 60-word passage that is ~110k cell evaluations, each of which may need
// an edit-distance computation. Three things fix it:
//
//   1. Column-major layout. cols[j] holds the column for heard-word j, and a
//      column depends only on itself and cols[j-1]. Appending a heard word
//      therefore appends ONE column instead of invalidating the matrix.
//   2. Cross-call reuse. The cache keeps the last (reference, heard) pair. A
//      live read appends words, so the cached columns for the unchanged heard
//      prefix are reused verbatim and only the new tail is computed — O(R) per
//      incoming word, O(R*H) for the entire read. Revisions of the
//      still-provisional tail invalidate only from the first changed word.
//   3. Memoized pair classification (see pairCache) so the same
//      (reference word, heard word) similarity is never computed twice.
//
// Typed Int32Array columns keep this allocation-light; the cost model is
// integer-only so exact-equality traceback stays exact.
let dpRef = null;      // normalized reference array the cached columns belong to
let dpHyp = null;      // normalized heard array the cached columns belong to
let dpCols = null;     // Array<Int32Array>, dpCols[j][i]

/** Test/diagnostic hook: drop the memoized DP state. */
export function resetAlignerCaches() {
  dpRef = dpHyp = dpCols = null;
  pairCache.clear();
  normCache.clear();
  phoneticCache.clear();
}

/**
 * cols[j][i] = cost of aligning reference[0..i) with heard[0..j).
 * Both arguments must be NORMALIZED word arrays.
 */
function dpColumns(ref, hyp) {
  const R = ref.length, H = hyp.length;

  let cols;
  let reusable = 0;
  const sameRef = dpCols !== null && dpRef !== null && dpRef.length === R
    && (dpRef === ref || dpRef.every((v, k) => v === ref[k]));
  if (sameRef) {
    cols = dpCols;
    const limit = Math.min(dpHyp.length, H, cols.length - 1);
    while (reusable < limit && dpHyp[reusable] === hyp[reusable]) reusable++;
    cols.length = reusable + 1;
  } else {
    cols = [];
  }

  if (!cols[0] || cols[0].length !== R + 1) {
    const base = new Int32Array(R + 1);
    for (let i = 0; i <= R; i++) base[i] = i * COST_GAP;
    cols = [base];
  }

  for (let j = cols.length; j <= H; j++) {
    const prev = cols[j - 1];
    const cur = new Int32Array(R + 1);
    cur[0] = j * COST_GAP;
    const hw = hyp[j - 1];
    for (let i = 1; i <= R; i++) {
      const s = prev[i - 1] + pairCost(ref[i - 1], hw);
      const ins = prev[i] + COST_GAP;      // extra spoken word
      const del = cur[i - 1] + COST_GAP;   // skipped reference word
      cur[i] = s < ins ? (s < del ? s : del) : (ins < del ? ins : del);
    }
    cols[j] = cur;
  }

  dpRef = ref; dpHyp = hyp; dpCols = cols;
  return cols;
}

/**
 * Walk the DP backwards from (i0 ref words, j0 heard words) to (0, 0).
 * Emits ops in reading order, each carrying `hypIndex` (index into `heard`)
 * where a heard word was consumed — used by the disfluency repair below.
 */
function traceback(cols, ref, hyp, heard, i0, j0) {
  const ops = [];
  let i = i0, j = j0;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const pair = classifyPair(ref[i - 1], hyp[j - 1]);
      if (cols[j][i] === cols[j - 1][i - 1] + pair.cost) {
        const op = { op: pair.kind === 'match' ? 'match' : 'sub', refIndex: i - 1, word: heard[j - 1], hypIndex: j - 1 };
        if (pair.kind === 'near') { op.near = true; op.similarity = pair.similarity; }
        if (pair.homophone) op.homophone = true;
        ops.push(op);
        i--; j--;
        continue;
      }
    }
    if (i > 0 && cols[j][i] === cols[j][i - 1] + COST_GAP) {
      ops.push({ op: 'del', refIndex: i - 1 }); // reader skipped this word
      i--;
    } else {
      ops.push({ op: 'ins', word: heard[j - 1], hypIndex: j - 1 }); // extra spoken word
      j--;
    }
  }
  ops.reverse();
  return ops;
}

// ── Disfluency repair: repetitions, build-ups, self-corrections ─────────────
//
// Readers repeat themselves. "the... the cat", "c-c-cat", "kit— kitten",
// "wanted— warned". Every one of those produces one extra heard word that the
// DP can only explain as an INSERTION sitting immediately beside the very
// reference word it was an attempt at. Charging that as an error punishes the
// reader for self-monitoring, which is the single behaviour reading teachers
// most want to see. Two repairs, both requiring ADJACENCY in the op stream —
// an insertion is only ever attributed to the nearest reference-indexed op
// reachable by stepping over other insertions, so a RUN of false starts
// ("the... the... the cat", "c- c- cat") is repaired in full while an
// insertion separated from a target by any scored word is left alone. That
// adjacency rule is what keeps this from silently absorbing genuinely
// inserted words:
//
//   1. REPETITION / PARTIAL ATTEMPT — the inserted word is equal to, a strict
//      prefix of, a strict extension of, or a near-miss of the neighbouring
//      reference word. The insertion is dropped entirely; the neighbouring op
//      keeps whatever verdict it earned, so the FINAL attempt is what is
//      scored. The successful attempt usually follows the false start, so the
//      op to the RIGHT is considered first.
//   2. COMPOUND SPLIT — the inserted word concatenated with its neighbour's
//      heard word reconstructs the reference word exactly ("well" + "known"
//      → "wellknown", "twenty" + "one" → "21", "do" + "not" → "don't"). The
//      insertion is dropped and the neighbour is upgraded to a full match.
//      Requiring an EXACT reconstruction is what makes this safe.
//
// Dropped ops are removed rather than re-labelled on purpose: every consumer
// already excludes `op === 'ins'` from its denominators, and an op with no
// refIndex renders as nothing, so removal is the only outcome that is
// uniformly correct for scoring, rendering and reporting.
function isAttemptAt(spoken, target) {
  if (!spoken || !target) return false;
  if (spoken === target) return true;                                   // "the... the"
  if (target.length > spoken.length && target.startsWith(spoken)) return true; // "c", "ca", "kit"
  if (spoken.length > target.length && spoken.startsWith(target)) return true; // over-run
  return isNearMiss(spoken, target);                                    // "wanted" → "warned"
}

function repairDisfluencies(ops, ref, hyp) {
  const n = ops.length;
  if (n === 0) return ops;

  // Nearest reference-indexed op on each side, reachable by stepping over
  // insertions only. Every op either carries a refIndex (match/sub/del) or is
  // an insertion, so these two O(n) sweeps are exact.
  const rightRef = new Array(n).fill(null);
  const leftRef = new Array(n).fill(null);
  for (let k = n - 1; k >= 0; k--) rightRef[k] = ops[k].refIndex !== undefined ? ops[k] : rightRef[k + 1] || null;
  for (let k = 0; k < n; k++) leftRef[k] = ops[k].refIndex !== undefined ? ops[k] : (k > 0 ? leftRef[k - 1] : null);

  const out = [];
  for (let k = 0; k < n; k++) {
    const o = ops[k];
    if (o.op !== 'ins') { out.push(o); continue; }
    const spoken = hyp[o.hypIndex] || '';

    let dropped = false;
    // Right neighbour first: the successful attempt normally follows the
    // false start ("wanted" → "warned", "the" → "the cat").
    for (const nb of [rightRef[k + 1] || null, k > 0 ? leftRef[k - 1] : null]) {
      if (!nb || nb.refIndex === undefined) continue;
      const target = ref[nb.refIndex];
      if (!target) continue;

      // A neighbour already completed by a compound split must not absorb a
      // second insertion — that would be handing out unearned credit.
      if (!nb.merged && nb.word && nb.hypIndex !== undefined) {
        const nbSpoken = hyp[nb.hypIndex] || '';
        if (nbSpoken && (spoken + nbSpoken === target || nbSpoken + spoken === target)) {
          nb.op = 'match';
          nb.verdict = undefined;
          delete nb.near; delete nb.similarity;
          nb.merged = true;
          dropped = true;
          break;
        }
      }

      if (isAttemptAt(spoken, target)) {
        // Preserve the attempt for reporting without letting it score.
        if (nb.attempts === undefined) nb.attempts = 0;
        nb.attempts++;
        dropped = true;
        break;
      }
    }
    if (!dropped) out.push(o);
  }
  return out;
}

// Confidence-aware grace: a "sub" or "ins" backed by low-confidence ASR is
// unscorable, not wrong. We do not mark a reader down on audio we can't trust.
// This runs AFTER the repair pass so a low-confidence false start is dropped
// as a disfluency rather than lingering as an `unscorable` smudge.
function assignVerdicts(ops) {
  for (const o of ops) {
    if (o.op === 'match') o.verdict = 'correct';
    else if (o.op === 'del') o.verdict = o.verdict || 'skipped';
    else if (o.word && o.word.confidence < UNSCORABLE_CONFIDENCE) o.verdict = 'unscorable';
    else o.verdict = o.op === 'sub' ? 'substituted' : 'inserted';
  }
  return ops;
}

/**
 * Global (Needleman-Wunsch) alignment — for a COMPLETED read, where the
 * traceback genuinely should end on the last reference word. Use alignPrefix()
 * for anything live or partial.
 *
 * @param {string[]} reference - passage words in order
 * @param {{text: string, confidence: number, start: number, end: number}[]} heard
 * @returns {{op: 'match'|'sub'|'del'|'ins', refIndex?: number, word?: object, verdict: string,
 *            near?: boolean, similarity?: number, homophone?: boolean, attempts?: number}[]}
 */
export function align(reference, heard) {
  const ref = normalizeReference(reference);
  const hyp = heard.map((w) => normalizeWord(w.text));
  const cols = dpColumns(ref, hyp);
  const ops = repairDisfluencies(traceback(cols, ref, hyp, heard, ref.length, hyp.length), ref, hyp);
  return assignVerdicts(ops);
}

/**
 * Prefix (semi-global / free-end-gap) alignment for LIVE/partial transcripts.
 *
 * `align()` above is a global alignment: it forces the traceback to end at
 * the very last reference word, which is correct once a full transcript is
 * in hand but actively wrong while a read is in progress — with a partial
 * heard[], the traceback gets smeared across the whole passage and tends to
 * land on the FINAL reference word (see the lighthouse-4 repro: hearing just
 * 1 word made nextExpectedIndex jump to 40 of 41). This function instead
 * finds the reference PREFIX that best explains everything heard so far and
 * only tracebacks over that prefix; everything after it is `pending`
 * (not yet reached), not `skipped`.
 *
 * @param {string[]} reference
 * @param {{text: string, confidence: number, start: number, end: number}[]} heard
 */
export function alignPrefix(reference, heard) {
  const ref = normalizeReference(reference);
  const hyp = heard.map((w) => normalizeWord(w.text));
  const R = ref.length, H = hyp.length;
  const cols = dpColumns(ref, hyp);
  const last = cols[H];

  // Free end-gap: find the reference prefix length B that best explains ALL
  // heard words, i.e. the entry with minimal cost in the H-th column.
  // Tie-break on the SMALLEST such i. This bias is deliberate and asymmetric:
  // a boundary that under-runs (too small) just means the highlight is one
  // word "behind" the reader and self-corrects on the very next word; a
  // boundary that over-runs (too large, e.g. drifting toward the passage
  // end) stops advancing at all and strands the reader on a highlight that
  // no longer matches where they are. Preferring the smallest tied i keeps
  // the boundary conservative in every ambiguous case.
  let B = 0, bestCost = last[0];
  for (let i = 1; i <= R; i++) {
    if (last[i] < bestCost) { bestCost = last[i]; B = i; }
  }

  // Traceback from (B, H) instead of (R, H) — this is the only structural
  // difference from align(). Reference words at index >= B are untouched.
  const ops = repairDisfluencies(traceback(cols, ref, hyp, heard, B, H), ref, hyp);

  // HARD INVARIANT: no reference word at or beyond the boundary may carry any
  // verdict other than `pending`. The traceback cannot reach i >= B, so this
  // is unreachable by construction — it is here so the guarantee is a
  // property of alignPrefix() itself rather than of the traceback's
  // correctness, and so a future change to the boundary/traceback can never
  // silently mark an unread word wrong.
  for (const o of ops) {
    if (o.refIndex !== undefined && o.refIndex >= B) {
      o.op = 'del';
      o.verdict = 'pending';
      delete o.word; delete o.hypIndex; delete o.near; delete o.similarity;
    }
  }

  assignVerdicts(ops);

  // Reference words at/after the prefix boundary have not been reached yet.
  for (let idx = B; idx < R; idx++) ops.push({ op: 'del', refIndex: idx, verdict: 'pending' });

  return ops;
}

/**
 * Index of the next reference word the reader should attempt. With
 * alignPrefix() ops this is simply the prefix boundary B — the count of
 * non-pending ref-indexed ops — replacing the old max-refIndex scan that
 * produced the teleporting highlight under align().
 */
export function nextExpectedIndex(ops) {
  let b = 0;
  for (const o of ops) if (o.refIndex !== undefined && o.verdict !== 'pending') b = Math.max(b, o.refIndex + 1);
  return b;
}

/**
 * Words-correct-per-minute over the span actually read. Deliberately counts
 * `correct` ONLY: a near-miss is not a correct word, and WCPM is the number a
 * teacher compares against a benchmark, so it must never be inflated.
 */
export function wcpm(ops, elapsedMs) {
  const correct = ops.filter((o) => o.verdict === 'correct').length;
  const minutes = elapsedMs / 60000;
  return minutes > 0 ? Math.round(correct / minutes) : 0;
}

/**
 * Struggle words: skipped, substituted (including near-misses), or preceded
 * by a long pause. `pending` words are never included (defect 1). Display
 * normalization (defect 6): strip surrounding punctuation and de-duplicate
 * case-insensitively so e.g. "warm." and "Warm" collapse to one practice-list
 * entry, shown in its lowercase form.
 */
export function struggleWords(ops, reference, pauseThresholdMs = 1500) {
  const out = new Map(); // lowercase key -> display value
  let prevEnd = null;
  const add = (raw) => {
    if (typeof raw !== 'string') return;
    const clean = raw.replace(/^[^\w']+|[^\w']+$/g, '');
    if (!clean) return;
    const key = clean.toLowerCase();
    if (!out.has(key)) out.set(key, key);
  };
  for (const o of ops) {
    if (o.verdict === 'pending') continue;
    if (o.verdict === 'skipped' || o.verdict === 'substituted') add(reference[o.refIndex]);
    if (o.word) {
      if (prevEnd !== null && o.word.start - prevEnd > pauseThresholdMs && o.refIndex !== undefined) {
        add(reference[o.refIndex]);
      }
      prevEnd = o.word.end;
    }
  }
  return [...out.values()];
}
