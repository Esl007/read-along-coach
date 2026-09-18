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
let heard = [];           // {text, confidence, start, end} accumulated finals
let refWords = [];
let transcript;           // live-mic only: turn-replacement accumulator (defect 2)
let patience, tickTimer, startedAt, helpCount = 0, lastNow = 0, activePassage = null;
let isLiveSession = false; // true only for the live-mic path, false for replay/demo
let userStopped = false;   // true once the user has clicked Finish for the live session

// Real-time demo replay used to give no visible sign of activity beyond a
// static status line for up to ~20-30 real seconds, which reads as "frozen"
// to anyone watching. Show a small pulsing "▶ Playing…" badge alongside the
// status text for the duration of a replay so it's obvious something is
// still happening. Live-mic sessions are untouched — this only appears when
// a replay is running.
// ── Text-to-speech: checked progressive enhancement (defect 4) ─────────────
// speechSynthesis.getVoices() is frequently empty until the async
// 'voiceschanged' event fires (measured directly: 0 voices available at
// script-load time in this browser). Calling .speak() with no voices loaded
// is a silent no-op — nothing plays and nothing errors. So: track whether a
// voice is actually available, update that on 'voiceschanged', and only
// attempt speech when we know a voice exists. The on-screen $('coach')
// message (set by the caller before speak() runs) is the primary channel
// and works regardless of whether TTS is available.
let ttsAvailable = typeof speechSynthesis !== 'undefined' && speechSynthesis.getVoices().length > 0;
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener('voiceschanged', () => {
    ttsAvailable = speechSynthesis.getVoices().length > 0;
  });
}
function speak(word) {
  if (!ttsAvailable) return; // on-screen coach message already covers this case
  speechSynthesis.speak(new SpeechSynthesisUtterance(word));
}

function setStatus(text, { playing = false } = {}) {
  $('status').innerHTML = playing
    ? `<span class="playing"><span class="dot"></span>▶ Playing…</span> ${text}`
    : text;
}

function renderPassage(ops = []) {
  // 'pending' (not-yet-reached) ops render with no verdict class at all —
  // neutral/unstyled, never the struck-through 'skipped' look.
  const verdictByRef = new Map(
    ops.filter(o => o.refIndex !== undefined && o.verdict !== 'pending').map(o => [o.refIndex, o.verdict])
  );
  const nextIdx = nextExpectedIndex(ops);
  $('passage').innerHTML = refWords
    .map((w, i) => `<span class="w ${verdictByRef.get(i) || ''} ${i === nextIdx ? 'next' : ''}">${w}</span>`)
    .join(' ');
}

// Live rendering/progress MUST use alignPrefix (semi-global, free end-gap),
// not the global align() — see src/aligner.js. align() forces the traceback
// to end at the last reference word, which drags the highlight to the end of
// the passage on partial transcripts (defect 1).
function refresh() {
  const ops = alignPrefix(refWords, heard);
  renderPassage(ops);
  return ops;
}

// ── Shared pipeline: both live audio and replay feed these ──────────────────

function beginSession(passage) {
  activePassage = passage;
  refWords = words(passage);
  heard = []; helpCount = 0; lastNow = 0;
  transcript = createTranscript();
  patience = createPatience();
  renderPassage();
  $('report').style.display = 'none';
  $('startBtn').disabled = true; $('demoBtn').disabled = true; $('stopBtn').disabled = false;
}

function onWordEvent(word, now) {
  lastNow = Math.max(lastNow, now);
  if (word.final !== false) heard.push(word); // final:false fragments only feed patience
  patience.onWord(word, now);
  refresh();
}

function onTick(now) {
  lastNow = Math.max(lastNow, now);
  const s = patience.tick(now);
  if (s === State.WORKING) setStatus('Take your time… 💪', { playing: !isLiveSession });
  else if (s === State.STALLED) {
    const ops = alignPrefix(refWords, heard);
    const idx = nextExpectedIndex(ops);
    if (idx < refWords.length) {
      const word = refWords[idx].replace(/[^\w']/g, '');
      // The on-screen coach message is the primary, always-present channel;
      // TTS is a checked progressive enhancement layered on top (defect 4).
      $('coach').textContent = `The next word is “${word}” — you've got this.`;
      speak(word);
      helpCount++;
      patience.helped(now);
      setTimeout(() => { $('coach').textContent = ''; }, 6500);
    }
  } else setStatus('Listening…', { playing: !isLiveSession });
}

function finishSession(elapsedMs) {
  $('startBtn').disabled = false; $('demoBtn').disabled = false; $('stopBtn').disabled = true;
  $('status').textContent = 'Session finished.';

  // End-of-session scoring also uses the prefix alignment (via refresh()):
  // a reader who stops halfway sees the unread tail as 'pending' ("not
  // reached"), never as 'skipped'. Words genuinely skipped within the span
  // actually read still count as 'skipped'. 'pending' is excluded from every
  // denominator below (defect 1).
  const ops = refresh();
  const scoreable = ops.filter(o => o.verdict !== 'unscorable' && o.verdict !== 'pending' && o.op !== 'ins');
  const correct = ops.filter(o => o.verdict === 'correct').length;
  const rWcpm = wcpm(ops, elapsedMs);
  const rAcc = scoreable.length ? Math.round(100 * correct / scoreable.length) : null;
  $('rWcpm').textContent = rWcpm;
  $('rAcc').textContent = rAcc !== null ? rAcc + '%' : '–';
  $('rHelp').textContent = helpCount;
  const sw = struggleWords(ops, refWords);
  if (isLiveSession && heard.length === 0) {
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
      const now = performance.now() - startedAt;
      // AssemblyAI v3 Turn.words is CUMULATIVE — each message re-sends every
      // word currently in the turn (finals + a revisable non-final tail),
      // not just new words. `transcript` replaces (never appends) per
      // turn_order and hands back only the genuinely new/newly-final words,
      // so each real word reaches the shared pipeline exactly once (defect 2).
      const { added } = transcript.applyTurn(msg);
      for (const w of added) {
        onWordEvent({ text: w.text, confidence: w.confidence ?? 0.9, start: w.start, end: w.end, final: !!w.word_is_final }, now);
      }
    }
  };
  ws.onopen = async () => {
    $('status').textContent = 'Listening… read out loud!';
    startedAt = performance.now();
    tickTimer = setInterval(() => onTick(performance.now() - startedAt), 250);
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
    onWord: onWordEvent,
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

$('startBtn').onclick = start;
$('stopBtn').onclick = stop;
$('demoBtn').onclick = startDemo;
sel.onchange = () => { refWords = words(PASSAGES[sel.value]); renderPassage(); };
refWords = words(PASSAGES[0]); renderPassage();
renderHistory();
