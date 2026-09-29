# Read-Along Coach — handover

**Committed:** `d922551` (engine hardening + new UI + 12 passages) on top of `a996617`.
**Tests: 73 passing, 0 failing** (was 32).
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
npm run build:voices     # regenerate clips (needs venv)
npx vercel --prod        # deploy
```

Live: https://read-along-coach-app.vercel.app · Repo: https://github.com/Esl007/read-along-coach
