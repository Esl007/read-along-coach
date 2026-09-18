// Reference-text aligner: Needleman-Wunsch alignment between the passage the
// reader is *supposed* to say and what ASR heard. This is the core instrument —
// it turns a transcript into per-word verdicts: correct / substituted /
// skipped / inserted / unscorable (low ASR confidence → never penalized).

export const UNSCORABLE_CONFIDENCE = 0.55; // below this we refuse to judge the reader

const norm = (w) => w.toLowerCase().replace(/[^a-z0-9']/g, '');

/**
 * @param {string[]} reference - passage words in order
 * @param {{text: string, confidence: number, start: number, end: number}[]} heard
 * @returns {{op: 'match'|'sub'|'del'|'ins', refIndex?: number, word?: object, verdict: string}[]}
 */
export function align(reference, heard) {
  const ref = reference.map(norm);
  const hyp = heard.map((w) => norm(w.text));
  const R = ref.length, H = hyp.length;

  // DP matrix: cost of aligning ref[0..i) with hyp[0..j)
  const cost = Array.from({ length: R + 1 }, () => new Array(H + 1).fill(0));
  for (let i = 1; i <= R; i++) cost[i][0] = i;
  for (let j = 1; j <= H; j++) cost[0][j] = j;
  for (let i = 1; i <= R; i++) {
    for (let j = 1; j <= H; j++) {
      const sub = cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      cost[i][j] = Math.min(sub, cost[i - 1][j] + 1, cost[i][j - 1] + 1);
    }
  }

  // Traceback
  const ops = [];
  let i = R, j = H;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.push({ op: ref[i - 1] === hyp[j - 1] ? 'match' : 'sub', refIndex: i - 1, word: heard[j - 1] });
      i--; j--;
    } else if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) {
      ops.push({ op: 'del', refIndex: i - 1 }); // reader skipped this word
      i--;
    } else {
      ops.push({ op: 'ins', word: heard[j - 1] }); // reader said an extra word
      j--;
    }
  }
  ops.reverse();

  // Confidence-aware grace: a "sub" or "ins" backed by low-confidence ASR is
  // unscorable, not wrong. We do not mark a reader down on audio we can't trust.
  for (const o of ops) {
    if (o.op === 'match') o.verdict = 'correct';
    else if (o.op === 'del') o.verdict = 'skipped';
    else if (o.word && o.word.confidence < UNSCORABLE_CONFIDENCE) o.verdict = 'unscorable';
    else o.verdict = o.op === 'sub' ? 'substituted' : 'inserted';
  }
  return ops;
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
  const ref = reference.map(norm);
  const hyp = heard.map((w) => norm(w.text));
  const R = ref.length, H = hyp.length;

  const cost = Array.from({ length: R + 1 }, () => new Array(H + 1).fill(0));
  for (let i = 1; i <= R; i++) cost[i][0] = i;
  for (let j = 1; j <= H; j++) cost[0][j] = j;
  for (let i = 1; i <= R; i++) {
    for (let j = 1; j <= H; j++) {
      const sub = cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      cost[i][j] = Math.min(sub, cost[i - 1][j] + 1, cost[i][j - 1] + 1);
    }
  }

  // Free end-gap: find the reference prefix length B that best explains ALL
  // heard words, i.e. the row with minimal cost in the H-th column. Tie-break
  // on the SMALLEST such i. This bias is deliberate and asymmetric: a
  // boundary that under-runs (too small) just means the highlight is one
  // word "behind" the reader and self-corrects on the very next word: a
  // boundary that over-runs (too large, e.g. drifting toward the passage
  // end) stops advancing at all and strands the reader on a highlight that
  // no longer matches where they are. Preferring the smallest tied i keeps
  // the boundary conservative in every ambiguous case.
  let B = 0, bestCost = cost[0][H];
  for (let i = 1; i <= R; i++) {
    if (cost[i][H] < bestCost) { bestCost = cost[i][H]; B = i; }
  }

  // Traceback from (B, H) instead of (R, H) — this is the only structural
  // difference from align(). Reference words at index >= B are untouched.
  const ops = [];
  let i = B, j = H;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.push({ op: ref[i - 1] === hyp[j - 1] ? 'match' : 'sub', refIndex: i - 1, word: heard[j - 1] });
      i--; j--;
    } else if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) {
      ops.push({ op: 'del', refIndex: i - 1 }); // skipped within the span actually read
      i--;
    } else {
      ops.push({ op: 'ins', word: heard[j - 1] }); // reader said an extra word
      j--;
    }
  }
  ops.reverse();

  for (const o of ops) {
    if (o.op === 'match') o.verdict = 'correct';
    else if (o.op === 'del') o.verdict = 'skipped';
    else if (o.word && o.word.confidence < UNSCORABLE_CONFIDENCE) o.verdict = 'unscorable';
    else o.verdict = o.op === 'sub' ? 'substituted' : 'inserted';
  }

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

/** Words-correct-per-minute over the span actually read. */
export function wcpm(ops, elapsedMs) {
  const correct = ops.filter((o) => o.verdict === 'correct').length;
  const minutes = elapsedMs / 60000;
  return minutes > 0 ? Math.round(correct / minutes) : 0;
}

/**
 * Struggle words: skipped, substituted, or preceded by a long pause.
 * `pending` words are never included (defect 1). Display normalization
 * (defect 6): strip surrounding punctuation and de-duplicate case-
 * insensitively so e.g. "warm." and "Warm" collapse to one practice-list
 * entry, shown in its lowercase form.
 */
export function struggleWords(ops, reference, pauseThresholdMs = 1500) {
  const out = new Map(); // lowercase key -> display value
  let prevEnd = null;
  const add = (raw) => {
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
