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
// We also deliberately do NOT drive the word highlight off clip timestamps.
// Kokoro exposes per-token times, but they are phoneme-group aligned and
// espeak-ng merges function words during phonemization, so "the cat" can come
// back as a single timing span. The highlight stays driven by the existing,
// tested alignment pipeline; audio is scheduled alongside it, never the
// source of truth for it.

/** A gap at least this long ends a phrase: it is a breath, a pause, or a stall. */
export const PHRASE_GAP_MS = 600;

/** Never synthesize more than this many words as one unit. */
export const PHRASE_MAX_WORDS = 8;

/**
 * Group a demo session's word events into synthesis units.
 *
 * Grouping rules, in order:
 *   - Non-final events (sounding-out fragments like "ca", "wa") are ALWAYS
 *     their own single-word phrase. They are not speech to be phrased; they
 *     are the child's partial attempt, and the demo's meaning depends on them
 *     sounding halting and separate.
 *   - A gap of >= PHRASE_GAP_MS between the previous event's `end` and the
 *     next event's `start` starts a new phrase.
 *   - A phrase is capped at PHRASE_MAX_WORDS so one clip can never run so
 *     long that audio drifts noticeably behind the highlight.
 *
 * @param {{id: string, events: Array<{text: string, start: number, end: number, final?: boolean}>}} session
 * @returns {Array<{id: string, text: string, start: number, end: number, indices: number[], fragment: boolean}>}
 *   `start` is the stream-clock ms at which playback should begin.
 *   `id` is stable across regeneration (derived from session id + first index)
 *   and is the clip's basename under voices/phrases/.
 */
export function phrasesForSession(session) {
  const phrases = [];
  let current = null;

  const flush = () => { if (current) { phrases.push(current); current = null; } };

  session.events.forEach((ev, i) => {
    const isFragment = ev.final === false;

    const breaks =
      !current ||
      isFragment ||
      current.fragment ||
      current.indices.length >= PHRASE_MAX_WORDS ||
      ev.start - current.end >= PHRASE_GAP_MS;

    if (breaks) {
      flush();
      current = {
        id: `${session.id}-${i}`,
        text: ev.text,
        start: ev.start,
        end: ev.end,
        indices: [i],
        fragment: isFragment,
      };
    } else {
      current.text += ' ' + ev.text;
      current.end = ev.end;
      current.indices.push(i);
    }
  });

  flush();
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
