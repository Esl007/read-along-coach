import { PASSAGES, words } from '/src/passages.js';
import { alignPrefix, wcpm, struggleWords, nextExpectedIndex } from '/src/aligner.js';
import { createPatience, State } from '/src/patience.js';
import { createReplay } from '/src/replay.js';
import { phrasesForSession } from '/src/phrases.js';
import { createTranscript } from '/src/transcript.js';
import { SESSIONS } from '/src/sessions/index.js';

const $ = (id) => document.getElementById(id);
const sel = $('passageSelect');
PASSAGES.forEach((p, i) => sel.add(new Option(`Level ${p.level} — ${p.title}`, i)));
const demoSel = $('demoSelect');
SESSIONS.forEach((s, i) => demoSel.add(new Option(s.title, i)));

let ws, audioCtx, workletNode, mediaStream, replay;
let refWords = [];
let transcript;           // live-mic only: turn-replacement accumulator (defect 2)
let patience, tickTimer = null, startedAt = null, helpCount = 0, lastNow = 0, activePassage = null;
let coachClearTimer = null;
let lastKnownStreamEnd = 0;       // last word.end we've seen (stream-clock ms)
let lastKnownStreamEndWallAt = 0; // wall-clock (performance.now()) when that word arrived

// Estimate "now" on the stream clock for the periodic tick: the last word's
// own end-of-speech time, plus however much wall-clock time has passed since
// that word arrived. This tracks real elapsed silence since the last word,
// without ever running ahead of (or being confused with) message-arrival
// wall-clock time. See the ws.onmessage comment for why this matters.
function estimatedStreamNow() {
  return lastKnownStreamEnd + (performance.now() - lastKnownStreamEndWallAt);
}
let isLiveSession = false; // true only for the live-mic path, false for replay/demo

// ── Session lifecycle state ────────────────────────────────────────────────
// `sessionActive` is the single source of truth for "a read is in progress".
// Every exit path (Finish button, auto-finish, replay end, WebSocket error or
// close, page unload) funnels through endSession(), which is idempotent
// because of the sessionActive guard — so a session can never be finished
// twice, and can never be left running with live timers after it ends.
// `sessionToken` invalidates in-flight async setup (token fetch, getUserMedia,
// addModule) belonging to a session that has already been replaced or ended.
let sessionActive = false;
let sessionToken = 0;

// ── Auto-finish (defect: "I have to stop the session every time manually") ──
// A session that never ends on its own reads as a stuck app. We finish
// automatically once BOTH conditions hold:
//   1. the aligner's prefix boundary has reached the end of the reference
//      (nextExpectedIndex === refWords.length — the reader got through the
//      whole passage), and
//   2. a sustained silence has followed, measured on the STREAM clock (each
//      word's own `end` plus wall time elapsed since it arrived — see
//      estimatedStreamNow), never on raw wall clock, so streaming latency
//      can't be mistaken for the reader going quiet.
// A word arriving during the countdown (a re-read, a trailing insertion)
// resets it, because silence is always measured from the last word we heard.
const AUTO_FINISH_SILENCE_MS = 2600;
const WRAP_UP_MAX_MS = AUTO_FINISH_SILENCE_MS + 2400; // hard backstop, never hang
let lastWordAtStream = null; // stream-clock `end` of the last word event
let wrapUpDeadline = null;

// Real-time demo replay used to give no visible sign of activity beyond a
// static status line for up to ~20-30 real seconds, which reads as "frozen"
// to anyone watching. Show a small pulsing "▶ Playing…" badge alongside the
// status text for the duration of a replay so it's obvious something is
// still happening. Live-mic sessions are untouched — this only appears when
// a replay is running.
// ── Text-to-speech: checked progressive enhancement + zero-voice fallback ──
// (defect 4, full rewrite)
//
// Root cause of "no voice output ever, regardless of toggle state": the old
// code snapshotted `speechSynthesis.getVoices().length > 0` ONCE at module
// load into a module-level `ttsAvailable` latch. Chrome routinely reports
// zero voices at load time and only populates the list later via the async
// 'voiceschanged' event — which does not fire in every browser (measured:
// does not fire in headless/no-audio-backend Chrome at all). Once the latch
// was false, nothing but 'voiceschanged' could ever flip it back, so
// speak() returned early FOREVER. Separately, even when a voice existed,
// speak() attached no onerror/onstart, so a `synthesis-failed` utterance
// (measured directly in this environment) failed completely silently —
// indistinguishable from success.
//
// Fix, three parts:
//   1. Never trust a load-time snapshot. Resolve availability lazily and
//      keep polling getVoices() for ~3s in addition to 'voiceschanged', so a
//      late-populating list is still picked up.
//   2. Instrument every utterance (onstart/onend/onerror) so a failure is
//      detected — one confirmed synthesis-failed (or a start-timeout) marks
//      Web Speech unusable for the rest of the session and switches to the
//      fallback below. One success is enough to keep trusting Web Speech.
//   3. Fallback: pre-rendered per-word WAV clips (see scripts/build-voices.mjs
//      and voices/) played via HTMLAudioElement. The vocabulary spoken here
//      is always a single closed-set reference word (never free text), and
//      the union of unique words across all passages + demo sessions is
///     ~100 — small enough to commit as static assets and play with zero
//      runtime dependency on any TTS engine or network call.
//
// window.__racAudio exposes the live decision state for one-eval diagnosis.
const TTS_MUTE_KEY = 'rac-tts-muted';
let ttsMuted = localStorage.getItem(TTS_MUTE_KEY) === '1';

const racAudio = {
  path: 'unknown',        // 'webspeech' | 'clips' | 'none'
  webSpeechEverStarted: false,
  webSpeechConfirmedBroken: false,
  lastError: null,
  voiceName: null,
  voiceCount: 0,
  reason: null,            // human-readable explanation when path === 'none'
  // ── Serial-queue counters (see the audio queue section below) ──────────────
  queued: 0,               // clips handed to enqueue()
  played: 0,               // clips actually started
  dropped: 0,              // clips discarded for being stale on their turn
  interrupts: 0,           // coach words that pre-empted whatever was audible
  phraseClips: 0,          // phrases narrated from a single phrase-level clip
  wordFallbacks: 0,        // phrases that had to fall back to per-word clips
};
window.__racAudio = racAudio;

// Phrase-narration manifest state. These MUST be declared here, above the
// speechSynthesis block below, and not beside the loader that fills them.
// refreshVoices() runs synchronously during module init and calls
// updateAudioDiagnosticUI(), which reads phraseManifest — so declaring these
// further down the file puts them in the temporal dead zone at that moment and
// throws "Cannot access 'phraseManifest' before initialization". That aborts
// module evaluation, so every button handler and the initial
// buildPassageSpans() at the bottom of this file silently never run and the
// entire app is dead on arrival. `let x = null` looks inert; under a
// same-module init-time call it is not.
let phraseManifest = null;   // Map<id, {seconds, file}> once loaded (possibly empty)
let phraseManifestError = null;

