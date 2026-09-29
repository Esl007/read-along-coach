# Read-Along Coach — submission package

AssemblyAI Voice Agent Hackathon. Live app: https://read-along-coach-app.vercel.app
Repo: https://github.com/Esl007/read-along-coach

---

## Tagline

**A reading coach that listens patiently, helps only when a child is truly stuck, and never marks
them wrong when it couldn't hear clearly.**

---

## The problem

A child learning to read needs someone sitting beside them who does three things well: waits while
they sound a word out, supplies the word at the exact moment patience stops helping, and keeps an
honest record of which words are hard. In a classroom of thirty, that one-to-one attention is the
scarcest resource there is. Reading fluency is measured in **WCPM** (words correct per minute) — a
real, standard US literacy metric — and it is measured by a teacher with a stopwatch and a clipboard,
one child at a time.

Existing speech tools fail at this for a specific reason: they are built to understand *intent*, not
to measure *accuracy against a known text*. Ask a general voice assistant to listen to a child read
and it will helpfully "correct" the transcript into fluent English, hiding exactly the errors you
needed to see.

## What it does

The reader picks a leveled passage and reads it aloud. The app:

- **Tracks position word by word**, highlighting progress live as they read.
- **Waits.** A patience state machine distinguishes a child *thinking* from a child *stuck*:
  LISTENING → WORKING (sounding a word out) → STALLED. Sounding-out behaviour *earns extra time*
  rather than triggering help.
- **Supplies the word** — spoken aloud — only after genuine stall, then resumes without scolding.
- **Scores honestly**, reporting WCPM, accuracy, words supplied, and a practice list of the specific
  words that caused trouble.
- **Refuses to guess.** When the microphone audio is genuinely unclear, the word is marked
  `unscorable` — never `wrong`. Grey and italic, excluded from every score.
- **Tracks progress across sessions** so improvement is visible.

## Why AssemblyAI — and why this is not a chatbot

Most voice-agent projects use STT as a front door to an LLM. **We use AssemblyAI Universal-Streaming
as a measurement instrument.** Two fields carry the entire product:

| Signal | What we do with it |
| --- | --- |
| **Word-level timestamps** | Detect hesitation before a specific word; compute WCPM; drive the patience clock on stream time rather than wall clock |
| **Per-word confidence** | Separate "the child read it wrong" from "we could not hear it" — the fairness rule the whole product rests on |

That second row is the ethical core. A reading assessment that marks a child wrong because of a
noisy room is worse than no assessment at all. Confidence below a threshold routes to `unscorable`,
and unscorable words are excluded from accuracy, WCPM, and the practice list.

### Streaming details that mattered

- `Turn.words` is **cumulative** — every Turn message re-sends all words in the turn, finals plus a
  revisable non-final tail. Words must be **replaced** per `turn_order`, never appended. Getting this
  wrong duplicates the entire transcript.
- **Render and score are split.** The highlight renders from provisional words so it tracks the
  reader's voice in real time; scoring consumes only finalized words so no verdict is ever issued on
  text that may still be revised. Using finals for both makes the highlight freeze and lurch; using
  provisionals for both makes scores unstable.

## Architecture

```
                    ┌─────────────────────┐
                    │   Reference Text    │
                    └──────────┬──────────┘
                               │
                               ▼
                        Alignment Engine
                               ▲
                               │
Student ── microphone ──→ AssemblyAI Universal-Streaming
                               │
                     words + timestamps + confidence
                               │
                               ▼
                       Fluency Scoring
                               │
                  ┌────────────┴────────────┐
             No intervention          Genuine stall
                  │                         │
                  │                         ▼
                  │                  TTS speaks: "big"
                  └──────────────→ continue
```

**AssemblyAI owns speech understanding. We own everything that makes it a teacher:** reference
alignment, word-level verdicts, hesitation detection, confidence-aware fairness, and intervention
policy. A local neural TTS speaks the exact intervention word — deterministic, because a reading
coach that says "The word is big" when the engine committed to `big` has broken its own record.

### The alignment problem, and the bug worth describing

