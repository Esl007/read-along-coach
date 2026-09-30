import puppeteer from 'puppeteer-core';
import path from 'node:path';
const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
for (const id of ['title','problem','fair','arch','value','close','cover']) {
  await page.goto('file://' + path.resolve('cards.html') + '#' + id, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate((id) => { const s = document.getElementById(id); return s.scrollHeight - s.clientHeight; }, id);
  await page.screenshot({ path: `cards/${id}.png` });
  console.log(id, 'overflow', overflow);
}
await browser.close();
