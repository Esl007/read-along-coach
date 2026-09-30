// Transparent overlay PNGs for the framed demo: window frame, captions, speaker chips.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const L = JSON.parse(fs.readFileSync(process.argv[2] + '/log.json', 'utf8'));
fs.mkdirSync('ov', { recursive: true });
const FONT = `<link href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap" rel="stylesheet">`;
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const p = await b.newPage();
async function shot(html, w, h, out) {
  await p.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await p.setContent(`<!doctype html><html><head>${FONT}<style>html,body{margin:0;background:transparent}</style></head><body>${html}</body></html>`, { waitUntil: 'load', timeout: 20000 });
  await p.evaluate(async () => { await document.fonts.load("700 34px 'Atkinson Hyperlegible'"); await document.fonts.ready; });
  await p.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
}
// ink everywhere except a rounded 1600x900 window at (160, 28)
await shot(`<div style="position:absolute;left:160px;top:28px;width:1600px;height:900px;border-radius:22px;box-shadow:0 0 0 3000px #1B2330"></div>`, 1920, 1080, 'ov/frame.png');
const caps = L.captions.filter(c => c.text);
for (const [i, c] of caps.entries()) {
  const t = c.text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  await shot(`<div style="height:140px;display:flex;align-items:center;gap:18px;font:700 34px/1.3 'Atkinson Hyperlegible',sans-serif;color:#FFFDF8">
    <span style="width:14px;height:14px;border-radius:50%;background:#FFE27A;flex-shrink:0"></span><span>${t}</span></div>`, 1180, 140, `ov/cap${i}.png`);
}
const chip = (label, sub, bg, ink, bars) => `<div style="height:84px;display:flex;align-items:center;justify-content:flex-end">
  <div style="display:inline-flex;align-items:center;gap:16px;padding:14px 26px 14px 20px;border-radius:999px;background:${bg};color:${ink};font:700 28px 'Atkinson Hyperlegible',sans-serif">
    <span style="display:flex;align-items:center;gap:4px;height:30px">${bars.map(h => `<span style="width:5px;height:${h}px;border-radius:3px;background:${ink}"></span>`).join('')}</span>
    <span>${label}<span style="font-weight:400;opacity:.8"> · ${sub}</span></span></div></div>`;
await shot(chip('Reader', 'child, recorded', '#FFE5C4', '#8A4300', [12, 24, 16, 28, 10]), 420, 84, 'ov/chip-reader.png');
await shot(chip('Coach', 'says one word', '#FFE27A', '#1B2330', [14, 28, 20, 26, 12]), 420, 84, 'ov/chip-coach.png');
await b.close();
console.log('captions:', caps.length);
