import puppeteer from 'puppeteer-core';
import path from 'node:path';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox','--allow-file-access-from-files'] });
const p = await b.newPage();
await p.goto('file://' + path.resolve('deck.html'), { waitUntil: 'networkidle0' });
await p.pdf({ path: 'read-along-coach-deck.pdf', width: '1920px', height: '1080px', printBackground: true, pageRanges: '' });
await b.close(); console.log('pdf ok');
