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

/** Index of the next reference word the reader should attempt. */
export function nextExpectedIndex(ops) {
  let last = -1;
  for (const o of ops) if (o.refIndex !== undefined && o.verdict !== 'skipped') last = Math.max(last, o.refIndex);
  return last + 1;
}

/** Words-correct-per-minute over the span actually read. */
export function wcpm(ops, elapsedMs) {
  const correct = ops.filter((o) => o.verdict === 'correct').length;
  const minutes = elapsedMs / 60000;
  return minutes > 0 ? Math.round(correct / minutes) : 0;
}

/** Struggle words: skipped, substituted, or preceded by a long pause. */
export function struggleWords(ops, reference, pauseThresholdMs = 1500) {
  const out = new Set();
  let prevEnd = null;
  for (const o of ops) {
    if (o.verdict === 'skipped' || o.verdict === 'substituted') out.add(reference[o.refIndex]);
    if (o.word) {
      if (prevEnd !== null && o.word.start - prevEnd > pauseThresholdMs && o.refIndex !== undefined) {
        out.add(reference[o.refIndex]);
      }
      prevEnd = o.word.end;
    }
  }
  return [...out];
}
