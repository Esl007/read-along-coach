# 📖 Read-Along Coach

**A patient voice agent that listens to early readers and language learners read aloud** — measuring real fluency (WCPM, the metric US schools use), waiting through sounding-out instead of interrupting, and refusing to mark a reader wrong when the audio wasn't clear enough to judge.

Built for the [AssemblyAI Voice Agent Hackathon](https://lablab.ai/ai-hackathons/assemblyai-voice-agent-hackathon).

## Why AssemblyAI specifically
This can't be built on batch transcription or a plain STT wrapper:
- **Word-level timestamps** → words-correct-per-minute, pause detection, struggle-word identification
- **Word-level confidence** → the *confidence-grace* rule: low-confidence audio is "unscorable", never "wrong"
- **Streaming partials** → sounding-out ("c… ca… cat-er…") is detected as *effort*, which extends the coach's patience instead of triggering an interruption

## Run it
```bash
cp .env.example .env   # add your AssemblyAI API key
npm install
npm start              # http://localhost:3000
npm test               # aligner + patience + replay unit tests
```

### Demo without an API key
No microphone or AssemblyAI key needed — pick a script under **▶ Demo replay** in the UI.
Three bundled session scripts (`src/sessions/`) replay recorded word events through the
*same* pipeline as live audio (patience machine, alignment, live coloring, coach help,
final report, progress history):
- **Fluent adult read** — clean lighthouse passage, 100% accuracy, zero helps
- **Halting early reader** — sounding-out fragments ("ca…"), a genuine stall the coach
  waits through then helps with, a skipped word, a substitution, and one garbled word
  that lands as *unscorable*, never *wrong*
- **ESL careful read** — deliberate pace with a couple of low-confidence words

`src/replay.js` schedules events in real time for the UI and has a fast synchronous
mode (`runFast`) used by `src/replay.test.js`.

### Progress across sessions
Every finished session (live or replay) is saved to localStorage; a Progress section
under the report shows past sessions and an inline SVG sparkline of WCPM over time.

## Architecture
```
mic → AudioWorklet (16-bit PCM) → AssemblyAI Universal-Streaming (WebSocket)
        ↓ word events (text, confidence, start, end)
  aligner.js   — Needleman-Wunsch alignment against the known passage
  patience.js  — state machine: LISTENING → WORKING (sounding-out) → STALLED
        ↓
  live word coloring + gentle help + session report (WCPM, accuracy, practice list)
```

## 13-day plan
- **D1–2** ✅ scaffold: server token mint, streaming pipeline, aligner + tests
- **D3–4** ✅ replay/simulation mode: bundled session scripts exercise the patience machine end-to-end without a mic
- **D5–6** ✅ fluency trend across sessions (localStorage + sparkline); per-word replay
- **D7–8** ✅ ESL persona pass (careful-read demo script on the interview passage)
- **D9–10** deploy (Vercel/Render), record demo video: halting read → patient help → dashboard
- **D11–12** slides, submission copy, buffer
- **D13** submit early