let ttsVoice = null;

function pickBestVoice(voices) {
  if (!voices.length) return null;
  const score = (v) => {
    let s = 0;
    if (/en/i.test(v.lang)) s += 10;
    if (/^en-US|^en_US/i.test(v.lang)) s += 2;
    if (/google|natural|neural|enhanced|premium/i.test(v.name)) s += 20;
    if (/espeak/i.test(v.name)) s -= 20; // known-robotic engine — de-prioritize
    if (v.localService) s += 1; // slight preference for local (lower latency)
    return s;
  };
  return voices.slice().sort((a, b) => score(b) - score(a))[0];
}

function refreshVoices() {
  if (typeof speechSynthesis === 'undefined') return;
  const voices = speechSynthesis.getVoices();
  racAudio.voiceCount = voices.length;
  ttsVoice = pickBestVoice(voices);
  racAudio.voiceName = ttsVoice ? ttsVoice.name : null;
  updateAudioDiagnosticUI();
}

const webSpeechUsable = () =>
  typeof speechSynthesis !== 'undefined' && !racAudio.webSpeechConfirmedBroken;

if (typeof speechSynthesis !== 'undefined') {
  refreshVoices();
  speechSynthesis.addEventListener('voiceschanged', refreshVoices);
  // Belt-and-suspenders: some browsers never fire 'voiceschanged' at all, so
  // also poll for ~3s in case the list populates without an event.
  let pollCount = 0;
  const pollTimer = setInterval(() => {
    refreshVoices();
    if (++pollCount >= 6) clearInterval(pollTimer); // 6 * 500ms = 3s
  }, 500);
} else {
  racAudio.reason = 'window.speechSynthesis is not defined in this browser.';
}

// ── Fallback / narration source: pre-rendered clips ─────────────────────────
const clipCache = new Map(); // src -> HTMLAudioElement
let clipManifest = null;     // Set of words we actually have clips for, once loaded

async function loadClipManifest() {
  try {
    const res = await fetch('/voices/manifest.json');
    if (!res.ok) throw new Error(`manifest fetch ${res.status}`);
    const list = await res.json();
    clipManifest = new Set(list);
  } catch (err) {
    clipManifest = new Set(); // no clips available either
    console.warn('[read-along-coach] could not load voice clip manifest:', err);
  }
}
loadClipManifest();

// ── Phrase-level clips (voices/phrases/) ────────────────────────────────────
//
// Loaded exactly as defensively as the per-word manifest above, and for the
// same reason: both files are produced by an offline generator script
// (scripts/build-phrases.mjs), so a fresh checkout, a half-finished build, or
// a deploy that shipped the code but not the assets are all NORMAL states, not
// crashes. A missing file, a malformed file, or a missing individual entry all
// degrade to the per-word clips and say so on screen.
//
// The shape is normalized on the way in because the generator owns the file
// format: we accept a bare array of entries, an object keyed by id, or a
// {phrases: [...]} wrapper, and we only ever read `id`, `seconds` and `file`.
// `file` is used when present rather than assuming `<id>.wav`, so the
// generator stays free to rename its output without breaking the player.
// (Declared far above, next to racAudio — updateAudioDiagnosticUI reads these
// and runs during module init, before this point is reached.)

function normalizePhraseManifest(raw) {
  const out = new Map();
  const add = (id, seconds, file) => {
    if (typeof id !== 'string' || !id) return;
    const s = Number(seconds);
    out.set(id, {
      seconds: Number.isFinite(s) && s > 0 ? s : 0,
      file: typeof file === 'string' && file ? file : `${id}.wav`,
    });
  };
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.phrases) ? raw.phrases : null;
  if (list) {
    for (const e of list) {
      if (typeof e === 'string') add(e);
      else if (e && typeof e === 'object') add(e.id, e.seconds ?? e.duration, e.file);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [id, v] of Object.entries(raw)) {
      if (typeof v === 'number') add(id, v);
      else if (v && typeof v === 'object') add(id, v.seconds ?? v.duration, v.file);
      else add(id);
    }
  }
  return out;
}

const phraseManifestReady = (async () => {
  try {
    const res = await fetch('/voices/phrases/manifest.json');
    if (!res.ok) throw new Error(`phrase manifest fetch ${res.status}`);
    phraseManifest = normalizePhraseManifest(await res.json());
  } catch (err) {
    phraseManifest = new Map();
    phraseManifestError = err.message;
    console.warn('[read-along-coach] no phrase clips available:', err);
  }
  updateAudioDiagnosticUI();
})();

