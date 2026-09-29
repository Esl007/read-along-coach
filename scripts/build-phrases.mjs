#!/usr/bin/env node
// Renders one spoken clip per PHRASE across all demo sessions, using
// Kokoro-82M neural TTS running locally on CPU.
//
// This is a BUILD-TIME script only. The app never shells out to a TTS engine
// and needs no API key: the clips are committed under voices/phrases/ and
// served as static files.
//
// ── WHY PHRASES AND NOT WORDS ──────────────────────────────────────────────
// scripts/build-voices.mjs renders the single-word vocabulary clips — the
// coach's "the word is ___" prompts, where an isolated pronunciation is
// exactly what you want. This script solves the opposite problem: the demo
// *narration*, which is a person reading a sentence. Read the header comment
// of src/phrases.js for the full argument; the short version is that the
// prosody of a sentence is not recoverable from a concatenation of its words,
// so the synthesis unit has to be the phrase. Accordingly this script calls
// the model ONCE PER PHRASE with the whole phrase text. It must never loop
// over words — that is the bug it exists to fix.
//
// ── SAME VOICE AS THE WORD CLIPS ───────────────────────────────────────────
// VOICE/SPEED below are pinned to the same values build-voices.mjs uses
// (af_heart @ 0.85). The narrator and the coach are supposed to be audibly
// the same person; if these drift apart, the demo sounds like two speakers.
//
// ── DIVISION OF LABOUR ─────────────────────────────────────────────────────
// This file owns the phrase derivation (it must — the grouping lives in the
// ESM module src/phrases.js) and the voices/phrases/manifest.json contract.
// Synthesis, silence-trimming, loudness-matching and encoding happen in
// scripts/synth_kokoro.py, which this spawns and talks to over stdin/stdout.
//
// The phrase list is ALWAYS re-derived at run time from src/sessions/ via
// allPhrases(). Never hardcode it: sessions get edited, and a stale list means
// the narrator silently has no clip for part of a demo.
//
// ── OUTPUT CONTRACT (the player depends on this) ───────────────────────────
//   voices/phrases/<id>.wav     one clip per phrase; <id> is phrase.id from
//                               src/phrases.js, stable across regeneration.
//   voices/phrases/manifest.json
//                               an OBJECT keyed by phrase id:
//                                 { "<id>": { file, seconds, text } }
//                               `seconds` is required — the player uses it to
//                               schedule clips serially without overlap.
//
// Note this is an object, unlike voices/manifest.json which must stay a bare
// array (app.js does `new Set(await res.json())` on that one). Different file,
// different consumer, different shape.
//
// ── THE MANIFEST IS BUILT FROM DISK, NOT FROM INTENT ───────────────────────
// A manifest that lists a clip which does not exist, or omits one that does,
// has already broken this project once. So after rendering we walk
// voices/phrases/, stat every .wav, and read each file's REAL duration and
// sample rate out of its RIFF header. The synth's own report is used only to
// cross-check and to explain failures — never as the source of truth for what
// shipped. Any disagreement is a hard failure with a non-zero exit code.
//
// ── REPRODUCTION (no root needed) ──────────────────────────────────────────
//   python3 -m venv .venv
//   .venv/bin/pip install "kokoro>=0.9.2" soundfile
//   npm run build:phrases
//
// Usage: npm run build:phrases [-- --voice=af_heart --speed=0.85]

import { spawn } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractLastJsonObject } from './synth-report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'voices', 'phrases');
const pythonBin = path.join(root, '.venv', 'bin', 'python');
const synthScript = path.join(__dirname, 'synth_kokoro.py');

// Pinned to match scripts/build-voices.mjs. See "SAME VOICE" above.
const VOICE = 'af_heart';
const SPEED = 0.85;
const EXT = 'wav';
const EXPECTED_SAMPLE_RATE = 24000; // Kokoro's native rate. 22050 would mean
                                    // espeak was used by mistake.

