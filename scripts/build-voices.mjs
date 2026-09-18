#!/usr/bin/env node
// Generates one small WAV clip per unique vocabulary word across all
// passages and demo sessions, using the system `espeak-ng` binary. This is a
// BUILD-TIME script only — the app itself never shells out to espeak-ng or
// any other binary at runtime. The generated clips are committed under
// voices/ so the app works with zero native dependencies.
//
// Why pre-rendered clips instead of relying on the Web Speech API: some
// browsers (headless Chrome, some Linux Chrome builds with no configured
// speech-dispatcher voices) report zero SpeechSynthesisVoices and every
// utterance fails with a "synthesis-failed" error. Web Speech is used as the
// primary path when it actually works (better prosody, zero payload), and
// these clips are the fallback when it doesn't. The vocabulary is small and
// closed — only single reference words are ever spoken — so pre-rendering
// is cheap and the payload stays tiny.
//
// Usage: npm run build:voices
// Requires `espeak-ng` on PATH (apt install espeak-ng / brew install espeak-ng).

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const voicesDir = path.join(root, 'voices');

async function collectVocabulary() {
  const { PASSAGES, words } = await import(path.join(root, 'src/passages.js'));
  const { SESSIONS } = await import(path.join(root, 'src/sessions/index.js'));
  const set = new Set();
  const norm = (w) => w.replace(/[^\w']/g, '').toLowerCase();
  for (const p of PASSAGES) for (const w of words(p)) { const n = norm(w); if (n) set.add(n); }
  for (const s of SESSIONS) for (const e of s.events) { if (e.text) { const n = norm(e.text); if (n) set.add(n); } }
  return [...set].sort();
}

function safeFilename(word) {
  // Words are already normalized to [\w'] by the caller; encode as-is since
  // that character set is filesystem-safe on every platform we care about.
  return `${word}.wav`;
}

function main() {
  mkdirSync(voicesDir, { recursive: true });
  const vocabulary = collectVocabulary();
  vocabulary.then((words) => {
    console.log(`Building ${words.length} voice clips into ${voicesDir} ...`);
    const manifest = [];
    for (const word of words) {
      const out = path.join(voicesDir, safeFilename(word));
      try {
        execFileSync('espeak-ng', [
          '-v', 'en-us+f3',   // clearer/less-robotic female en-us variant
          '-s', '150',        // slower rate — matches app's slowed-down TTS intent
          '-w', out,
          word,
        ], { stdio: 'inherit' });
        manifest.push(word);
      } catch (err) {
        console.error(`Failed to render "${word}":`, err.message);
        process.exitCode = 1;
      }
    }
    writeFileSync(path.join(voicesDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const files = readdirSync(voicesDir).filter(f => f.endsWith('.wav'));
    console.log(`Done. ${files.length} clips written.`);
  });
}

main();
