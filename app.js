import { PASSAGES, words } from '/src/passages.js';
import { align, wcpm, struggleWords, nextExpectedIndex } from '/src/aligner.js';
import { createPatience, State } from '/src/patience.js';
import { createReplay } from '/src/replay.js';
import { SESSIONS } from '/src/sessions/index.js';

const $ = (id) => document.getElementById(id);
const sel = $('passageSelect');
PASSAGES.forEach((p, i) => sel.add(new Option(`Level ${p.level} — ${p.title}`, i)));
const demoSel = $('demoSelect');
SESSIONS.forEach((s, i) => demoSel.add(new Option(s.title, i)));

let ws, audioCtx, workletNode, mediaStream, replay;
let heard = [];           // {text, confidence, start, end} accumulated finals
let refWords = [];
let patience, tickTimer, startedAt, helpCount = 0, lastNow = 0, activePassage = null;
let isLiveSession = false; // true only for the live-mic path, false for replay/demo
let userStopped = false;   // true once the user has clicked Finish for the live session

function renderPassage(ops = []) {
  const verdictByRef = new Map(ops.filter(o => o.refIndex !== undefined).map(o => [o.refIndex, o.verdict]));
  const nextIdx = nextExpectedIndex(ops);
  $('passage').innerHTML = refWords
    .map((w, i) => `<span class="w ${verdictByRef.get(i) || ''} ${i === nextIdx ? 'next' : ''}">${w}</span>`)
    .join(' ');
}

function refresh() {
  const ops = align(refWords, heard);
  renderPassage(ops);
  return ops;
}

// ── Shared pipeline: both live audio and replay feed these ──────────────────

function beginSession(passage) {
  activePassage = passage;
  refWords = words(passage);
  heard = []; helpCount = 0; lastNow = 0;
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
  if (s === State.WORKING) $('status').textContent = 'Take your time… 💪';
  else if (s === State.STALLED) {
    const ops = align(refWords, heard);
    const idx = nextExpectedIndex(ops);
    if (idx < refWords.length) {
      const word = refWords[idx].replace(/[^\w']/g, '');
      $('coach').textContent = `The next word is “${word}” — you've got this.`;
      speechSynthesis.speak(new SpeechSynthesisUtterance(word));
      helpCount++;
      patience.helped(now);
      setTimeout(() => { $('coach').textContent = ''; }, 4000);
    }
  } else $('status').textContent = 'Listening…';
}

function finishSession(elapsedMs) {
  $('startBtn').disabled = false; $('demoBtn').disabled = false; $('stopBtn').disabled = true;
  $('status').textContent = 'Session finished.';

  const ops = refresh();
  const scoreable = ops.filter(o => o.verdict !== 'unscorable' && o.op !== 'ins');
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

  saveSession({
    date: new Date().toISOString(),
    passageId: activePassage.id,
    wcpm: rWcpm,
    accuracy: rAcc,
    helps: helpCount,
    struggleWords: sw,
  });
  renderHistory();
}

// ── Live audio path ─────────────────────────────────────────────────────────

async function start() {
  isLiveSession = true;
  userStopped = false;
  beginSession(PASSAGES[sel.value]);
  $('status').textContent = 'Connecting…';

  const { token } = await (await fetch('/api/token')).json();
  ws = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&format_turns=false&token=${token}`);

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'Turn' && msg.words) {
      const now = performance.now() - startedAt;
      for (const w of msg.words) {
        // partials feed the patience machine as "effort"; only finals are scored
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
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
  audioCtx = new AudioContext({ sampleRate: 16000 });
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
  $('status').textContent = `Replaying “${session.title}”…`;
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
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-label="WCPM trend">` +
    `<polyline points="${pts.join(' ')}" fill="none" stroke="#d97706" stroke-width="2"/>` +
    pts.map(p => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="2.5" fill="#d97706"/>`).join('') +
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
