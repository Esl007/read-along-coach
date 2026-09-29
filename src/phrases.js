// Phrase grouping: the shared contract between the voice-clip generator
// (scripts/build-phrases.mjs) and the player (app.js).
//
// WHY THIS EXISTS
//
// Demo narration used to call speak() once per word, so a passage came out as
// "The." "Cat." "Sat." — every word synthesized in isolation, with the flat
// terminal prosody of a word spoken alone, and no phrase contour at all. Two
// defects fall out of that:
//
//   1. No sentence phrasing. A TTS engine given "the" produces the *isolated*
//      pronunciation of "the" (/ðiː/, falling pitch, full stop). Given
//      "The cat sat in the sun." it produces a single intonation arc with the
//      correct reduced function words (/ðə/). You cannot recover the second
//      from a concatenation of the first — it is not a scheduling problem,
//      it is a synthesis-unit problem. So the synthesis unit has to change.
//   2. Overlap. Authored event gaps are ~300-500ms while a real spoken word
//      clip runs 400-900ms, so consecutive clips were fired before the
//      previous one finished and played on top of each other.
//
// Fixing (1) also fixes most of (2): one clip per phrase means far fewer
// playback starts, each with the whole phrase's worth of gap behind it. The
// player's serial queue handles the remainder.
//
// WHY NOT SYNTHESIZE THE WHOLE PASSAGE AS ONE CLIP
//
// That would give the best possible prosody, but the demo is a *struggling*
// reader: the timeline deliberately contains a 4-second stall (the moment the
// patience machine exists to demonstrate), sounding-out fragments, a skipped
// word and a substitution. One continuous fluent read cannot represent any of
// that. Phrase-level clips keep the authored silences — and therefore the
// stall demo — intact while making the speech inside each phrase natural.
//
// ── WHERE THE BOUNDARIES COME FROM (and why the old rule was wrong) ─────────
//
// The first version of this module broke a phrase on ANY authored gap >= 600ms.
// That number has no linguistic meaning. The demo scripts space ordinary
// in-sentence words 300-700ms apart, so the 600ms rule chopped mid-clause at
// essentially arbitrary points ("the sun" / "was warm") and then the player
// inserted the *authored* silence between the pieces — which is how the demo
// acquired audible pauses in places where the language has none.
//
// Boundaries are now decided by the LANGUAGE, in this priority order:
//
//   1. A fragment (final === false) is always alone. It is not speech to be
//      phrased, it is the child's partial attempt, and the demo's meaning
//      depends on it sounding halting and separate.
//   2. Break at a sentence/clause boundary: after a word that ends in
//      . ! ? , ; : — or before a word that starts a new sentence/clause.
//   3. Break on a GENUINE STALL only: an authored gap >= PHRASE_STALL_MS.
//      That silence is meaningful (it is the moment the patience machine
//      exists to demonstrate) and has to survive into playback.
//   4. Cap at PHRASE_MAX_WORDS so no single clip can run away.
//
// Rule 2 needs punctuation, and the recorded word events carry none — they are
// bare lowercase tokens, because that is what a speech recogniser emits. The
// punctuation lives in the passage the session is reading (src/passages.js),
// so we recover it by walking the events against the passage words (see
// annotateEvents below). A skipped or substituted word simply fails to match
// and contributes no boundary, which is the safe direction to fail in.
//
// ── TIMING IS NOT DECIDED HERE ──────────────────────────────────────────────
//
// This module says what the synthesis units ARE. It deliberately says nothing
// about when they play: that is src/narration.js, which builds one timeline off
// the clips' real measured durations. `start`/`end` below are the AUTHORED
// event times and are used for exactly two things — deciding rule 3, and
// letting narration.js tell a genuine stall from an ordinary breath.

import { PASSAGES } from './passages.js';

/**
 * An authored gap at least this long is a genuine stall: the reader has
 * stopped, and the silence is part of what the demo is demonstrating.
 * Anything shorter is an ordinary inter-word interval and carries no meaning
 * that playback needs to reproduce.
 */
export const PHRASE_STALL_MS = 1200;

/**
 * Never synthesize more than this many words as one unit.
 *
 * This used to be 8 and was justified as drift control ("one clip can never
 * run so long that audio drifts noticeably behind the highlight"). That
 * justification is gone: src/narration.js derives the highlight FROM the audio
 * position, so a long clip cannot drift. What the cap is still for is bounding
 * clip length and synthesis memory, so it can now be generous enough that
 * whole clauses usually survive intact. At speed 0.85 twelve words is ~5s.
 */
export const PHRASE_MAX_WORDS = 12;

/** Punctuation that closes a sentence or a clause. */
const CLAUSE_PUNCT = /[.!?,;:]$/;

