import { PASSAGES, words } from '/src/passages.js';
import { alignPrefix, wcpm, struggleWords, nextExpectedIndex } from '/src/aligner.js';
import { createPatience, State } from '/src/patience.js';
import { createReplay } from '/src/replay.js';
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
};
window.__racAudio = racAudio;

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

// ── Fallback: pre-rendered clips ────────────────────────────────────────────
const clipCache = new Map(); // normalized word -> HTMLAudioElement
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

function normalizeForClip(word) {
  return String(word).replace(/[^\w']/g, '').toLowerCase();
}

function playClip(word) {
  const key = normalizeForClip(word);
  if (!clipManifest || !clipManifest.has(key)) {
    racAudio.path = 'none';
    racAudio.reason = `No recorded clip for "${key}" and Web Speech is unavailable in this browser.`;
    updateAudioDiagnosticUI();
    return;
  }
  let audio = clipCache.get(key);
  if (!audio) {
    audio = new Audio(`/voices/${encodeURIComponent(key)}.wav`);
    clipCache.set(key, audio);
  } else {
    audio.currentTime = 0;
  }
  racAudio.path = 'clips';
  racAudio.reason = null;
  updateAudioDiagnosticUI();
  audio.play().catch((err) => {
    racAudio.path = 'none';
    racAudio.reason = `Recorded clip playback failed: ${err.message}`;
    updateAudioDiagnosticUI();
  });
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
function updateAudioDiagnosticUI() {
  const el = document.getElementById('audioDiagnostic');
  if (!el) return;
  if (ttsMuted) {
    el.textContent = 'Coach voice is muted.';
    return;
  }
  if (racAudio.path === 'webspeech') {
    el.textContent = `Spoken help is using your browser's voice${racAudio.voiceName ? ` ("${racAudio.voiceName}")` : ''}.`;
  } else if (racAudio.path === 'clips') {
    el.textContent = 'Spoken help is using pre-recorded word clips (your browser has no usable voices).';
  } else if (racAudio.webSpeechConfirmedBroken && (!clipManifest || clipManifest.size === 0)) {
    el.textContent = `No audio is available: your browser reported "${racAudio.lastError || 'no working voice'}", and the recorded-clip fallback didn't load either.`;
  } else {
    el.textContent = 'Audio will start once the coach speaks its first word.';
  }
}

function speak(word, { priority = false } = {}) {
  if (ttsMuted) return; // on-screen coach message already covers this case
  const cleanWord = normalizeForClip(word);

  if (!webSpeechUsable()) {
    playClip(cleanWord);
    return;
  }

  if (priority) speechSynthesis.cancel(); // coach's word always wins over demo narration
  const u = new SpeechSynthesisUtterance(word);
  if (ttsVoice) u.voice = ttsVoice;
  u.rate = 0.85;  // slower — easier to follow for early readers / ESL learners
  u.pitch = 1.0;  // neutral

  let started = false;
  const startTimeout = setTimeout(() => {
    if (!started) {
      markWebSpeechBroken('Utterance never fired onstart within 1.5s (treated as synthesis failure).');
      playClip(cleanWord);
    }
  }, 1500);

  u.onstart = () => {
    started = true;
    clearTimeout(startTimeout);
    racAudio.webSpeechEverStarted = true;
    racAudio.path = 'webspeech';
    racAudio.reason = null;
    updateAudioDiagnosticUI();
  };
  u.onend = () => { clearTimeout(startTimeout); };
  u.onerror = (e) => {
    clearTimeout(startTimeout);
    if (!started) {
      // Only a failure before any audio started counts as "broken" — a
      // cancel() from a pre-empting priority utterance also fires onerror
      // with error 'interrupted'/'canceled' after a successful start, which
      // is expected behavior, not a failure.
      markWebSpeechBroken(`SpeechSynthesisUtterance error: ${e.error}`);
      playClip(cleanWord);
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
const racRender = { builds: 0, aligns: 0, frames: 0, paints: 0, classWrites: 0 };
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

function scheduleRender() {
  if (rafHandle !== null) return; // already painting on the next frame
  rafHandle = requestAnimationFrame(() => {
    rafHandle = null;
    racRender.frames++;
    paintPassage();
  });
}

// Paint synchronously right now (used on session end, so the report and the
// final highlight state land in the same turn).
function flushRender() {
  if (rafHandle !== null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
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
  if (replay) { replay.stop(); replay = null; }
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

function startDemo() {
  const session = SESSIONS[demoSel.value];
  const passage = PASSAGES.find(p => p.id === session.passageId);
  sel.value = PASSAGES.indexOf(passage);
  beginSession(passage, { live: false });
  setStatus(`Replaying “${session.title}”…`, { playing: true });
  replay = createReplay(session.events, {
    // Adapter: the replay script's plain word events go through
    // transcript.addWord() first so they land in the SAME shared transcript
    // the live path writes into (see transcript.js addWord doc comment) —
    // both sources converge on one render/score pipeline downstream.
    onWord: (word, now) => {
      onWordEvent(transcript.addWord(word), now);
      // Opt-in synthetic narration (defect: "demo has no voice at all" reads
      // as broken even though the demo is a genuinely silent, pre-recorded
      // event timeline with no audio to play). Off by default; when the
      // reader enables it, only speak finalized words in sync with the
      // replay's own timeline, and never at 'priority' — the coach's help
      // word always pre-empts narration, never the other way around.
      if (demoNarrationOn && word.word_is_final !== false) speak(word.text);
    },
    onTick,
    onEnd: () => {
      replay = null;
      // The recorded script has run out. If the reader got through the whole
      // passage, hand off to the SAME auto-finish path a live read uses so the
      // demo shows the identical countdown; otherwise there is nothing left to
      // wait for, so finish now.
      if (reachedEndOfPassage()) startWrapUp();
      else endSession();
    },
  });
  replay.start();
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

// ── Voice controls: mute (persisted) + opt-in demo narration ────────────────

const DEMO_NARRATION_KEY = 'rac-demo-narration';
let demoNarrationOn = localStorage.getItem(DEMO_NARRATION_KEY) === '1';

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

const narrationToggle = $('narrationToggle');
if (narrationToggle) {
  narrationToggle.checked = demoNarrationOn;
  narrationToggle.onchange = () => {
    demoNarrationOn = narrationToggle.checked;
    localStorage.setItem(DEMO_NARRATION_KEY, demoNarrationOn ? '1' : '0');
  };
}

$('startBtn').onclick = start;
$('stopBtn').onclick = stop;
$('demoBtn').onclick = startDemo;
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
