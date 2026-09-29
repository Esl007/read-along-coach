# Read-Along Coach — handover

**Verified state as of this file:** local `master` and `origin/master` are both at `5cd0ac3`
(0 ahead / 0 behind, clean tree). **Nothing needs pushing.** All 32 tests pass.

The only deploy action outstanding is pushing the current code live to Vercel.

---

## 1. Redeploy to Vercel (the one thing actually pending)

The live site still serves older code. This publishes `5cd0ac3`:

```bash
cd ~/read-along-coach
npx vercel --prod
```

Then confirm the deploy is healthy:

```bash
curl -s -o /dev/null -w "home:   %{http_code}\n" https://read-along-coach-app.vercel.app/
curl -s -o /dev/null -w "token:  %{http_code}\n" https://read-along-coach-app.vercel.app/api/token
curl -s -o /dev/null -w "clip:   %{http_code}\n" https://read-along-coach-app.vercel.app/voices/the.wav
curl -s -o /dev/null -w "env:    %{http_code} (404 = good, .env not exposed)\n" https://read-along-coach-app.vercel.app/.env
```

Expected: `200`, `200`, `200`, `404`.

If `/api/token` returns 500, the API key is missing on Vercel:

```bash
cd ~/read-along-coach
npx vercel env add ASSEMBLYAI_API_KEY production
npx vercel --prod          # re-deploy so the new env var takes effect
```

---

## 2. Check your audio state (do this FIRST — it may cancel the work in §3)

Open the app, press F12 → Console, and run:

```js
window.__racAudio
```

| Result | Meaning | Action |
| --- | --- | --- |
| `path: "webspeech"` with a real `voiceName` | Your browser has native voices. You're already hearing decent audio. | **Skip §3** — clip quality is fallback-only. |
| `path: "clips"` | No browser voices; you're hearing the robotic espeak clips. | **Do §3.** |
| `path: "none"` | Still no audio at all. | Paste the whole object back — `lastError` will say why. |

---

## 3. Swap espeak clips for Kokoro neural TTS

Kokoro-82M was chosen over ElevenLabs because its weights are **Apache-2.0** (unrestricted
commercial use, no attribution) and it runs locally with **no API key**. ElevenLabs' free tier
grants **no commercial licence**, which is a real risk for a publicly submitted hackathon entry
with cash prizes.

Start a **fresh Claude Code session** from `~/read-along-coach` (delegation is blocked in the
old session by a session-level safety check tied to its history, not to any of these tasks) and
paste this:

> Replace the robotic espeak-ng word clips in `voices/` with Kokoro-82M neural TTS. Kokoro was
> chosen because its weights are Apache-2.0 (unrestricted commercial use, no attribution) and it
> runs locally with no API key — ElevenLabs was rejected because its free tier grants no
> commercial licence and this is a public hackathon submission.
>
> Install Kokoro in a userspace venv (`pip install "kokoro>=0.9.2" soundfile`) — no sudo
> available. Its phonemizer may need an `espeak-ng` binary; one was already extracted from the
> Ubuntu .deb into this repo area without root, so find and reuse it.
>
> Rewrite `scripts/build-voices.mjs` to generate via Kokoro, keeping the `npm run build:voices`
> entry point, the vocabulary derivation from `src/passages.js` + `src/sessions/` (do NOT
> hardcode a word list), and the output contract `voices/<word>.<ext>` + `voices/manifest.json`.
> Pick a warm, clearly-articulated English voice suited to early readers and ESL learners, and
> say why you chose it. Commit the regenerated clips so no model or binary is needed at runtime;
> gitignore the venv and model weights. Re-encode to Opus or MP3 to shrink the current 4.1MB,
> updating the manifest and any extension references in `app.js`. Trim leading/trailing silence
> and normalize levels.
>
> Do NOT touch alignment, scoring, patience, the AssemblyAI/WebSocket path, the render loop, or
> session-end UX. Keep the Web Speech → clips fallback chain and `window.__racAudio` intact.
>
> Verify: `node --test` (32 must pass); every vocabulary word has a clip and manifest entry with
> no orphans; durations scale with word length ("the" much shorter than "caterpillar"); and prove
> playback by monkey-patching `HTMLMediaElement.prototype.play`, enabling the "Narrate demo"
> toggle, running a demo, and capturing `timeupdate` events showing `currentTime` actually
> advancing. Zero console errors. Do not claim you heard anything — report model, voice id,
> sample rate, durations and file sizes.

---

## 4. Two known UX bugs (not yet started)

Paste into a fresh session, ideally **after** §3 lands, since both touch `app.js`:

> Two UX fixes in ~/read-along-coach. Keep scope tight and do not touch the aligner, scoring,
> or the AssemblyAI streaming path.
>
> **(a) The highlight feels sluggish and lurching.** `refresh()` in `app.js` rebuilds the entire
> passage via `innerHTML` on every single word event *and* on every 250ms tick, re-running the
> full alignment each time — so ~41 word spans are destroyed and recreated constantly. Coalesce
> renders into a `requestAnimationFrame` and mutate only the changed spans' `className` instead
> of regenerating markup. AssemblyAI's latency is fine; the UI is the bottleneck.
>
> **(b) The session never ends itself.** The reader must click "Finish" manually, which reads as
> the app being stuck. End the session automatically on a sustained silence once the reader has
> reached the end of the passage, while keeping the manual Finish button working.
>
> Verify with `node --test` and by running a demo in the preview browser: confirm the highlight
> advances smoothly and the session self-finishes with a sane report.

---

## 5. The one thing nobody has tested

The **live microphone path** has never been empirically verified — there is no microphone in the
dev environment, so it is proven only by a synthetic AssemblyAI harness and code review.

Read a passage aloud on the live URL. If it stalls, note **where** it sticks (a specific word, or
right at the start) and check the browser console for `ws.onclose` or token errors.

---

## Quick reference

```bash
cd ~/read-along-coach
node --test                  # 32 tests
npm run build:voices         # regenerate word clips
npx vercel --prod            # deploy
git log --oneline -3
```

Live URL: https://read-along-coach-app.vercel.app
Repo: https://github.com/Esl007/read-along-coach