function normalizeForClip(word) {
  return String(word).replace(/[^\w']/g, '').toLowerCase();
}

/** Source URL for a single-word clip, or null if we don't have that word. */
function wordClipSrc(word) {
  const key = normalizeForClip(word);
  if (!clipManifest || !clipManifest.has(key)) return null;
  return `/voices/${encodeURIComponent(key)}.wav`;
}

// ── Serial audio queue (defect 2: "the words are overlapping") ──────────────
//
// The old player called audio.play() the moment a word event landed. Authored
// event gaps are ~300-500ms; a spoken word clip runs 400-900ms. So clips were
// routinely started on top of each other, and because every start was
// unconditional the backlog could only grow — which is how "overlapping"
// became "unintelligible".
//
// The invariant here is simple and enforced in exactly one place: `playingEl`
// is the ONLY element that may be audible, and the only function that ever
// starts playback (audioStart) calls audioHalt() first. Nothing else calls
// play(). A queued clip can only be started from audioDrain(), which bails out
// unless playingEl is null — i.e. a queued clip never starts until the
// previous one's 'ended'/'error' handler has cleared the slot. JavaScript is
// single-threaded, so there is no window in which two elements are live.
//
// Web Speech is a second, un-serializable output channel, so it is folded into
// the same invariant from both sides: audioDrain() refuses to start a clip
// while an utterance is outstanding (`webSpeechSpeaking`), and the coach's
// interrupt path cancels speech AND halts the clip before it speaks.
//
// Staleness: audio that has fallen behind the highlight is worse than silence,
// so a clip whose scheduled stream time is already more than AUDIO_STALE_MS in
// the past when its turn finally comes is DROPPED, not played. This is what
// stops a backlog from growing without bound; racAudio.dropped counts it.
const AUDIO_STALE_MS = 1200;

// Per-word clips carry no duration in the manifest, so the phrase scheduler
// needs an estimate to space consecutive word fallbacks. Deliberately generous:
// over-spacing costs a little lag (and the staleness drop catches the extreme),
// under-spacing costs exactly the overlap we're fixing.
const WORD_CLIP_EST_MS = 700;

const audio = {
  backlog: [],       // [{src, at}] — `at` is the stream-clock ms it was due
  playingEl: null,   // the one element that may be audible right now
  paused: false,
  clock: 0,          // latest known stream-clock ms, fed by the replay tick
};
let webSpeechSpeaking = false;

Object.defineProperties(racAudio, {
  playing: { get: () => audio.playingEl !== null || webSpeechSpeaking, enumerable: true },
  backlog: { get: () => audio.backlog.length, enumerable: true },
  paused:  { get: () => audio.paused, enumerable: true },
});

function audioSetClock(now) { if (now > audio.clock) audio.clock = now; }

function clipElement(src) {
  let el = clipCache.get(src);
  if (!el) { el = new Audio(src); clipCache.set(src, el); }
  return el;
}

/** Silence whatever is audible on the clip channel. Never fires 'ended'. */
function audioHalt() {
  const el = audio.playingEl;
  if (!el) return;
  audio.playingEl = null;
  el.onended = null; el.onerror = null;
  try { el.pause(); } catch { /* element already torn down */ }
}

/** The ONLY place playback ever begins. */
function audioStart(src) {
  audioHalt();                       // invariant: at most one audible element
  const el = clipElement(src);
  audio.playingEl = el;
  const finish = () => {
    if (audio.playingEl !== el) return;  // superseded by a halt/interrupt
    audio.playingEl = null;
    el.onended = null; el.onerror = null;
    audioDrain();                    // hand the channel to the next clip
  };
  el.onended = finish;
  el.onerror = finish;
  try { el.currentTime = 0; } catch { /* not seekable yet */ }
  racAudio.played++;
  racAudio.path = 'clips';
  racAudio.reason = null;
  updateAudioDiagnosticUI();
  el.play().catch((err) => {
    racAudio.lastError = `Recorded clip playback failed: ${err.message}`;
    updateAudioDiagnosticUI();
    finish();                        // don't wedge the queue on one bad clip
  });
}

/** Queue a clip to play when the channel frees up. Never overlaps. */
function audioEnqueue(src, at = null) {
  if (!src) return;
  audio.backlog.push({ src, at });
  racAudio.queued++;
  audioDrain();
}

/**
 * The coach's help word. Wins unconditionally over anything else audible —
 * it is the pedagogically important audio — and the queue resumes behind it.
 */
function audioInterrupt(src) {
  // racAudio.interrupts is counted by the caller (speak), which also owns the
  // Web Speech side of the same pre-emption.
  if (!src) return;
  audio.paused = false;   // a coach interrupt is always allowed to be heard
  audioStart(src);
}

function audioDrain() {
  if (audio.paused || audio.playingEl || webSpeechSpeaking) return;
  while (audio.backlog.length) {
    const item = audio.backlog.shift();
    if (item.at !== null && audio.clock - item.at > AUDIO_STALE_MS) {
      racAudio.dropped++;           // fallen behind the highlight — silence is better
      continue;
    }
    audioStart(item.src);
    return;
  }
}

function audioPause() {
  audio.paused = true;
  // Keep playingEl set: a paused element resumes mid-clip and, crucially,
  // never fires 'ended', so the slot stays owned and nothing can slip in.
  if (audio.playingEl) { try { audio.playingEl.pause(); } catch { /* gone */ } }
  if (typeof speechSynthesis !== 'undefined') { try { speechSynthesis.pause(); } catch { /* unsupported */ } }
}

function audioResume() {
  audio.paused = false;
  if (typeof speechSynthesis !== 'undefined') { try { speechSynthesis.resume(); } catch { /* unsupported */ } }
  if (audio.playingEl) audio.playingEl.play().catch(() => { audioHalt(); audioDrain(); });
  else audioDrain();
}

/** Full reset, including the backlog. Called from every session teardown. */
function audioStop() {
  audio.backlog.length = 0;
  audio.paused = false;
  audio.clock = 0;
  audioHalt();
  if (typeof speechSynthesis !== 'undefined') {
    try { speechSynthesis.resume(); speechSynthesis.cancel(); } catch { /* unsupported */ }
  }
  webSpeechSpeaking = false;
}

function markWebSpeechBroken(reason) {
  racAudio.webSpeechConfirmedBroken = true;
  racAudio.lastError = reason;
  updateAudioDiagnosticUI();
}

// Renders a plain-language, non-technical line describing which audio path
// is active, or why there is none — so silence reads as "here's what's
// going on" instead of "the app is broken." See window.__racAudio for the
// machine-readable version of the same state.
// Two independent facts now, because the mute toggle no longer governs demo
// narration (defect 3): what the COACH will do when it steps in, and whether
// phrase-level demo narration is available. Reporting only the first would be
// actively misleading — "Coach voice is muted." used to be printed while a
// demo was narrating perfectly audibly.
function updateAudioDiagnosticUI() {
  const el = document.getElementById('audioDiagnostic');
  if (!el) return;

  let coachLine;
  if (ttsMuted) {
    coachLine = 'Coach voice is muted for live reads (on-screen help still appears).';
  } else if (racAudio.path === 'webspeech') {
    coachLine = `Spoken help is using your browser's voice${racAudio.voiceName ? ` ("${racAudio.voiceName}")` : ''}.`;
  } else if (racAudio.path === 'clips') {
    coachLine = 'Spoken help is using pre-recorded clips (your browser has no usable voices).';
  } else if (racAudio.webSpeechConfirmedBroken && (!clipManifest || clipManifest.size === 0)) {
    coachLine = `No audio is available: your browser reported "${racAudio.lastError || 'no working voice'}", and the recorded-clip fallback didn't load either.`;
  } else {
    coachLine = 'Spoken help will start the first time the coach steps in.';
  }

  let demoLine = '';
  if (phraseManifest === null) {
    demoLine = ' Checking demo narration clips…';
  } else if (phraseManifest.size === 0) {
    demoLine = phraseManifestError
      ? ` Demo narration is falling back to single-word clips — the phrase clips didn't load (${phraseManifestError}).`
      : ' Demo narration is falling back to single-word clips — no phrase clips have been built yet.';
  } else if (racAudio.wordFallbacks > 0) {
    demoLine = ` Demo narration is using phrase clips, except for ${racAudio.wordFallbacks} phrase${racAudio.wordFallbacks === 1 ? '' : 's'} with no clip built yet (those fall back to single words).`;
  } else {
    demoLine = ' Demo narration always plays, in full phrases, and is silenced with Pause.';
  }

  el.textContent = coachLine + demoLine;
}

/**
 * Speak the coach's help word.
 *
 * The mute toggle governs LIVE READS ONLY. In a demo replay both voices are
 * unconditional: the narrator (scheduled as phrase clips, which never come
 * through here) and the coach's intervention. "Someone who clicks play demo
 * means they want it to read for them" — and the coach supplying a stalled
 * word out loud is the single most persuasive moment in the product, so a
 * leftover mute preference must not be able to silence it.
 */
function speak(word, { priority = false } = {}) {
  if (ttsMuted && isLiveSession) return; // on-screen coach message covers this
  const cleanWord = normalizeForClip(word);

  if (priority) {
    // The coach always wins, across BOTH output channels: kill any clip that
    // is mid-playback and any outstanding utterance before making a sound.
    racAudio.interrupts++;
    audioHalt();
    if (typeof speechSynthesis !== 'undefined') {
      try { speechSynthesis.resume(); speechSynthesis.cancel(); } catch { /* unsupported */ }
    }
    webSpeechSpeaking = false;
  }

  if (!webSpeechUsable()) {
    const src = wordClipSrc(cleanWord);
    if (!src) {
      racAudio.path = 'none';
      racAudio.reason = `No recorded clip for "${cleanWord}" and Web Speech is unavailable in this browser.`;
      updateAudioDiagnosticUI();
      audioDrain();   // nothing to say — don't leave the queue stalled
      return;
    }
    if (priority) audioInterrupt(src); else audioEnqueue(src);
    return;
  }

  const u = new SpeechSynthesisUtterance(word);
  if (ttsVoice) u.voice = ttsVoice;
  u.rate = 0.85;  // slower — easier to follow for early readers / ESL learners
  u.pitch = 1.0;  // neutral

  // `webSpeechSpeaking` is the other half of the one-clip-at-a-time invariant:
  // while an utterance is outstanding, audioDrain() refuses to start a queued
  // clip, so the coach's voice and the demo narration cannot talk over each
  // other even though they are two unrelated output APIs. Clearing it always
  // re-drains, so a finished/failed utterance immediately hands the channel
  // back to the queue rather than stalling it forever.
  let started = false;
  const release = () => {
    if (!webSpeechSpeaking) return;
    webSpeechSpeaking = false;
    audioDrain();
  };
  const failover = () => {
    // Free the channel WITHOUT draining first: the replacement clip is about to
    // claim it, and letting a queued clip start in between would only get it
    // halted a moment later.
    webSpeechSpeaking = false;
    const src = wordClipSrc(cleanWord);
    if (src) audioInterrupt(src);
    else audioDrain();
  };

  const startTimeout = setTimeout(() => {
    if (!started) {
      markWebSpeechBroken('Utterance never fired onstart within 1.5s (treated as synthesis failure).');
      failover();
    }
  }, 1500);

  webSpeechSpeaking = true;

  u.onstart = () => {
    started = true;
    clearTimeout(startTimeout);
    racAudio.webSpeechEverStarted = true;
    racAudio.path = 'webspeech';
    racAudio.reason = null;
    updateAudioDiagnosticUI();
  };
  u.onend = () => { clearTimeout(startTimeout); release(); };
  u.onerror = (e) => {
    clearTimeout(startTimeout);
    if (!started) {
      // Only a failure before any audio started counts as "broken" — a
      // cancel() from a pre-empting priority utterance also fires onerror
      // with error 'interrupted'/'canceled' after a successful start, which
      // is expected behavior, not a failure.
      markWebSpeechBroken(`SpeechSynthesisUtterance error: ${e.error}`);
      failover();
    } else {
      release();
    }
  };

  speechSynthesis.speak(u);
}

// Status line writes are deduplicated: onTick fires 4x/second and the status
// text is usually identical, so re-writing it would churn the DOM (and the
// badge's CSS animation) for nothing.
let lastStatusKey = null;
function setStatus(text, { playing = false } = {}) {
  const key = `${playing ? 'P' : '-'}${text}`;
  if (key === lastStatusKey) return;
  lastStatusKey = key;
  $('status').innerHTML = playing
    ? `<span class="playing"><span class="dot"></span>▶ Playing…</span> ${text}`
    : text;
}

// ── Incremental rendering (defect: "voice recognition lag") ─────────────────
//
// The lag was ours, not AssemblyAI's. refresh() used to rebuild the entire
// passage with innerHTML on EVERY incoming word and EVERY 250ms tick: full
// re-alignment, then destroy and recreate every word span. On a 44-word
// passage under a real stream that is hundreds of parses + layout thrashes
// per read, and because each rebuild throws away the nodes, the highlight
// visibly lurched and (under load) appeared to freeze.
//
// The fix is three separate things, all needed:
//   1. Build the word spans ONCE per passage (buildPassageSpans). After that,
//      updates only assign span.className — and only on spans whose verdict
//      actually changed (paintPassage keeps the last applied class string per
//      span). No innerHTML during a session, ever; span identity is stable
//      for the whole read.
//   2. Coalesce into requestAnimationFrame (scheduleRender), so a Turn
//      message carrying five new words paints once, on the next frame, at
//      the display's own rate — not five times synchronously.
//   3. Cache alignment by revision (currentOps). The transcript is versioned
//      (transcriptRev); alignment re-runs only when that number changed, so
//      the 250ms tick and the auto-finish check read the SAME ops the last
//      paint used instead of each re-running Needleman-Wunsch. Nothing
//      changed => no alignment, no paint, no work at all.
//
// window.__racRender exposes the counters used to prove the above.
//
// One thing rAF alone cannot do: fire in a backgrounded tab. Browsers stop
// delivering frames entirely there, so a paint scheduled just before the tab
// was hidden would sit pending indefinitely and the highlight would be frozen
// at a stale word when the reader came back. The tick-driven fallback below
// (PAINT_FALLBACK_MS / maybePaintWithoutFrame) closes that hole without
// touching the fast path.
const racRender = { builds: 0, aligns: 0, frames: 0, paints: 0, classWrites: 0, fallbackPaints: 0 };
window.__racRender = racRender;

let wordSpans = [];        // one <span class="w"> per reference word, built once
let spanClasses = [];      // last class string actually written to each span
let transcriptRev = 0;     // bumped whenever the transcript content changes
let cachedOps = null;
let cachedOpsRev = -1;     // transcriptRev cachedOps was computed at
let paintedRev = -1;       // transcriptRev the DOM currently reflects
let rafHandle = null;

function buildPassageSpans() {
  const host = $('passage');
  wordSpans = [];
  spanClasses = [];
  const frag = document.createDocumentFragment();
  refWords.forEach((w, i) => {
    if (i) frag.appendChild(document.createTextNode(' '));
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = w;
    frag.appendChild(span);
    wordSpans.push(span);
    spanClasses.push('w');
  });
  host.replaceChildren(frag);
  paintedRev = -1;
  racRender.builds++;
}

// Alignment, memoized on the transcript revision. Live rendering/progress
// MUST use alignPrefix (semi-global, free end-gap), not the global align() —
// see src/aligner.js. align() forces the traceback to end at the last
// reference word, which drags the highlight to the end of the passage on
// partial transcripts (defect 1).
function currentOps() {
  if (!transcript || !refWords.length) return [];
  if (cachedOpsRev !== transcriptRev) {
    cachedOps = alignPrefix(refWords, transcript.words());
    cachedOpsRev = transcriptRev;
    racRender.aligns++;
  }
  return cachedOps;
}

function markTranscriptChanged() {
  transcriptRev++;
  scheduleRender();
}

// If a paint has been pending this long with no frame delivered, the tab is
// almost certainly backgrounded (or the compositor is starved) and no frame is
// coming. Paint from the tick instead rather than let the highlight stick.
const PAINT_FALLBACK_MS = 250;
let paintPendingSince = null;  // performance.now() when the rAF was requested

function scheduleRender() {
  if (rafHandle !== null) return; // already painting on the next frame
  paintPendingSince = performance.now();
  rafHandle = requestAnimationFrame(() => {
    rafHandle = null;
    paintPendingSince = null;
    racRender.frames++;
    paintPassage();
  });
}

/**
 * Tick-driven safety net for the rAF path. Idempotent with it by construction:
 * the pending frame is CANCELLED before we paint, so the two can never both
 * run for the same request, and paintPassage() additionally no-ops when
 * paintedRev is already current. Called from onTick, which is a setInterval —
 * throttled in a background tab but, unlike rAF, never stopped.
 */
function maybePaintWithoutFrame() {
  if (rafHandle === null || paintPendingSince === null) return;
  if (performance.now() - paintPendingSince < PAINT_FALLBACK_MS) return;
  cancelAnimationFrame(rafHandle);
  rafHandle = null;
  paintPendingSince = null;
  racRender.fallbackPaints++;
  paintPassage();
}

// Paint synchronously right now (used on session end, so the report and the
// final highlight state land in the same turn).
function flushRender() {
  if (rafHandle !== null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  paintPendingSince = null;
  paintPassage();
}

// ── Render vs. score: two views over the same transcript ────────────────────
//
// AssemblyAI finalizes words BEHIND the live edge — each cumulative Turn
// carries an immutable finalized prefix plus a revisable non-final tail, and
// finalization typically lags actual speech by hundreds of ms or more. If the
// live highlight only advances on finalized words, it visibly freezes while
// the reader is mid-word and then lurches forward once finalization catches
// up — this is the "stuck at several places" complaint.
//
// Fix: split responsiveness from correctness.
//   - RENDER (the live highlight, paintPassage) uses transcript.words() —
//     every currently-known word, finalized AND provisional — so it tracks
//     the reader in real time.
//   - SCORE (WCPM, accuracy, struggle words) uses transcript.finalWords() —
//     authoritative only, never scored off text that may still be revised.
// Because provisional words can be REVISED (not just appended), the render
// view is recomputed from the transcript rather than incrementally pushed
// onto an array — otherwise a revised word would leave its stale prior guess
// sitting in the list forever. What is incremental is the DOM write, not the
// alignment input.
function paintPassage() {
  if (!wordSpans.length) return;
  if (paintedRev === transcriptRev) return; // nothing changed since last paint
  const ops = currentOps();
  racRender.paints++;

  // 'pending' (not-yet-reached) ops render with no verdict class at all —
  // neutral/unstyled, never the struck-through 'skipped' look. Words backed
  // by a still-provisional (non-final) ASR word get an extra 'provisional'
  // class — a subtly reduced-opacity style so the UI stays honest that this
  // leading edge may still be revised, without looking like an error state.
  const verdictByRef = new Map();
  const provisionalRef = new Set();
  for (const o of ops) {
    if (o.refIndex === undefined) continue;
    if (o.verdict !== 'pending') verdictByRef.set(o.refIndex, o.verdict);
    if (o.word && o.word.word_is_final === false) provisionalRef.add(o.refIndex);
  }
  const nextIdx = nextExpectedIndex(ops);

  for (let i = 0; i < wordSpans.length; i++) {
    let cls = 'w';
    const verdict = verdictByRef.get(i);
    if (verdict) cls += ' ' + verdict;
    if (provisionalRef.has(i)) cls += ' provisional';
    if (i === nextIdx) cls += ' next';
    if (spanClasses[i] !== cls) {       // only touch spans that actually changed
      wordSpans[i].className = cls;
      spanClasses[i] = cls;
      racRender.classWrites++;
    }
  }
  paintedRev = transcriptRev;
}

// ── Shared pipeline: both live audio and replay feed these ──────────────────

function beginSession(passage, { live }) {
  abortActiveSession();     // never leave a previous session's timers running
  isLiveSession = live;
  activePassage = passage;
  refWords = words(passage);
  helpCount = 0; lastNow = 0; startedAt = null;
  lastWordAtStream = null;
  lastKnownStreamEnd = 0;
  lastKnownStreamEndWallAt = performance.now();
  transcript = createTranscript();
  patience = createPatience();
  transcriptRev = 0; cachedOps = null; cachedOpsRev = -1;
  buildPassageSpans();      // fresh, neutral spans — the only DOM rebuild
  $('coach').textContent = '';
  $('report').style.display = 'none';
  lastStatusKey = null;
  $('startBtn').disabled = true; $('demoBtn').disabled = true; $('stopBtn').disabled = false;
  sessionActive = true;
  return ++sessionToken;
}

// Shared word-event handler for BOTH the live path and the replay path. The
// live path calls this per newly-relevant word from transcript.applyTurn()
// (see ws.onmessage); the replay path calls it after registering the word
// via transcript.addWord() (see startDemo()) — both converge here so
// alignment/rendering/scoring is one pipeline regardless of source.
function onWordEvent(word, now) {
  lastNow = Math.max(lastNow, now);
  // Stream-clock bookkeeping for BOTH paths: the auto-finish silence check
  // and the live tick both read this through estimatedStreamNow().
  lastWordAtStream = now;
  lastKnownStreamEnd = Math.max(lastKnownStreamEnd, now);
  lastKnownStreamEndWallAt = performance.now();
  patience.onWord(word, now);
  markTranscriptChanged();
}

function onTick(now) {
  if (!sessionActive) return;
  lastNow = Math.max(lastNow, now);
  pumpNarration(now);     // demo only; no-op for a live read
  maybePaintWithoutFrame(); // rAF safety net for a backgrounded tab
  const s = patience.tick(now);
  if (maybeAutoFinish(now)) return; // owns the status line while wrapping up
  if (s === State.WORKING) setStatus('Take your time… 💪', { playing: !isLiveSession });
  else if (s === State.STALLED) {
    const idx = nextExpectedIndex(currentOps()); // memoized — no re-alignment per tick
    if (idx < refWords.length) {
      const word = refWords[idx].replace(/[^\w']/g, '');
      // The on-screen coach message is the primary, always-present channel;
      // TTS is a checked progressive enhancement layered on top (defect 4).
      $('coach').textContent = `The next word is “${word}” — you've got this.`;
      speak(word, { priority: true }); // always pre-empts demo narration, if any
      helpCount++;
      patience.helped(now);
      clearTimeout(coachClearTimer);
      coachClearTimer = setTimeout(() => { $('coach').textContent = ''; }, 6500);
    }
  } else setStatus('Listening…', { playing: !isLiveSession });
}

/** Has the reader worked all the way through the reference passage? */
function reachedEndOfPassage() {
  return refWords.length > 0 && nextExpectedIndex(currentOps()) >= refWords.length;
}

/**
 * Auto-finish check, run from the shared tick on the stream clock. Returns
 * true while it is in charge of the status line (i.e. the reader is done and
 * we're counting down, or we just finished). The countdown is visible on
 * purpose: ending mid-silence with no warning feels abrupt and makes people
 * think the app crashed.
 */
function maybeAutoFinish(now) {
  if (!sessionActive || lastWordAtStream === null) return false;
  if (!reachedEndOfPassage()) return false;
  const silentMs = now - lastWordAtStream;
  if (silentMs >= AUTO_FINISH_SILENCE_MS) {
    endSession({ status: 'Session finished — you read the whole passage! 🎉' });
    return true;
  }
  const secs = Math.max(1, Math.ceil((AUTO_FINISH_SILENCE_MS - silentMs) / 1000));
  setStatus(`Nice reading — that's the whole passage. Finishing up in ${secs}…`);
  return true;
}

/**
 * Tear down every side-effecting resource this session owns. Safe to call
 * repeatedly and from any exit path; leaves no timer, socket, mic track or
 * audio graph behind.
 */
function teardown() {
  clearInterval(tickTimer); tickTimer = null;
  clearTimeout(wrapUpDeadline); wrapUpDeadline = null;
  clearTimeout(coachClearTimer); coachClearTimer = null;
  if (rafHandle !== null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
  paintPendingSince = null;
  if (replay) { replay.stop(); replay = null; }
  // Audio outlives nothing: clear the backlog, silence the channel, and put
  // the Pause control back to its disabled resting state. Ending or finishing
  // a session therefore always resets it, no matter which exit path ran.
  audioStop();
  narrationPlan = null; narrationIdx = 0;
  setPauseControl(null);
  if (ws) {
    // Detach first: closing the socket ourselves must never be reported as an
    // unexpected close (that would stomp the report's status line).
    ws.onmessage = ws.onopen = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch { /* already closing */ }
    ws = null;
  }
  if (workletNode) {
    try { workletNode.port.onmessage = null; workletNode.disconnect(); } catch { /* already gone */ }
    workletNode = null;
  }
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  if (audioCtx) {
    const ctx = audioCtx; audioCtx = null;
    ctx.close().catch(() => { /* already closed */ });
  }
}

/** Drop a running session without reporting on it (e.g. a new one is starting). */
function abortActiveSession() {
  if (!sessionActive) { teardown(); return; }
  sessionActive = false;
  teardown();
}

/**
 * Scoring window: stream time from the start of the read to the last word we
 * actually heard. Trailing silence — including the auto-finish countdown —
 * must not count against the reader's WCPM. Falls back to wall-clock elapsed
 * for a live session in which no word was ever heard.
 */
function scoringElapsedMs() {
  if (lastWordAtStream !== null) return lastWordAtStream;
  if (isLiveSession && startedAt !== null) return performance.now() - startedAt;
  return lastNow;
}

/**
 * The one way a session ends. Idempotent (the sessionActive guard), always
 * tears down, and — whether it was the Finish button, auto-finish, the end of
 * a replay, or a dropped connection — renders the report and saves history
 * through exactly the same code path.
 */
function endSession({ status, report = true } = {}) {
  if (!sessionActive) return false;
  sessionActive = false;
  const elapsed = scoringElapsedMs();
  teardown();
  $('startBtn').disabled = false; $('demoBtn').disabled = false; $('stopBtn').disabled = true;
  if (report) finishSession(elapsed, status);
  else if (status) setStatus(status);
  return true;
}

function finishSession(elapsedMs, statusText) {
  setStatus(statusText || 'Session finished.');

  // Render one last time off the full (render) view so the passage doesn't
  // visually strip out a still-provisional trailing word the instant the
  // session ends.
  flushRender();

  // But SCORING (WCPM, accuracy, struggle words) uses ONLY finalized words —
  // never text that may still be revised. A reader who stops halfway sees
  // the unread tail as 'pending' ("not reached"), never as 'skipped'. Words
  // genuinely skipped within the span actually read still count as
  // 'skipped'. 'pending' is excluded from every denominator below (defect 1).
  const ops = alignPrefix(refWords, transcript.finalWords());
  const scoreable = ops.filter(o => o.verdict !== 'unscorable' && o.verdict !== 'pending' && o.op !== 'ins');
  const correct = ops.filter(o => o.verdict === 'correct').length;
  const rWcpm = wcpm(ops, elapsedMs);
  const rAcc = scoreable.length ? Math.round(100 * correct / scoreable.length) : null;
  $('rWcpm').textContent = rWcpm;
  $('rAcc').textContent = rAcc !== null ? rAcc + '%' : '–';
  $('rHelp').textContent = helpCount;
  const sw = struggleWords(ops, refWords);
  if (isLiveSession && transcript.finalWords().length === 0) {
    $('rStruggle').textContent = 'No speech was detected during this session. Check your microphone permissions and that the server successfully connected to AssemblyAI (see the status line above).';
  } else {
    $('rStruggle').textContent = sw.length ? sw.join(', ') : 'none — great read! 🎉';
  }
  $('report').style.display = 'block';

  // Don't persist junk sessions: a zero-word/no-speech run has nothing to
  // show in the progress table or WCPM sparkline and only pollutes them
  // (defect 5).
  if (correct > 0) {
    saveSession({
      date: new Date().toISOString(),
      passageId: activePassage.id,
      wcpm: rWcpm,
      accuracy: rAcc,
      helps: helpCount,
      struggleWords: sw,
    });
  }
  renderHistory();
}

// ── Live audio path ─────────────────────────────────────────────────────────

async function start() {
  const token = beginSession(PASSAGES[sel.value], { live: true });
  setStatus('Connecting…');

  try {
    const res = await fetch('/api/token');
    if (!res.ok) throw new Error(`the /api/token endpoint returned ${res.status}`);
    const { token: aaiToken } = await res.json();
    if (token !== sessionToken || !sessionActive) return; // superseded while awaiting

    // Request a 16kHz AudioContext, but the requested rate is only advisory —
    // browsers (notably Firefox/Safari) may silently ignore it and hand back
    // their own default (measured 48000 here). If we declared 16000 to
    // AssemblyAI while actually sending 48kHz PCM, transcription would be
    // silently garbage with no error surfaced anywhere. So: create the context
    // first, read back its ACTUAL sampleRate, and use that value — never the
    // requested one — for both the mic pipeline and the WebSocket URL (defect 3).
    // Park the stream in a local until we know this session still owns the
    // module globals — otherwise a superseded start() would clobber (and then
    // tear down) the resources belonging to the session that replaced it.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
    if (token !== sessionToken || !sessionActive) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    mediaStream = stream;
    audioCtx = new AudioContext({ sampleRate: 16000 });
    const actualSampleRate = audioCtx.sampleRate;

    ws = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?sample_rate=${actualSampleRate}&format_turns=false&token=${aaiToken}`);

    ws.onmessage = (e) => {
      if (token !== sessionToken) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; } // ignore non-JSON frames
      if (msg.type === 'Turn' && msg.words) {
        // ── Stream time, not wall-clock-at-arrival (defect: mixed time bases) ──
        // Transcription arrives late — a word's own `start`/`end` (ms since the
        // stream began) reflects when the reader actually said it; the wall
        // clock at message ARRIVAL (performance.now() - startedAt) reflects
        // when the network delivered it, which lags behind by however long
        // AssemblyAI + the network took. Feeding arrival-time into the
        // patience machine systematically UNDER-estimates how long the reader
        // has really been silent, so stall detection fires late. Also, every
        // word in one message would get the identical arrival-time `now`,
        // collapsing their real relative timing. Fix: drive the patience
        // machine off each word's own `end` (stream time) — exactly how the
        // replay path already works (it feeds each event's own `.end`).
        const { added } = transcript.applyTurn(msg);
        for (const w of added) {
          onWordEvent({ ...w, confidence: w.confidence ?? 0.9 }, w.end);
        }
        // A cumulative Turn can REVISE a non-final word in place without
        // adding anything, which changes what should be on screen even though
        // no word event fired. Mark the transcript dirty unconditionally; the
        // rAF coalescing makes this at most one paint per frame regardless.
        markTranscriptChanged();
      }
    };
    ws.onopen = async () => {
      if (token !== sessionToken) return;
      setStatus('Listening… read out loud!');
      startedAt = performance.now();
      lastKnownStreamEnd = 0;
      lastKnownStreamEndWallAt = performance.now();
      // Periodic tick: advance an ESTIMATED stream clock — last known word end
      // plus wall time elapsed since that word arrived — rather than raw wall
      // clock since session start. This keeps the periodic STALLED check (and
      // the auto-finish silence check) on the same time base as word events,
      // instead of racing ahead of them by the streaming latency.
      clearInterval(tickTimer);
      tickTimer = setInterval(() => onTick(estimatedStreamNow()), 250);
      try {
        await startMic(token);
      } catch (err) {
        failSession(`Microphone setup failed: ${err.message}`);
      }
    };
    ws.onerror = () => {
      if (token !== sessionToken) return;
      setStatus('Connection error — is the server running with an API key?');
    };
    ws.onclose = () => {
      // AssemblyAI may accept the connection but then close it (e.g. invalid/
      // expired token) without ever firing onerror. Our own teardown detaches
      // this handler first, so reaching it always means the socket dropped on
      // us: end the session properly (timers + mic released, buttons usable,
      // report rendered) instead of leaving the UI stuck mid-session.
      if (token !== sessionToken) return;
      endSession({ status: 'Connection closed unexpectedly — check your microphone and API key setup.' });
    };
  } catch (err) {
    failSession(`Couldn't start: ${err.message}. Is the server running with an AssemblyAI API key?`);
  }
}

/** Setup failed before any reading happened: reset cleanly, don't show a report. */
function failSession(message) {
  console.warn('[read-along-coach]', message);
  endSession({ status: message, report: false });
}

async function startMic(token) {
  // mediaStream and audioCtx are already created in start() so their actual
  // sampleRate could be read back before opening the WebSocket (defect 3).
  await audioCtx.audioWorklet.addModule('/pcm-worklet.js');
  if (token !== sessionToken || !audioCtx) return; // session ended while loading
  const src = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-writer');
  workletNode.port.onmessage = (e) => { if (ws?.readyState === 1) ws.send(e.data); };
  src.connect(workletNode);
}

function stop() {
  // Manual Finish. Idempotent via endSession's guard; works identically for a
  // live session and a demo replay.
  endSession();
}

// ── Replay path (demo without a mic or API key) ─────────────────────────────

// ── Phrase narration (defect 1: "'The' 'cat' are read separately") ──────────
//
// The old demo spoke one word per event, so a sentence came out as a list of
// isolated words with isolated-word prosody. The synthesis unit, not the
// schedule, was the problem — see the header of src/phrases.js for why a
// concatenation of single words can never sound like a phrase.
//
// So: group the session's events into phrases (phrasesForSession — the shared
// contract with the generator), and play ONE clip per phrase. The plan is a
// flat, pre-sorted list of {at, src} on the replay's own stream clock; the
// tick pumps it into the serial queue, which means narration inherits the
// queue's non-overlap and staleness guarantees for free, and pauses with the
// replay because a paused replay stops ticking.
//
// `cursor` is why the manifest's `seconds` matters: a phrase clip is as long
// as it is, and the authored `start` of the next phrase may fall inside it.
// Scheduling the next clip no earlier than the previous one can have finished
// keeps the queue from ever building a backlog in the first place, instead of
// relying on the drop rule to clean one up.
let narrationPlan = null;   // [{at, src}] sorted by `at`, or null for a live read
let narrationIdx = 0;

function buildNarrationPlan(session) {
  const phrases = phrasesForSession(session);
  const plan = [];
  let fallbacks = 0, phraseClips = 0;
  let cursor = 0;   // earliest stream time the next clip may begin

  for (const p of phrases) {
    const entry = phraseManifest?.get(p.id);
    if (entry) {
      const at = Math.max(p.start, cursor);
      plan.push({ at, src: `/voices/phrases/${encodeURIComponent(entry.file)}` });
      cursor = at + (entry.seconds > 0 ? entry.seconds * 1000 : WORD_CLIP_EST_MS);
      phraseClips++;
    } else {
      // No clip built for this phrase: degrade to the per-word clips that
      // already exist. Worse prosody, but audible — and reported on screen.
      fallbacks++;
      for (const i of p.indices) {
        const ev = session.events[i];
        const src = wordClipSrc(ev.text);
        if (!src) continue;           // no clip for this word either: silence
        const at = Math.max(ev.start, cursor);
        plan.push({ at, src });
        cursor = at + WORD_CLIP_EST_MS;
      }
    }
  }

  racAudio.phraseClips = phraseClips;
  racAudio.wordFallbacks = fallbacks;
  updateAudioDiagnosticUI();
  return plan;
}

/**
 * Hand every clip whose scheduled time has arrived to the serial queue.
 * Driven from onTick, so `now` is the replay's own elapsed stream time — which
 * freezes while the replay is paused, which is exactly what we want: narration
 * neither races ahead nor goes stale during a pause.
 */
function pumpNarration(now) {
  if (!narrationPlan) return;
  audioSetClock(now);
  while (narrationIdx < narrationPlan.length && narrationPlan[narrationIdx].at <= now) {
    const item = narrationPlan[narrationIdx++];
    audioEnqueue(item.src, item.at);
  }
}

function startDemo() {
  const session = SESSIONS[demoSel.value];
  const passage = PASSAGES.find(p => p.id === session.passageId);
  sel.value = PASSAGES.indexOf(passage);
  const token = beginSession(passage, { live: false });
  setStatus(`Replaying “${session.title}”…`, { playing: true });

  // Narration is UNCONDITIONAL (defect 3): clicking Play demo means "read it
  // to me", so nothing here consults ttsMuted — that toggle now governs only
  // the live-read coach voice. Pause is how a demo is silenced.
  // The manifest is fetched once at module load; this await is a resolved
  // microtask in practice, and the token guard covers the case where the
  // reader started something else in between.
  phraseManifestReady.then(() => {
    if (token !== sessionToken || !sessionActive) return;
    narrationPlan = buildNarrationPlan(session);
    narrationIdx = 0;
  });

  replay = createReplay(session.events, {
    // Adapter: the replay script's plain word events go through
    // transcript.addWord() first so they land in the SAME shared transcript
    // the live path writes into (see transcript.js addWord doc comment) —
    // both sources converge on one render/score pipeline downstream.
    // Narration is NOT driven from here any more: one clip per phrase is
    // scheduled off the plan above. Speaking per word here as well would
    // reintroduce exactly the overlap this replaces.
    onWord: (word, now) => {
      onWordEvent(transcript.addWord(word), now);
    },
    onTick,
    onEnd: () => {
      replay = null;
      setPauseControl(null);   // nothing left to pause
      // The recorded script has run out. If the reader got through the whole
      // passage, hand off to the SAME auto-finish path a live read uses so the
      // demo shows the identical countdown; otherwise there is nothing left to
      // wait for, so finish now.
      if (reachedEndOfPassage()) startWrapUp();
      else endSession();
    },
  });
  replay.start();
  setPauseControl('pause');
}

// ── Pause / resume the demo (defect 4: "no option to pause play demo") ──────
//
// Pausing has to stop BOTH clocks together or they desynchronise: the replay
// clock (highlight + patience + the narration pump) and the audio channel.
// The button's own label is derived from one state variable rather than
// toggled in place, so it cannot drift out of sync with what it does.
let demoPaused = false;

/** state: 'pause' (running, offer Pause) | 'resume' (paused) | null (hide). */
function setPauseControl(state) {
  demoPaused = state === 'resume';
  const btn = $('pauseBtn');
  if (!btn) return;
  btn.disabled = state === null;
  btn.textContent = demoPaused ? 'Resume demo' : 'Pause demo';
  btn.setAttribute('aria-pressed', demoPaused ? 'true' : 'false');
}

function togglePause() {
  if (!replay) return;               // no demo in flight; nothing to pause
  if (demoPaused) {
    replay.resume();
    audioResume();
    setPauseControl('pause');
    lastStatusKey = null;            // force the next tick to rewrite the status
  } else {
    replay.pause();
    audioPause();
    setPauseControl('resume');
    setStatus('Paused — press Resume demo to carry on.');
  }
}

/**
 * Keep the shared tick (and therefore the auto-finish check) running on the
 * estimated stream clock after a replay script ends, so the demo finishes
 * through the same completion path as a live read. The deadline is a hard
 * backstop: a session must never be able to hang here.
 */
function startWrapUp() {
  clearInterval(tickTimer);
  tickTimer = setInterval(() => onTick(estimatedStreamNow()), 250);
  clearTimeout(wrapUpDeadline);
  wrapUpDeadline = setTimeout(() => endSession(), WRAP_UP_MAX_MS);
}

// ── Session history (localStorage) + WCPM sparkline ─────────────────────────

const HISTORY_KEY = 'rac-history';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}

function saveSession(entry) {
  const h = loadHistory();
  h.push(entry);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-50)));
}

function sparkline(values, w = 220, h = 40) {
  if (values.length < 2) return '';
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const pts = values.map((v, i) =>
    `${(i / (values.length - 1)) * (w - 8) + 4},${h - 4 - ((v - min) / (max - min || 1)) * (h - 8)}`);
  const last = pts[pts.length - 1].split(',');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-label="WCPM trend">` +
    `<polyline points="${pts.join(' ')}" fill="none" stroke="#ff5a3c" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    pts.slice(0, -1).map(p => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="2.5" fill="#ff5a3c" fill-opacity=".55"/>`).join('') +
    `<circle cx="${last[0]}" cy="${last[1]}" r="4" fill="#1f9d7c" stroke="#fffdf8" stroke-width="1.5"/>` +
    `</svg>`;
}

function renderHistory() {
  const h = loadHistory();
  $('progress').style.display = h.length ? 'block' : 'none';
  if (!h.length) return;
  $('sparkline').innerHTML = sparkline(h.map(e => e.wcpm));
  const title = (id) => PASSAGES.find(p => p.id === id)?.title || id;
  $('historyBody').innerHTML = h.slice().reverse().map(e =>
    `<tr><td>${new Date(e.date).toLocaleDateString()}</td><td>${title(e.passageId)}</td>` +
    `<td>${e.wcpm}</td><td>${e.accuracy !== null ? e.accuracy + '%' : '–'}</td><td>${e.helps}</td></tr>`
  ).join('');
}

// ── Voice controls: one toggle, and it means one thing ──────────────────────
//
// There used to be a second "Narrate demo" switch, and the demo also silently
// obeyed the mute toggle. Both are gone (defect 3). Clicking Play demo is
// itself the request to be read to, so making it conditional on two unrelated
// switches was incoherent: the button's label promised something the toggles
// could quietly withhold. Demo narration is now unconditional, and Pause is
// the control that silences it.
//
// What remains is the live-read coach voice, which genuinely does need a mute
// (a classroom, a shared room, a reader who finds it startling) — and that is
// all `ttsMuted` governs now. It is read in exactly one place, speak(), and
// only when isLiveSession is true — a demo replay speaks both voices come
// what may.
localStorage.removeItem('rac-demo-narration'); // retired key; don't leave litter

const muteToggle = $('muteToggle');
if (muteToggle) {
  muteToggle.checked = !ttsMuted;
  muteToggle.onchange = () => {
    ttsMuted = !muteToggle.checked;
    localStorage.setItem(TTS_MUTE_KEY, ttsMuted ? '1' : '0');
    updateAudioDiagnosticUI();
  };
}
updateAudioDiagnosticUI();

$('startBtn').onclick = start;
$('stopBtn').onclick = stop;
$('demoBtn').onclick = startDemo;
$('pauseBtn').onclick = togglePause;
setPauseControl(null);   // disabled until a demo is actually running
sel.onchange = () => {
  if (sessionActive) return; // can't swap the passage out from under a live read
  refWords = words(PASSAGES[sel.value]);
  buildPassageSpans();
};

// Releasing the mic, socket and audio context on the way out matters: a
// leaked getUserMedia track keeps the browser's recording indicator on.
// 'pagehide' covers bfcache navigations that never fire 'beforeunload'.
window.addEventListener('pagehide', abortActiveSession);
window.addEventListener('beforeunload', abortActiveSession);

// Session diagnostics, mirroring window.__racAudio: one eval answers "is a
// session running, has the reader finished, how close is auto-finish?".
window.__racSession = {
  get active() { return sessionActive; },
  get live() { return isLiveSession; },
  get atEnd() { return sessionActive ? reachedEndOfPassage() : false; },
  get msSinceLastWord() {
    return lastWordAtStream === null ? null : Math.round(estimatedStreamNow() - lastWordAtStream);
  },
  get autoFinishSilenceMs() { return AUTO_FINISH_SILENCE_MS; },
  get transcriptRev() { return transcriptRev; },
};

refWords = words(PASSAGES[0]); buildPassageSpans();
renderHistory();
