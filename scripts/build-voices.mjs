#!/usr/bin/env node
// Renders one spoken clip per unique vocabulary word across all passages and
// demo sessions, using Kokoro-82M neural TTS running locally on CPU.
//
// This is a BUILD-TIME script only. The app never shells out to a TTS engine,
// never calls a TTS API, and needs no API key: the clips are committed under
// voices/ and served as static files.
//
// ── WHY PRE-RENDERED CLIPS AT ALL ──────────────────────────────────────────
// Some browsers (headless Chrome, some Linux Chrome builds with no configured
// speech-dispatcher voices) report zero SpeechSynthesisVoices and every
// utterance fails with "synthesis-failed". app.js uses Web Speech when it
// actually works and falls back to these clips when it doesn't. The
// vocabulary is small and closed — only single reference words are ever
// spoken — so pre-rendering is cheap and the payload stays small.
//
// ── WHY KOKORO-82M ─────────────────────────────────────────────────────────
// This script previously drove the system `espeak-ng` binary, a formant
// synthesiser, and the clips sounded robotic. Kokoro (hexgrad/Kokoro-82M) is
// a real neural TTS model and was picked over the alternatives because:
//   * Apache-2.0 weights — unrestricted commercial use, no attribution
//     requirement. That matters: this is a public hackathon submission with
//     cash prizes, and ElevenLabs' free tier grants no commercial licence.
//   * Runs fully locally on CPU with NO API key. Weights download once from
//     HuggingFace at build time.
//   * 24 kHz output, 54 voices. We use af_heart — see the VOICE NOTES block
//     in scripts/synth_kokoro.py for why that one.
//
// ── DIVISION OF LABOUR ─────────────────────────────────────────────────────
// This file owns the two things that have to live in JS: deriving the
// vocabulary from the ESM modules src/passages.js and src/sessions/, and
// writing the voices/manifest.json contract that app.js fetches. The actual
// synthesis, silence-trimming, loudness-matching and encoding happen in
// scripts/synth_kokoro.py, which this spawns and talks to over stdin/stdout.
//
// The vocabulary is ALWAYS re-derived at run time. Never hardcode a word
// list here — passages and demo sessions get added, and a stale list means
// the coach silently has no clip for a new word.
//
// ── OUTPUT CONTRACT (app.js depends on this) ───────────────────────────────
//   voices/<word>.wav      one clip per vocabulary word, `word` already
//                          normalised to /[\w']+/ lowercase
//   voices/manifest.json   a bare JSON ARRAY of the words we have clips for.
//                          Must stay a bare array: app.js does
//                          `new Set(await res.json())`, so an object here
//                          throws, gets swallowed by its try/catch, and
//                          silently disables the whole clip fallback.
//   voices/build-info.json human/debug metadata (model, voice, sample rate,
//                          per-clip durations and sizes). Not read by the app.
//
// The extension is deliberately kept as .wav so no other file needs editing.
// `--format=mp3` / `--format=opus` shrink the payload roughly 10x but require
// a matching change to the `/voices/${key}.wav` URL in app.js.
//
// ── REPRODUCTION (no root needed; sudo is unavailable on the build box) ─────
//   python3 -m venv .venv
//   .venv/bin/pip install "kokoro>=0.9.2" soundfile
//   npm run build:voices
//
// .venv/ and the HuggingFace weight cache are gitignored. The rendered clips
// are committed, so a fresh clone needs none of the above to run the app.
//
// Usage: npm run build:voices [-- --voice=af_heart --speed=0.85 --format=wav]

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const voicesDir = path.join(root, 'voices');
const pythonBin = path.join(root, '.venv', 'bin', 'python');
const synthScript = path.join(__dirname, 'synth_kokoro.py');

const ALL_EXTS = ['wav', 'mp3', 'opus'];

function parseArgs(argv) {
  const opts = { voice: 'af_heart', speed: 0.85, ext: 'wav' };
  for (const arg of argv) {
    const m = /^--([\w-]+)=(.*)$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'voice') opts.voice = value;
    else if (key === 'speed') opts.speed = Number(value);
    else if (key === 'format' || key === 'ext') opts.ext = value.replace(/^\./, '');
    else throw new Error(`unknown option --${key}`);
  }
  if (!ALL_EXTS.includes(opts.ext)) {
    throw new Error(`--format must be one of ${ALL_EXTS.join(', ')} (got "${opts.ext}")`);
  }
  if (!Number.isFinite(opts.speed) || opts.speed <= 0) {
    throw new Error(`--speed must be a positive number (got "${opts.speed}")`);
  }
  return opts;
}

