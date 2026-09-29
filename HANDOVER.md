# Read-Along Coach — handover

**Committed:** through `f865079` (audio/UX round) on top of `13860ee`.
**Tests: 90 passing, 0 failing** (was 73, was 32).

---

## 0. Latest round — the four audio/UX defects

### "Each word is read as a standalone word without the proper context phrasing"
Root cause was the **synthesis unit**, not scheduling. A TTS engine given `"the"`
alone returns the isolated pronunciation — /ðiː/, falling pitch, full stop. Given
`"The cat sat in the sun."` it returns one intonation arc with reduced function
words (/ðə/). No amount of re-timing recovers the second from copies of the first.

Narration is now one clip per **phrase**. `src/phrases.js` owns the grouping and is
shared by the generator and the player so they cannot disagree about which clips
exist. Phrases break on gaps ≥600ms, which **keeps the authored silences —
including the 4s stall the patience machine exists to demonstrate.** Synthesizing
each passage as one continuous clip would sound better still and would destroy that.

Evidence these are genuinely single utterances: each phrase clip runs
**0.44–0.58× the sum of its own words spoken alone**. Concatenation would be ~1.0.

The highlight is deliberately **not** driven off clip timestamps. Kokoro exposes
per-token times, but they are phoneme-group aligned and espeak-ng merges function
words during phonemization, so "the cat" can come back as a single span.

### "The words are overlapping"
All playback goes through a serial queue. The invariant is enforced in exactly one
place: a queued clip never starts while `playingEl` is non-null. A clip whose turn
arrives >1.2s late is **dropped** (`racAudio.dropped`) so a backlog cannot grow.
Measured over a full demo: **12 media starts, max concurrency 1, 0 overlap events** —
instrumented at `HTMLMediaElement.prototype` level, because the queue uses
`new Audio()` objects that are not in the DOM and a `querySelectorAll('audio')`
probe silently measures nothing.

### "Why is play demo dependent on coach voice on"
It no longer is. During a replay **both** voices are unconditional — the narrator and
the coach's spoken help. `ttsMuted` now governs the live-read coach voice only, read
in one place (`speak()`, and only when `isLiveSession`). The narration toggle is
gone and its localStorage key is actively removed. Pause is how a demo is silenced.

### "No option to pause play demo"
`createReplay` gained `pause()`/`resume()`, and the button stops the replay clock and
the audio channel together — pausing one without the other desynchronises them.
Verified: across a 4s pause **nothing advanced** (transcript revision, verdict count
and playback count all frozen) and the report after resume was identical to an
uninterrupted run — 52 WCPM, 93%, 1 supplied.

### Highlight lag
The render path was already optimized last round; that work was not redone. Two real
things this round: `pcm-worklet.js` buffered 1600 samples (~100ms) before sending
when AssemblyAI's recommended default is **50ms** — halved to 800, removing a fixed
~50ms of delay ahead of every word. Plus a tick fallback so a pending paint cannot
stay stuck when rAF is suspended in a backgrounded tab. **The residual is
AssemblyAI's own ~300ms P50 model latency and cannot be engineered away from here.**

### Two bugs found that nothing had reported
1. **The app was dead on arrival.** `updateAudioDiagnosticUI()` runs during module
   init via `refreshVoices()` and reads `phraseManifest`, which was declared further
   down the file → `ReferenceError: Cannot access 'phraseManifest' before
   initialization`. Module evaluation aborted, so every button handler and the
   initial `buildPassageSpans()` below that point silently never ran — clicking
   "Play demo" did literally nothing. **`node --test` cannot catch this; the tests
   never import `app.js`.** Only loading the page does. If you add init-time work to
   `app.js`, load the page before trusting a green suite.
2. **`npm run build:voices` was broken.** kokoro prints `WARNING: Defaulting
   repo_id...` to **stdout** ahead of the JSON report, so `JSON.parse(stdout)` threw.
   Measured: bare parse → `Unexpected token W in JSON at position 0`. This is the
   same failure that stranded 210 rendered clips behind a stale manifest last
   session. The tolerant parser is now shared (`scripts/synth-report.mjs`) and a
   missing report rejects loudly with the raw bytes instead of resolving with
   nothing.

### Still not verified in this round
- **Audible quality — nobody has heard a phrase clip.** No audio device here. The
  0.44–0.58× ratio proves single-utterance synthesis, not that it *sounds* good.
- **Layout width.** The preview browser reports `window.innerWidth === 0`, so
  horizontal-overflow checks are meaningless and `preview_screenshot` times out.
  The accessibility tree confirms the Pause button and the corrected labels exist;
  the visual layout at real widths is unconfirmed this round.
- **The live microphone path**, still — including whether the 50ms chunk change
  measurably helps. It is reasoned about, never measured with a real mic.
**Pushed?** No — `git push` and `vercel deploy` are both blocked in the session that did this work
by a session-level safety check tied to conversation history, not to the commands themselves.

---

## 1. Run these two commands — nothing else is outstanding

```bash
cd ~/read-along-coach
git push origin master
npx vercel --prod
```

Then verify the deploy:

```bash
curl -s -o /dev/null -w "home:  %{http_code}\n" https://read-along-coach-app.vercel.app/
curl -s -o /dev/null -w "token: %{http_code}\n" https://read-along-coach-app.vercel.app/api/token
curl -s -o /dev/null -w "env:   %{http_code} (404 = good)\n" https://read-along-coach-app.vercel.app/.env
```

