// Records a real demo run of the app as timestamped frames + an audio-event log.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const OUT = process.argv[2] || 'rec';
const DEMO = process.argv[3] || '1';
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT + '/frames', { recursive: true });

const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'] });
const page = await browser.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1.2 });

// Audio log + caption overlay, installed before app.js runs.
await page.evaluateOnNewDocument(() => {
  window.__audioLog = [];
  const P = HTMLMediaElement.prototype, op = P.play, ou = P.pause;
  P.play = function (...a) {
    const el = this; window.__audioLog.push({ ev: 'play', src: el.currentSrc || el.src, at: Date.now(), from: el.currentTime });
    const end = () => window.__audioLog.push({ ev: 'stop', src: el.currentSrc || el.src, at: Date.now() });
    el.addEventListener('ended', end, { once: true });
    return op.apply(this, a);
  };
  P.pause = function (...a) { window.__audioLog.push({ ev: 'stop', src: this.currentSrc || this.src, at: Date.now() }); return ou.apply(this, a); };
  window.__captions = [];
  // Queue: every caption gets at least 2.4s on screen, so two events that
  // land in the same instant are both readable.
  window.__capQ = []; window.__capBusyUntil = 0;
  window.__setCaption = (text) => {
    window.__capQ.push(text);
    const pump = () => {
      const now = Date.now();
      if (now < window.__capBusyUntil) { setTimeout(pump, window.__capBusyUntil - now); return; }
      if (!window.__capQ.length) return;
      window.__showCaption(window.__capQ.shift());
      window.__capBusyUntil = Date.now() + 2400;
      if (window.__capQ.length) setTimeout(pump, 2400);
    };
    pump();
  };
  window.__showCaption = (text) => {
    let el = document.getElementById('__cap');
    if (!el) {
      el = document.createElement('div'); el.id = '__cap';
      el.style.cssText = 'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:999;max-width:1100px;padding:16px 28px 16px 24px;border-radius:18px;background:#1B2330;color:#FFFDF8;font:700 26px/1.35 "Atkinson Hyperlegible",sans-serif;box-shadow:0 18px 40px -18px rgba(27,35,48,.7);display:flex;gap:14px;align-items:center;transition:opacity .25s';
      document.body.appendChild(el);
    }
    el.innerHTML = '<span style="width:12px;height:12px;border-radius:50%;background:#FFE27A;flex-shrink:0"></span><span></span>';
    el.lastChild.textContent = text; el.style.opacity = text ? '1' : '0';
    window.__captions.push({ text, at: Date.now() });
  };
});

await page.goto('http://localhost:3000/', { waitUntil: 'networkidle0' });
if (process.argv[4] === 'warm') {
  await page.select('#demoSelect', '0');
  await page.click('#demoBtn');
  await page.waitForFunction(() => window.__racSession && !window.__racSession.active && document.getElementById('report').style.display === 'block', { timeout: 120000, polling: 250 });
  await page.reload({ waitUntil: 'networkidle0' });
}
await page.evaluate(() => { window.__audioLog = []; window.__captions = []; });
await page.evaluate(() => document.fonts.ready);
await page.select('#demoSelect', DEMO);

// Caption driver: reacts to the app's own state, never to a script of times.
await page.evaluate(() => {
  const seen = new Set();
  const once = (k, t) => { if (!seen.has(k)) { seen.add(k); window.__setCaption(t); } };
  new MutationObserver(() => {
    const tone = document.getElementById('status').dataset.tone;
    if (tone === 'work') { window.__workN = (window.__workN || 0) + 1; if (window.__workN <= 2) once('work' + window.__workN, window.__workN === 1 ? 'Sounding it out (“ca…”) earns extra time — the coach keeps waiting.' : 'Sounding it out again (“wa…”). Still waiting, patiently.'); }
    if (tone === 'help') once('help', 'A genuine stall. The coach says one word, then steps back.');
    if (tone === 'done') once('done', 'Finished. The score only arrives at the end.');
  }).observe(document.getElementById('status'), { attributes: true, childList: true, subtree: true });
  new MutationObserver(() => {
    if (document.querySelector('#passage .w.substituted')) once('sub', 'Heard “run” for “ran” — marked as a different word, not skipped.');
    if (document.querySelector('#passage .w.skipped')) once('skip', '“big” was never read — marked skipped.');
    const unk = [...document.querySelectorAll('#passage .w.unscorable')].some(e => e.textContent === 'move.');
    if (unk) once('unk', 'AssemblyAI was unsure about “move” — grey means never counted as wrong.');
  }).observe(document.getElementById('passage'), { attributes: true, subtree: true });
});

const cdp = await page.createCDPSession();
const frames = [];
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  const i = frames.length; const f = `${OUT}/frames/${String(i).padStart(5, '0')}.jpg`;
  fs.writeFileSync(f, Buffer.from(data, 'base64')); frames.push({ f, t: metadata.timestamp });
  cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
const t0 = Date.now();
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
await new Promise(r => setTimeout(r, 1500));
await page.evaluate(() => window.__setCaption('A recorded halting early reader. The highlight follows the voice.'));
await page.click('#demoBtn');
const clickAt = Date.now();

// Wait for the session to finish (auto-finish), with a hard cap.
await page.waitForFunction(() => window.__racSession && !window.__racSession.active && document.getElementById('report').style.display === 'block', { timeout: 120000, polling: 250 });
const doneAt = Date.now();
await new Promise(r => setTimeout(r, 2200));
await page.evaluate(() => { window.__setCaption(''); document.getElementById('report').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
await new Promise(r => setTimeout(r, 5000));
await cdp.send('Page.stopScreencast');
const endAt = Date.now();

const state = await page.evaluate(() => ({
  audioLog: window.__audioLog, captions: window.__captions,
  report: { wcpm: rWcpm.textContent, acc: rAcc.textContent, help: rHelp.textContent, struggle: rStruggle.textContent },
  supplied: [...document.querySelectorAll('#passage .w.supplied')].map(e => e.textContent),
  classes: ['correct','substituted','skipped','unscorable','supplied'].map(c => [c, document.querySelectorAll('#passage .w.' + c).length]),
  history: document.querySelectorAll('#historyBody tr').length,
}));
fs.writeFileSync(`${OUT}/log.json`, JSON.stringify({ t0, clickAt, doneAt, endAt, frames, errs, ...state }, null, 1));
console.log(JSON.stringify({ frames: frames.length, seconds: (endAt - t0) / 1000, errs, report: state.report, supplied: state.supplied, classes: state.classes, plays: state.audioLog.filter(e => e.ev === 'play').length, captions: state.captions.map(c => c.text) }, null, 1));
await browser.close();