/** Tokens compare on letters/digits/apostrophes only — no case, no punctuation. */
const normalizeToken = (s) => String(s).toLowerCase().replace(/[^a-z0-9']/g, '');

/**
 * How far ahead of the expected position we will look for a match. Demo
 * scripts skip at most one word at a time; a wider window starts matching the
 * *next* "the" instead of this one.
 */
const MATCH_LOOKAHEAD = 4;

/**
 * Split a passage into tokens annotated with the clause boundaries around them.
 * Exported for the tests: this is the half of the boundary rule that is easy
 * to get subtly wrong.
 */
export function passageTokens(text) {
  const raw = String(text || '').split(/\s+/).filter(Boolean);
  const toks = raw.map((w) => ({
    norm: normalizeToken(w),
    endsClause: CLAUSE_PUNCT.test(w),
  }));
  return toks.map((t, i) => ({
    ...t,
    // A word that follows a clause-final word opens a new clause. Knowing this
    // from BOTH sides matters: when the reader garbles the word that carried
    // the period ("moo" for "move."), the boundary is only visible from the
    // word after it.
    startsClause: i > 0 && toks[i - 1].endsClause,
  }));
}

/**
 * Tag each word event with the clause boundaries of the passage word it is
 * reading, by walking the two sequences in step.
 *
 * Fragments never consume a passage word: "ca" is an attempt at "cat", so the
 * cursor must stay put or the real "cat" that follows would match the word
 * after it and every boundary from there on would be off by one.
 *
 * @returns {Array<{endsClause: boolean, startsClause: boolean}>} one per event
 */
function annotateEvents(events, passageText) {
  const toks = passageTokens(passageText);
  const out = [];
  let cursor = 0;

  for (const ev of events) {
    if (ev.final === false) { out.push({ endsClause: false, startsClause: false }); continue; }
    const norm = normalizeToken(ev.text);
    let found = -1;
    const limit = Math.min(toks.length, cursor + 1 + MATCH_LOOKAHEAD);
    for (let j = cursor; j < limit; j++) {
      if (toks[j].norm === norm) { found = j; break; }
    }
    if (found === -1) { out.push({ endsClause: false, startsClause: false }); continue; }
    out.push({ endsClause: toks[found].endsClause, startsClause: toks[found].startsClause });
    cursor = found + 1;
  }
  return out;
}

/**
 * Resolve the passage text a session is reading. Kept lazy and tolerant: a
 * synthetic session in a test has no passageId, and grouping must still work
 * (it just gets no punctuation-derived boundaries).
 */
let passagesById = null;

function passageTextFor(session, override) {
  if (override !== undefined) return override;
  if (!session || !session.passageId) return '';
  if (passagesById === null) {
    passagesById = new Map(PASSAGES.map((p) => [p.id, p.text]));
  }
  return passagesById.get(session.passageId) || '';
}

/**
 * Group a demo session's word events into synthesis units.
 *
 * @param {{id: string, passageId?: string, events: Array<{text: string, start: number, end: number, final?: boolean}>}} session
 * @param {{passageText?: string}} [opts] pass `passageText` to override the
 *   passage lookup (tests, or a session whose text is not in PASSAGES).
 * @returns {Array<{id: string, text: string, start: number, end: number, indices: number[], fragment: boolean, stallBefore: boolean}>}
 *   `start`/`end` are AUTHORED event times (see the header note on timing).
 *   `stallBefore` is true when the authored gap in front of this phrase is a
 *   genuine stall and must be reproduced in playback.
 *   `id` is stable across regeneration (derived from session id + first index)
 *   and is the clip's basename under voices/phrases/.
 */
export function phrasesForSession(session, opts = {}) {
  const events = session.events || [];
  const marks = annotateEvents(events, passageTextFor(session, opts.passageText));

  // Pass 1: cut on meaning only (fragment / clause / stall). No cap yet —
  // applying the cap here is what produced the orphaned one-word tails
  // ("…past the" then "rocks."), because the cap fires wherever the count
  // happens to land rather than where the language has a seam.
  const groups = [];
  let current = null;
  let prevEndedClause = false;

  events.forEach((ev, i) => {
    const isFragment = ev.final === false;
    // Measured against the immediately preceding event, not the group start:
    // the stall is the silence in front of THIS word.
    const stall = i > 0 && ev.start - events[i - 1].end >= PHRASE_STALL_MS;

    const breaks =
      !current ||
      isFragment ||
      current.fragment ||
      prevEndedClause ||
      marks[i].startsClause ||
      stall;

    if (breaks) {
      current = { indices: [i], fragment: isFragment, stallBefore: stall };
      groups.push(current);
    } else {
      current.indices.push(i);
    }
    prevEndedClause = marks[i].endsClause;
  });

  // Pass 2: enforce the cap by splitting an over-long clause into near-EQUAL
  // chunks, so the cap can never leave a one-word fragment of a clause on its
  // own. A 13-word clause becomes 7+6, not 12+1.
  const phrases = [];
  for (const g of groups) {
    const n = g.indices.length;
    const parts = Math.ceil(n / PHRASE_MAX_WORDS);
    for (let k = 0; k < parts; k++) {
      const from = Math.round((k * n) / parts);
      const to = Math.round(((k + 1) * n) / parts);
      const indices = g.indices.slice(from, to);
      phrases.push({
        id: `${session.id}-${indices[0]}`,
        text: indices.map((i) => events[i].text).join(' '),
        start: events[indices[0]].start,
        end: events[indices[indices.length - 1]].end,
        indices,
        fragment: g.fragment,
        // Only the first chunk inherits the stall that preceded the clause;
        // the cap-induced seams inside a clause are not stalls.
        stallBefore: k === 0 && g.stallBefore,
      });
    }
  }
  return phrases;
}

/**
 * Every phrase across every session, deduplicated by id. This is exactly the
 * set of clips the generator must render and the player may request.
 */
export function allPhrases(sessions) {
  const seen = new Map();
  for (const session of Object.values(sessions)) {
    for (const p of phrasesForSession(session)) {
      if (!seen.has(p.id)) seen.set(p.id, { ...p, sessionId: session.id });
    }
  }
  return [...seen.values()];
}
