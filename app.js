import { PASSAGES, words } from '/src/passages.js';
import { align, alignPrefix, wcpm, struggleWords, nextExpectedIndex } from '/src/aligner.js';
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
let patience, tickTimer, startedAt, helpCount = 0, lastNow = 0, activePassage = null;
let lastKnownStreamEnd = 0;       // live-mic only: last word.end we've seen (stream-clock ms)
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
let userStopped = false;   // true once the user has clicked Finish for the live session

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

function setStatus(text, { playing = false } = {}) {
  $('status').innerHTML = playing
    ? `<span class="playing"><span class="dot"></span>▶ Playing…</span> ${text}`
    : text;
}

function renderPassage(ops = []) {
  // 'pending' (not-yet-reached) ops render with no verdict class at all —
  // neutral/unstyled, never the struck-through 'skipped' look. Words backed
  // by a still-provisional (non-final) ASR word get an extra 'provisional'
  // class — a subtly reduced-opacity style so the UI stays honest that this
  // leading edge may still be revised, without looking like an error state.
  const verdictByRef = new Map(
    ops.filter(o => o.refIndex !== undefined && o.verdict !== 'pending').map(o => [o.refIndex, o.verdict])
  );
  const provisionalRef = new Set(
    ops.filter(o => o.refIndex !== undefined && o.word && o.word.word_is_final === false).map(o => o.refIndex)
  );
  const nextIdx = nextExpectedIndex(ops);
  $('passage').innerHTML = refWords
    .map((w, i) => `<span class="w ${verdictByRef.get(i) || ''} ${provisionalRef.has(i) ? 'provisional' : ''} ${i === nextIdx ? 'next' : ''}">${w}</span>`)
    .join(' ');
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
//   - RENDER (the live highlight, refresh()) uses transcript.words() — every
//     currently-known word, finalized AND provisional — so it tracks the
//     reader in real time.
//   - SCORE (WCPM, accuracy, struggle words) uses transcript.finalWords() —
//     authoritative only, never scored off text that may still be revised.
// Because provisional words can be REVISED (not just appended), the render
// list is rebuilt from the transcript on every event rather than
// incrementally pushed onto an array — otherwise a revised word would leave
// its stale prior guess sitting in the list forever.
//
// Live rendering/progress MUST use alignPrefix (semi-global, free end-gap),
// not the global align() — see src/aligner.js. align() forces the traceback
// to end at the last reference word, which drags the highlight to the end of
// the passage on partial transcripts (defect 1).
function refresh() {
  const ops = alignPrefix(refWords, transcript.words());
  renderPassage(ops);
  return ops;
}

// ── Shared pipeline: both live audio and replay feed these ──────────────────

function beginSession(passage) {
  activePassage = passage;
  refWords = words(passage);
  helpCount = 0; lastNow = 0;
  transcript = createTranscript();
  patience = createPatience();
  renderPassage();
  $('report').style.display = 'none';
  $('startBtn').disabled = true; $('demoBtn').disabled = true; $('stopBtn').disabled = false;
}

// Shared word-event handler for BOTH the live path and the replay path. The
// live path calls this per newly-relevant word from transcript.applyTurn()
// (see ws.onmessage); the replay path calls it after registering the word
// via transcript.addWord() (see startDemo()) — both converge here so
// alignment/rendering/scoring is one pipeline regardless of source.
function onWordEvent(word, now) {
  lastNow = Math.max(lastNow, now);
  patience.onWord(word, now);
  refresh();
}

function onTick(now) {
  lastNow = Math.max(lastNow, now);
  const s = patience.tick(now);
  if (s === State.WORKING) setStatus('Take your time… 💪', { playing: !isLiveSession });
  else if (s === State.STALLED) {
    const ops = alignPrefix(refWords, transcript.words());
    const idx = nextExpectedIndex(ops);
    if (idx < refWords.length) {
      const word = refWords[idx].replace(/[^\w']/g, '');
      // The on-screen coach message is the primary, always-present channel;
      // TTS is a checked progressive enhancement layered on top (defect 4).
      $('coach').textContent = `The next word is “${word}” — you've got this.`;
      speak(word, { priority: true }); // always pre-empts demo narration, if any
      helpCount++;
      patience.helped(now);
      setTimeout(() => { $('coach').textContent = ''; }, 6500);
    }
  } else setStatus('Listening…', { playing: !isLiveSession });
}

function finishSession(elapsedMs) {
  $('startBtn').disabled = false; $('demoBtn').disabled = false; $('stopBtn').disabled = true;
  $('status').textContent = 'Session finished.';

  // Render one last time off the full (render) view so the passage doesn't
  // visually strip out a still-provisional trailing word the instant the
  // session ends.
  refresh();

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
  isLiveSession = true;
  userStopped = false;
  beginSession(PASSAGES[sel.value]);
  $('status').textContent = 'Connecting…';

  const { token } = await (await fetch('/api/token')).json();

  // Request a 16kHz AudioContext, but the requested rate is only advisory —
  // browsers (notably Firefox/Safari) may silently ignore it and hand back
  // their own default (measured 48000 here). If we declared 16000 to
  // AssemblyAI while actually sending 48kHz PCM, transcription would be
  // silently garbage with no error surfaced anywhere. So: create the context
  // first, read back its ACTUAL sampleRate, and use that value — never the
  // requested one — for both the mic pipeline and the WebSocket URL (defect 3).
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
  audioCtx = new AudioContext({ sampleRate: 16000 });
  const actualSampleRate = audioCtx.sampleRate;

  ws = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?sample_rate=${actualSampleRate}&format_turns=false&token=${token}`);

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
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
        const now = w.end;
        lastKnownStreamEnd = Math.max(lastKnownStreamEnd, now);
        lastKnownStreamEndWallAt = performance.now();
        onWordEvent({ ...w, confidence: w.confidence ?? 0.9 }, now);
      }
    }
  };
  ws.onopen = async () => {
    $('status').textContent = 'Listening… read out loud!';
    startedAt = performance.now();
    lastKnownStreamEnd = 0;
    lastKnownStreamEndWallAt = performance.now();
    // Periodic tick: advance an ESTIMATED stream clock — last known word end
    // plus wall time elapsed since that word arrived — rather than raw wall
    // clock since session start. This keeps the periodic STALLED check on
    // the same time base as word events, instead of racing ahead of them by
    // the streaming latency.
    tickTimer = setInterval(() => onTick(estimatedStreamNow()), 250);
    await startMic();
  };
  ws.onerror = () => { $('status').textContent = 'Connection error — is the server running with an API key?'; };
  ws.onclose = (e) => {
    // AssemblyAI may accept the connection but then close it (e.g. invalid/
    // expired token) without ever firing onerror. If that happens before the
    // user intentionally clicked Finish, surface it instead of failing silently.
    if (!userStopped) {
      $('status').textContent = 'Connection closed unexpectedly — check your microphone and API key setup.';
    }
  };
}

async function startMic() {
  // mediaStream and audioCtx are already created in start() so their actual
  // sampleRate could be read back before opening the WebSocket (defect 3).
  await audioCtx.audioWorklet.addModule('/pcm-worklet.js');
  const src = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, 'pcm-writer');
  workletNode.port.onmessage = (e) => { if (ws?.readyState === 1) ws.send(e.data); };
  src.connect(workletNode);
}

function stop() {
  if (replay?.running) { replay.stop(); replay = null; finishSession(lastNow); return; }
  userStopped = true;
  clearInterval(tickTimer);
  ws?.close(); mediaStream?.getTracks().forEach(t => t.stop()); audioCtx?.close();
  finishSession(performance.now() - startedAt);
}

// ── Replay path (demo without a mic or API key) ─────────────────────────────

function startDemo() {
  isLiveSession = false;
  const session = SESSIONS[demoSel.value];
  const passage = PASSAGES.find(p => p.id === session.passageId);
  sel.value = PASSAGES.indexOf(passage);
  beginSession(passage);
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
    onEnd: () => { replay = null; finishSession(lastNow); },
  });
  replay.start();
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
sel.onchange = () => { refWords = words(PASSAGES[sel.value]); renderPassage(); };
refWords = words(PASSAGES[0]); renderPassage();
renderHistory();