// Must match normalizeForClip() in app.js exactly, or the app will look up a
// key we never rendered a file for.
const normalize = (w) => String(w).replace(/[^\w']/g, '').toLowerCase();

async function collectVocabulary() {
  const { PASSAGES, words } = await import(path.join(root, 'src/passages.js'));
  const { SESSIONS } = await import(path.join(root, 'src/sessions/index.js'));
  const set = new Set();
  const add = (raw) => { const n = normalize(raw); if (n) set.add(n); };
  for (const p of PASSAGES) for (const w of words(p)) add(w);
  for (const s of SESSIONS) for (const e of s.events) if (e.text) add(e.text);
  return { words: [...set].sort(), passageCount: PASSAGES.length, sessionCount: SESSIONS.length };
}

function runSynth(request) {
  return new Promise((resolve, reject) => {
    if (!existsSync(pythonBin)) {
      reject(new Error(
        `No Python venv at ${pythonBin}.\n` +
        `Create it first (no root required):\n` +
        `  python3 -m venv .venv\n` +
        `  .venv/bin/pip install "kokoro>=0.9.2" soundfile`
      ));
      return;
    }
    const child = spawn(pythonBin, [synthScript], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`synth_kokoro.py exited ${code} (see output above)`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (err) {
        reject(new Error(`could not parse synth output as JSON: ${err.message}`));
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// Anything in voices/ with a clip extension that is not a current vocabulary
// word is stale — a renamed passage word, or a leftover from a previous run
// in a different format. Left in place it just inflates the committed payload.
function pruneOrphans(keep, ext) {
  const wanted = new Set(keep.map((w) => `${w}.${ext}`));
  const removed = [];
  for (const file of readdirSync(voicesDir)) {
    const fileExt = path.extname(file).slice(1).toLowerCase();
    if (!ALL_EXTS.includes(fileExt)) continue;
    if (wanted.has(file)) continue;
    unlinkSync(path.join(voicesDir, file));
    removed.push(file);
  }
  return removed;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(voicesDir, { recursive: true });

  const { words: vocabulary, passageCount, sessionCount } = await collectVocabulary();
  console.log(
    `Vocabulary: ${vocabulary.length} unique words derived from ` +
    `${passageCount} passages + ${sessionCount} demo sessions.`
  );
  console.log(`Rendering with Kokoro-82M voice "${opts.voice}" at speed ${opts.speed} -> .${opts.ext}`);

  const report = await runSynth({
    words: vocabulary,
    outDir: voicesDir,
    voice: opts.voice,
    speed: opts.speed,
    ext: opts.ext,
  });

  const rendered = new Set(report.clips.map((c) => c.word));
  const missing = vocabulary.filter((w) => !rendered.has(w));
  const removed = pruneOrphans(vocabulary, opts.ext);

  // manifest.json stays a bare array of words — see OUTPUT CONTRACT above.
  const manifest = vocabulary.filter((w) => rendered.has(w));
  writeFileSync(path.join(voicesDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const totalBytes = report.clips.reduce((n, c) => n + c.bytes, 0);
  const seconds = report.clips.map((c) => c.seconds);
  writeFileSync(
    path.join(voicesDir, 'build-info.json'),
    JSON.stringify(
      {
        generatedBy: 'scripts/build-voices.mjs + scripts/synth_kokoro.py',
        model: report.model,
        license: report.license,
        voice: report.voice,
        speed: report.speed,
        sampleRate: report.sampleRate,
        ext: report.ext,
        encoding: report.format,
        phonemizer: report.phonemizer,
        clipCount: report.clips.length,
        totalBytes,
        clips: report.clips,
      },
      null,
      2
    ) + '\n'
  );

  const files = readdirSync(voicesDir).filter((f) => f.endsWith(`.${opts.ext}`));
  console.log('');
  console.log(`Clips written:   ${report.clips.length}`);
  console.log(`Files on disk:   ${files.length} *.${opts.ext}`);
  console.log(`Manifest words:  ${manifest.length}`);
  console.log(`Orphans removed: ${removed.length}${removed.length ? ` (${removed.join(', ')})` : ''}`);
  console.log(`Total payload:   ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  if (seconds.length) {
    console.log(
      `Durations:       min ${Math.min(...seconds).toFixed(3)}s / ` +
      `max ${Math.max(...seconds).toFixed(3)}s / ` +
      `mean ${(seconds.reduce((a, b) => a + b, 0) / seconds.length).toFixed(3)}s`
    );
  }

  // A clip whose duration does not scale with word length usually means the
  // model produced silence or a truncated buffer, which is easy to miss when
  // you cannot listen to 100+ files. Surface it instead of shipping it.
  const suspicious = report.clips.filter((c) => c.seconds < 0.08);
  if (suspicious.length) {
    console.warn(`\nWARNING: ${suspicious.length} suspiciously short clip(s):`);
    for (const c of suspicious) console.warn(`  ${c.word} -> ${c.seconds}s`);
  }

  if (report.failures.length) {
    console.error(`\n${report.failures.length} word(s) FAILED to render:`);
    for (const f of report.failures) console.error(`  ${f.word}: ${f.error}`);
  }
  if (missing.length) {
    console.error(`\n${missing.length} vocabulary word(s) have no clip: ${missing.join(', ')}`);
  }
  if (report.failures.length || missing.length) process.exitCode = 1;

  if (opts.ext !== 'wav') {
    console.warn(
      `\nNOTE: clips were written as .${opts.ext}, but app.js hardcodes ` +
      `\`/voices/\${key}.wav\`. Update that URL or the fallback will 404.`
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