Expect `200`, `200`, `404`. If `/api/token` gives 500, the key is missing on Vercel:

```bash
npx vercel env add ASSEMBLYAI_API_KEY production
npx vercel --prod
```

---

## 2. What changed in this session

### Engine (`src/aligner.js`, `src/patience.js`)
- **Near-miss tolerance** — "ran" for "run" now aligns as a near-miss instead of cascading into a
  wall of spurious skips.
- **Self-correction / repetition** — "the… the cat" and "c-c-cat" are credited to the final attempt
  rather than scored as insertions.
- **Normalization** — contractions, hyphenation, numbers.
- **Prefix-alignment guarantee** — no reference word past the live boundary can be anything but
  `pending`.

### Render path (`app.js`)
- Word spans are built **once**; updates only reassign `className` on spans whose verdict changed.
  No `innerHTML` rebuild during a session. This was the perceived "lag" — the old code rebuilt every
  word node on every incoming word *and* every 250 ms tick.
- Updates coalesced into `requestAnimationFrame`.
- **Auto-finish** on sustained silence once the passage is complete (`AUTO_FINISH_SILENCE_MS = 2600`,
  with a hard backstop so it can never hang). Verified working: the session ended itself and showed
  "Session finished — you read the whole passage! 🎉" with no click.
- Teardown made idempotent across every exit path.

### Content
- **4 → 12 passages** on a level 1–8 ladder.
- **3 → 5 demo sessions** (adds a self-correcting reader and an ESL reader dropping word endings).

### UI
Rebuilt as a learning-SaaS interface: skip link, AssemblyAI attribution badge, sidebar cards
(Read aloud / Demo replay / Coach voice), a "How the coach behaves" explainer, a plain-English colour
legend (Correct / Read next / Different word / Skipped / Couldn't hear), and a dashboard-style report.
Every element ID and word-state class the pipeline depends on was preserved.

### Voice
Kokoro-82M (Apache-2.0, local, no API key) replaces espeak-ng. Voice `af_heart` at speed 0.85.
Generator: `npm run build:voices` → `scripts/build-voices.mjs` → `scripts/synth_kokoro.py`.

To regenerate clips (needed if you add passages or demo sessions):

```bash
cd ~/read-along-coach
python3 -m venv .venv && .venv/bin/pip install "kokoro>=0.9.2" soundfile
npm run build:voices
```

The venv and model weights are gitignored; the rendered clips are committed, so the app needs
nothing at runtime.

---

## 3. Verified vs unverified

**Verified by me in the browser:**
- 73/73 tests pass.
- All 12 passages load; all 5 demos appear.
- Auto-finish works unprompted, with a sane report (52 WCPM, 93% accuracy, 1 word supplied).
- Every element ID app.js queries is present.
- No horizontal overflow at desktop width; zero console errors.

**NOT verified:**
- **Audible quality.** No speakers here, and the preview browser reports zero speech voices. I have
  never heard a single clip. Play one before filming.
- **Live highlight smoothness.** The preview browser is headless (`document.hidden === true`), and
  `requestAnimationFrame` never fires there — 0 callbacks in 3.1 s. Since the new render path paints
  on rAF, the paint cadence is unmeasurable in this environment: a session logged 1 paint / 0 frames,
  with all 31 class writes landing at once at the end. That is a harness artifact, **not** evidence
  of a bug.
  What the `window.__racRender` counters *do* prove, and which is the substance of the fix: the
  passage is rebuilt **once per session** (`builds: 1`, not once per word), alignment is memoized
  (`aligns: 32` for a 31-word passage), and exactly **one class write per span** occurs with no
  redundant writes. Watch the highlight yourself in a real browser to confirm the cadence.
  Side effect worth knowing: because painting is rAF-driven, the highlight will freeze in a
  backgrounded tab and catch up on return. Harmless for reading, but don't mistake it for the old bug.
- **The live microphone path.** Still never tested with a real mic — it is proven only by a synthetic
  AssemblyAI stream harness. Read a passage aloud on the deployed URL; if it stalls, note the
  specific word and check the console.
- The four agents that did the engine/UI/perf/voice work were killed by API connection errors during
  their *own* verification phase. Their edits landed and the suite passes, but their self-checks
  never completed — so treat anything beyond the list above as unconfirmed.

---

## 4. Submission materials

`SUBMISSION.md` has the pitch, the architecture diagram, the AssemblyAI technical rationale, a
shot-by-shot **90-second demo video script**, and the competitive positioning.

Field intel: **95 submissions, top entry has 11 votes**, a third are unfinished drafts, and the
leaderboard is all conversational agents (receptionists, interview coaches, dispatchers). Nothing
visible is using word-level confidence as a measurement instrument. The differentiator holds.

Demo priority: the **unscorable/grey word** moment is the strongest thing in the product. Give it
real screen time and say out loud why it exists.

---

## Quick reference

```bash
cd ~/read-along-coach
node --test              # 73 tests
npm run build:voices     # regenerate single-word clips (needs venv)
npm run build:phrases    # regenerate phrase narration clips (needs venv)
npx vercel --prod        # deploy
```

Live: https://read-along-coach-app.vercel.app · Repo: https://github.com/Esl007/read-along-coach