Matching what was heard to the reference text is **Needleman-Wunsch sequence alignment** — the same
algorithm used for DNA. But a *global* alignment on a partial transcript is actively wrong: with one
word heard out of 41, it smears the traceback across the whole passage and concludes the reader is
near the end. On the lighthouse passage this put the cursor on "the rocks" after a single word.

The fix is **prefix (semi-global / free-end-gap) alignment**: find the reference prefix that best
explains *all* heard words, tie-breaking to the **smallest** such index, and treat everything beyond
that boundary as `pending` — not `skipped`, and excluded from all scoring. A reader who has read five
words has not skipped the other thirty-six.

## Demo video script (~90 seconds)

Judges are watching dozens of these. Lead with the thing nobody else has.

**0:00–0:10 — The hook.** On screen: the app, passage loaded.
> "This is a reading coach for a six-year-old. It isn't a chatbot — it never has a conversation.
> It does one thing: it listens to a child read, and it decides when to help."

**0:10–0:30 — Patience.** Play the halting-early-reader demo. The reader stalls on a word.
> "Watch what it does when she gets stuck. She's sounding it out — 'c… ca…' — and the coach waits.
> It can tell the difference between a child thinking and a child stuck, and sounding-out actually
> *buys her more time*."
Let the silence run. Do not cut it short — the waiting **is** the product.

**0:30–0:42 — The intervention.** The coach speaks the word.
> "Four seconds in, it gives her the word. Out loud. Then it gets out of the way."

**0:42–1:05 — The fairness rule.** Point at a grey italic word in the passage.
> "Here's the part I care most about. This word is grey because AssemblyAI told us its confidence was
> low — the audio wasn't clear. So we don't score it. We do not mark a child wrong because the room
> was noisy. It's marked unscorable and excluded from her accuracy entirely."

**1:05–1:20 — The measurement.** Show the report.
> "At the end she gets real numbers — words correct per minute, the standard fluency metric teachers
> already use — plus the specific words to practise. That comes from AssemblyAI's word-level
> timestamps and confidence. Not from an LLM's opinion."

**1:20–1:30 — Close.** Show the progress sparkline.
> "Session over session, a parent can see it going up. One teacher can't sit with thirty children.
> This can."

### Filming notes
- **Mute the coach voice only if it distracts** — otherwise let the intervention be *heard*. It is
  the most persuasive second in the video.
- Do not narrate the UI ("here I click…"). Narrate the *decisions the engine makes*.
- The unscorable/grey moment is the strongest differentiator. Give it real screen time.
- Record at a size where the passage text is readable on a phone.

## What makes this different from the rest of the field

The submission pool is dominated by conversational agents: receptionists, help desks, interview
coaches, dispatchers, incident commanders. They are all variations on *STT → LLM → TTS*, and they
compete on prompt quality.

This entry is structurally different:

1. **Deterministic, not generative.** Verdicts come from sequence alignment against a known
   reference, so results are reproducible and testable. There is no LLM in the scoring path at all.
2. **Uses the signals nobody else uses.** Word-level confidence and timestamps, as measurement.
3. **Ethical behaviour is engineered, not prompted.** "Never mark a child wrong when you couldn't
   hear them" is a threshold and a verdict type, not an instruction we hope a model follows.
4. **It is a real metric.** WCPM is what US schools actually use.
5. **Tested.** A synthetic AssemblyAI stream harness lets the alignment, patience and scoring logic
   be verified without a microphone or a child.

## Tech stack

- **AssemblyAI v3 Universal-Streaming** — `wss://streaming.assemblyai.com/v3/ws`, browser connects
  with a short-lived token minted server-side so the API key never reaches the client
- Vanilla JS ES modules, no framework — zero build step, instant load
- Web Audio `AudioWorkletProcessor` → 16-bit PCM at the device's real sample rate
- Vercel static hosting + one serverless function for token minting
- **Kokoro-82M** (Apache-2.0) neural TTS, pre-rendered at build time over the closed passage
  vocabulary — zero runtime latency, no API key, no per-use cost
- Node's built-in test runner

## Honest limitations

- Tuned and tested for English.
- Intervention thresholds are sensible defaults, not clinically validated; a real deployment would
  calibrate per reader.
- Built and verified by an adult reading aloud and by a synthetic stream harness — not yet trialled
  with children in a classroom.