function parseArgs(argv) {
  const opts = { voice: VOICE, speed: SPEED };
  for (const arg of argv) {
    const m = /^--([\w-]+)=(.*)$/.exec(arg);
    if (!m) throw new Error(`unrecognised argument "${arg}"`);
    const [, key, value] = m;
    if (key === 'voice') opts.voice = value;
    else if (key === 'speed') opts.speed = Number(value);
    else throw new Error(`unknown option --${key}`);
  }
  if (!Number.isFinite(opts.speed) || opts.speed <= 0) {
    throw new Error(`--speed must be a positive number (got "${opts.speed}")`);
  }
  return opts;
}

// ── talking to the python ───────────────────────────────────────────────────

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
    // stderr is inherited so the user sees live progress; we read stdout only.
    const child = spawn(pythonBin, [synthScript], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const report = extractLastJsonObject(out);

      // Fail LOUDLY, with the raw bytes, and never pretend success.
      if (code !== 0 || signal) {
        reject(new Error(
          `synth_kokoro.py exited ${signal ? `on signal ${signal}` : `with code ${code}`}.\n` +
          `--- raw stdout (${out.length} bytes) ---\n${out || '(empty)'}\n--- end raw stdout ---`
        ));
        return;
      }
      if (!report) {
        reject(new Error(
          `synth_kokoro.py exited 0 but produced no parseable JSON object on stdout.\n` +
          `--- raw stdout (${out.length} bytes) ---\n${out || '(empty)'}\n--- end raw stdout ---`
        ));
        return;
      }
      if (!Array.isArray(report.clips)) {
        reject(new Error(
          `synth_kokoro.py returned JSON without a "clips" array.\n` +
          `--- parsed ---\n${JSON.stringify(report).slice(0, 2000)}\n--- end parsed ---`
        ));
        return;
      }
      resolve(report);
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// ── reading what is actually on disk ────────────────────────────────────────

/**
 * Read duration, sample rate and channel count out of a RIFF/WAVE header.
 *
 * Deliberately independent of the synth's report: this is how we learn what
 * actually shipped. Also our only check that the file is a real 24 kHz wav
 * and not a truncated write or an espeak-era 22.05 kHz leftover.
 */
function readWavInfo(file) {
  const buf = readFileSync(file);
  if (buf.length < 12) throw new Error(`${path.basename(file)}: file is ${buf.length} bytes, not a wav`);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path.basename(file)}: missing RIFF/WAVE header`);
  }

  let sampleRate = null;
  let channels = null;
  let bitsPerSample = null;
  let dataBytes = null;

  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // Trust the smaller of the declared size and what is really there, so a
      // truncated file reports its true (short) duration instead of its
      // intended one.
      dataBytes = Math.min(size, Math.max(0, buf.length - body));
      if (dataBytes !== size) {
        throw new Error(
          `${path.basename(file)}: data chunk declares ${size} bytes but only ` +
          `${dataBytes} are present — file is truncated`
        );
      }
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }

  if (!sampleRate || !channels || !bitsPerSample || dataBytes == null) {
    throw new Error(`${path.basename(file)}: incomplete wav header (no fmt or no data chunk)`);
  }
  const frameBytes = channels * (bitsPerSample / 8);
  if (frameBytes <= 0) throw new Error(`${path.basename(file)}: nonsensical wav format`);

  return {
    sampleRate,
    channels,
    bitsPerSample,
    frames: Math.floor(dataBytes / frameBytes),
    seconds: Math.floor(dataBytes / frameBytes) / sampleRate,
    bytes: statSync(file).size,
  };
}

/** Clips in voices/phrases/ that no current phrase id claims are stale. */
function pruneOrphans(keepIds) {
  const wanted = new Set([...keepIds].map((id) => `${id}.${EXT}`));
  const removed = [];
  for (const file of readdirSync(outDir)) {
    if (!file.toLowerCase().endsWith(`.${EXT}`)) continue;
    if (wanted.has(file)) continue;
    unlinkSync(path.join(outDir, file));
    removed.push(file);
  }
  return removed;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const { SESSIONS } = await import(path.join(root, 'src/sessions/index.js'));
  const { allPhrases, PHRASE_STALL_MS, PHRASE_MAX_WORDS } =
    await import(path.join(root, 'src/phrases.js'));

  const phrases = allPhrases(SESSIONS);
  if (!phrases.length) throw new Error('allPhrases() returned nothing — refusing to write an empty manifest');

  const byId = new Map(phrases.map((p) => [p.id, p]));
  if (byId.size !== phrases.length) {
    throw new Error(`allPhrases() returned duplicate ids (${phrases.length} phrases, ${byId.size} unique)`);
  }

  const wordCount = phrases.reduce((n, p) => n + p.indices.length, 0);
  console.log(
    `Phrases: ${phrases.length} across ${SESSIONS.length} demo sessions ` +
    `(${wordCount} word events; clause boundaries and stalls >= ${PHRASE_STALL_MS}ms split, ` +
    `max ${PHRASE_MAX_WORDS} words/phrase).`
  );
  console.log(
    `Rendering ONE UTTERANCE PER PHRASE with Kokoro-82M voice "${opts.voice}" at speed ${opts.speed}.`
  );

  mkdirSync(outDir, { recursive: true });

  const report = await runSynth({
    phrases: phrases.map((p) => ({ id: p.id, text: p.text })),
    outDir,
    voice: opts.voice,
    speed: opts.speed,
    ext: EXT,
  });

  const removed = pruneOrphans(byId.keys());

  // ── Build the manifest from disk. ────────────────────────────────────────
  const onDisk = readdirSync(outDir)
    .filter((f) => f.toLowerCase().endsWith(`.${EXT}`))
    .sort();

  const manifest = {};
  const problems = [];
  const badRate = [];
  let totalBytes = 0;

  // ── Per-word timings: validate coverage, never half-adopt. ───────────────
  // src/narration.js prefers real per-word offsets and falls back to weighting
  // by character count. That fallback is fine, but it has to be VISIBLE: a
  // manifest that silently carries timings for some clips and not others is
  // exactly the kind of half-state that hides a regression. So every entry is
  // checked against the phrase's own word count and the clip's real duration,
  // a rejected entry is reported with its reason, and the counts are printed.
  const synthWords = new Map(report.clips.map((c) => [c.id, c]));
  const timingRejected = [];

  for (const file of onDisk) {
    const id = file.slice(0, -(EXT.length + 1));
    const phrase = byId.get(id);
    if (!phrase) {
      // pruneOrphans should have removed it; if it is still here, say so.
      problems.push(`unclaimed clip on disk: ${file}`);
      continue;
    }
    let info;
    try {
      info = readWavInfo(path.join(outDir, file));
    } catch (err) {
      problems.push(`unreadable clip ${file}: ${err.message}`);
      continue;
    }
    if (info.sampleRate !== EXPECTED_SAMPLE_RATE) badRate.push(`${file} @ ${info.sampleRate} Hz`);
    if (info.frames === 0) problems.push(`empty clip (0 frames): ${file}`);

    totalBytes += info.bytes;
    const seconds = Number(info.seconds.toFixed(3));
    manifest[id] = { file, seconds, text: phrase.text };

    const c = synthWords.get(id);
    const words = c && Array.isArray(c.words) ? c.words : null;
    const want = phrase.indices.length;
    if (!words) {
      timingRejected.push(`${id}: ${c && c.wordsSkipped ? c.wordsSkipped : 'synth reported none'}`);
    } else if (words.length !== want) {
      timingRejected.push(`${id}: ${words.length} offsets for ${want} words`);
    } else if (!words.every((v, k) => Number.isFinite(v) && v >= 0 && v <= seconds * 1000 && (k === 0 || v >= words[k - 1]))) {
      timingRejected.push(`${id}: offsets not monotonic within [0, ${(seconds * 1000).toFixed(0)}ms]`);
    } else {
      manifest[id].words = words;
    }
  }

  // ── Cross-check every direction before writing anything. ────────────────
  const manifestIds = new Set(Object.keys(manifest));
  const missing = phrases.filter((p) => !manifestIds.has(p.id)).map((p) => p.id);
  const extra = [...manifestIds].filter((id) => !byId.has(id));

  const synthIds = new Set(report.clips.map((c) => c.id));
  const synthSaidYesDiskSaysNo = [...synthIds].filter((id) => !manifestIds.has(id));
  const diskSaysYesSynthSaidNo = [...manifestIds].filter((id) => !synthIds.has(id));

  if (!missing.length && !extra.length && !problems.length && !badRate.length) {
    writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  }

  // ── Report measured numbers. ─────────────────────────────────────────────
  const seconds = Object.values(manifest).map((m) => m.seconds);
  const rates = new Set(
    onDisk
      .filter((f) => byId.has(f.slice(0, -(EXT.length + 1))))
      .map((f) => {
        try { return readWavInfo(path.join(outDir, f)).sampleRate; } catch { return 'unreadable'; }
      })
  );

  console.log('');
  console.log(`Phrases expected:  ${phrases.length}`);
  console.log(`Clips on disk:     ${onDisk.length} *.${EXT}`);
  console.log(`Manifest entries:  ${Object.keys(manifest).length}`);
  console.log(`Synth reported:    ${report.clips.length} rendered, ${report.failures.length} failed`);
  console.log(`MISSING:           ${missing.length}${missing.length ? ` (${missing.join(', ')})` : ''}`);
  console.log(`UNCLAIMED:         ${extra.length}${extra.length ? ` (${extra.join(', ')})` : ''}`);
  console.log(`Orphans removed:   ${removed.length}${removed.length ? ` (${removed.join(', ')})` : ''}`);
  console.log(`Sample rate(s):    ${[...rates].join(', ')} Hz (expected ${EXPECTED_SAMPLE_RATE})`);
  console.log(`Total payload:     ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  {
    const withWords = Object.values(manifest).filter((m) => m.words).length;
    const n = Object.keys(manifest).length;
    const covered = Object.entries(manifest)
      .filter(([, m]) => m.words)
      .reduce((a, [, m]) => a + m.words.length, 0);
    console.log(
      `Per-word timings:  ${withWords}/${n} clips (${n ? ((withWords / n) * 100).toFixed(0) : 0}%), ` +
      `${covered}/${wordCount} word events covered; ${n - withWords} fall back to char weighting`
    );
    if (timingRejected.length) {
      console.log(`  rejected timings (${timingRejected.length}):`);
      for (const r of timingRejected) console.log(`    ${r}`);
    }
  }
  if (seconds.length) {
    console.log(
      `Durations:         min ${Math.min(...seconds).toFixed(3)}s / ` +
      `max ${Math.max(...seconds).toFixed(3)}s / ` +
      `total ${seconds.reduce((a, b) => a + b, 0).toFixed(2)}s`
    );
  }

  let failed = false;
  const fail = (msg) => { failed = true; console.error(`\nERROR: ${msg}`); };

  if (report.failures.length) {
    fail(`${report.failures.length} phrase(s) FAILED to render:`);
    for (const f of report.failures) console.error(`  ${f.id}: ${f.error}`);
  }
  if (missing.length) fail(`${missing.length} phrase(s) have no clip on disk: ${missing.join(', ')}`);
  if (extra.length) fail(`${extra.length} manifest entr(ies) do not correspond to a phrase: ${extra.join(', ')}`);
  if (problems.length) { fail(`${problems.length} clip problem(s):`); for (const p of problems) console.error(`  ${p}`); }
  if (badRate.length) {
    fail(
      `${badRate.length} clip(s) are not ${EXPECTED_SAMPLE_RATE} Hz — that usually means espeak ` +
      `was used instead of Kokoro:\n  ${badRate.join('\n  ')}`
    );
  }
  if (synthSaidYesDiskSaysNo.length) {
    fail(`synth claimed to render clips that are not on disk: ${synthSaidYesDiskSaysNo.join(', ')}`);
  }
  if (diskSaysYesSynthSaidNo.length) {
    fail(`clips on disk the synth did not report rendering (stale?): ${diskSaysYesSynthSaidNo.join(', ')}`);
  }

  if (failed) {
    console.error('\nmanifest.json was NOT written (or is stale). Fix the above and re-run.');
    process.exitCode = 1;
    return;
  }

  console.log('\nOK: phrases == clips on disk == manifest entries, all clips readable at the expected rate.');
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
