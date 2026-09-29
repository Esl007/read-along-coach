#!/usr/bin/env python3
"""Render one clip per vocabulary word with Kokoro-82M (neural TTS, fully local).

This is the audio engine behind `npm run build:voices`. It is invoked by
scripts/build-voices.mjs, which owns the vocabulary derivation (it has to —
the word list comes from ESM modules src/passages.js and src/sessions/) and
owns the voices/manifest.json contract. This script's job is narrow:

    stdin  <- {"words": [...], "outDir": "...", ...}
    stdout -> {"clips": [{"word","file","ext","seconds","bytes",...}], ...}

WHY KOKORO
    hexgrad/Kokoro-82M, Apache-2.0 weights. Three reasons it beats the
    espeak-ng formant synth this replaces and the hosted APIs we looked at:
      * Licence: Apache-2.0 with no attribution requirement, so the clips can
        ship inside a public hackathon submission that has cash prizes.
        ElevenLabs' free tier grants no commercial licence, which rules it out
        for exactly that reason.
      * No API key, no network at runtime. Weights download once at build
        time from HuggingFace; the committed clips are all the app ever needs.
      * 82M params runs comfortably on CPU, and it is a real neural vocoder
        (24 kHz) rather than a formant synthesiser, so it does not sound robotic.

VOICE
    Default af_heart. See --voice and the VOICE NOTES section below.

REPRODUCTION (no root required; sudo is not available on the build box)
    cd /home/tracer_face/read-along-coach
    python3 -m venv .venv
    .venv/bin/pip install "kokoro>=0.9.2" soundfile
    npm run build:voices

    Notes on the phonemiser: Kokoro's misaki G2P needs espeak-ng. It normally
    uses the copy bundled in the `espeakng_loader` wheel, so nothing needs to
    be installed system-wide. On this box espeak-ng-data and libespeak-ng.so.1
    happen to already be present system-wide, and resolve_espeak() below falls
    back to them if the bundled copy is missing. Neither path needs the
    espeak-ng *binary*, only the shared library, which is why this works
    without root.

    .venv/ and the downloaded HuggingFace weights are gitignored; the rendered
    clips under voices/ are committed so the app has zero runtime dependencies.

WHAT WE DO TO THE RAW MODEL OUTPUT
    These are single words heard in isolation, one after another, so dead air
    and uneven loudness are far more noticeable than they would be in
    continuous speech. Every clip is therefore silence-trimmed, de-clicked
    with short fades, and loudness-matched (RMS to a target, with a peak
    ceiling) so no word is startlingly louder than its neighbour.

VOICE NOTES (why af_heart)
    Kokoro ships 54 voices. The relevant axis here is a warm, friendly,
    clearly-articulated *American* English voice, because the learners are
    early readers and ESL students who are being asked to imitate the word
    they just heard — crisp consonants matter more than character.
      * af_heart  — the flagship voice, the only one Kokoro grades A, warm and
                    even-toned. Chosen.
      * af_bella  — graded A-, but noticeably more performed/dramatic, which
                    is a liability when the clip is a pronunciation model.
      * af_nicole — graded B-, breathy/ASMR-leaning; too soft for a classroom
                    or a noisy demo room.
      * am_michael / bm_george — fine voices, but graded lower (C+/C) and the
                    British options add vowel ambiguity for an ESL learner
                    working from American phonics material.
"""

import json
import os
import sys


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def resolve_espeak():
    """Point the phonemiser at an espeak-ng shared library + data dir.

    Prefers the copy bundled in the espeakng_loader wheel (needs no root).
    Falls back to the system install, which on this box exists as a library
    and data directory even though the espeak-ng *binary* is not installed.
    Returns a short string describing what was used, for the report.
    """
    try:
        import espeakng_loader  # ships its own libespeak-ng + data
        from phonemizer.backend.espeak.wrapper import EspeakWrapper

        lib = str(espeakng_loader.get_library_path())
        data = str(espeakng_loader.get_data_path())
        EspeakWrapper.set_library(lib)
        os.environ.setdefault("ESPEAK_DATA_PATH", data)
        return f"espeakng_loader bundled lib ({lib})"
    except Exception as e:  # noqa: BLE001 - any failure means try the system copy
        log(f"[synth] espeakng_loader unavailable ({e}); trying system espeak-ng")

    candidates = [
        "/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1",
        "/usr/lib/libespeak-ng.so.1",
        "/usr/local/lib/libespeak-ng.so.1",
    ]
    for lib in candidates:
        if os.path.exists(lib):
            try:
                from phonemizer.backend.espeak.wrapper import EspeakWrapper

                EspeakWrapper.set_library(lib)
            except Exception as e:  # noqa: BLE001
                log(f"[synth] could not bind {lib}: {e}")
                continue
            for data in ("/usr/share/espeak-ng-data", "/usr/lib/x86_64-linux-gnu/espeak-ng-data"):
                if os.path.isdir(data):
                    os.environ.setdefault("ESPEAK_DATA_PATH", data)
                    break
            return f"system espeak-ng library ({lib})"

    raise RuntimeError(
        "No espeak-ng shared library found. Kokoro's misaki G2P needs one. "
        "Install the `espeakng-loader` wheel (pip install espeakng-loader) or "
        "an espeak-ng shared library; the standalone binary is not sufficient "
        "and not required."
    )


# ── DSP ─────────────────────────────────────────────────────────────────────
# All levels below are amplitude ratios on float32 audio in [-1, 1].

SILENCE_FLOOR_DB = -45.0   # window quieter than this, relative to the clip peak, is silence
KEEP_HEAD_MS = 20.0        # pre-roll kept so plosive onsets ("t", "k") are not clipped
KEEP_TAIL_MS = 60.0        # tail kept so fricatives/stops ("s", "t") can finish
FADE_MS = 8.0              # de-click ramp on each end
TARGET_RMS_DB = -20.0      # loudness match across clips
PEAK_CEILING_DB = -1.0     # headroom so no clip ever clips


def db_to_amp(db):
    return 10.0 ** (db / 20.0)


def trim_and_normalize(audio, sr):
    """Silence-trim, de-click and loudness-match one clip. Returns float32."""
    import numpy as np

    x = np.asarray(audio, dtype=np.float32).reshape(-1)
    if x.size == 0:
        return x

    peak = float(np.max(np.abs(x)))
    if peak <= 0.0:
        return x  # pure silence; caller will flag the zero duration

    # Short-window RMS envelope. 10 ms windows are fine enough to catch the
    # real onset of a one-syllable word without chattering on the waveform.
    win = max(1, int(sr * 0.010))
    n_win = int(np.ceil(x.size / win))
    padded = np.pad(x, (0, n_win * win - x.size))
    env = np.sqrt(np.mean(padded.reshape(n_win, win) ** 2, axis=1))

    thresh = peak * db_to_amp(SILENCE_FLOOR_DB)
    voiced = np.nonzero(env > thresh)[0]
    if voiced.size == 0:
        return np.zeros(0, dtype=np.float32)

    start = voiced[0] * win - int(sr * KEEP_HEAD_MS / 1000.0)
    end = (voiced[-1] + 1) * win + int(sr * KEEP_TAIL_MS / 1000.0)
    y = x[max(0, start):min(x.size, end)].copy()
    if y.size == 0:
        return np.zeros(0, dtype=np.float32)

    # De-click: the trim almost always lands mid-waveform, which is an audible
    # step discontinuity at the buffer edge without these ramps.
    fade = min(int(sr * FADE_MS / 1000.0), y.size // 2)
    if fade > 0:
        ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)
        y[:fade] *= ramp
        y[-fade:] *= ramp[::-1]

    # Loudness match on RMS (perceived level), then pull back if that pushed
    # any sample above the peak ceiling. RMS alone is what makes "the" and
    # "caterpillar" sit at the same apparent volume; peak alone does not,
    # because a short word's single loudest sample is not representative.
    rms = float(np.sqrt(np.mean(y**2)))
    if rms > 0.0:
        y *= db_to_amp(TARGET_RMS_DB) / rms
    new_peak = float(np.max(np.abs(y)))
    ceiling = db_to_amp(PEAK_CEILING_DB)
    if new_peak > ceiling:
        y *= ceiling / new_peak

    return y.astype(np.float32)


FORMATS = {
    # ext: (libsndfile format, subtype)
    "wav": ("WAV", "PCM_16"),
    "mp3": ("MP3", "MPEG_LAYER_III"),
    "opus": ("OGG", "OPUS"),
}


def main():
    req = json.load(sys.stdin)
    words = req["words"]
    out_dir = req["outDir"]
    voice = req.get("voice", "af_heart")
    speed = float(req.get("speed", 0.85))
    ext = req.get("ext", "wav")
    lang_code = req.get("langCode", "a")  # 'a' = American English

    if ext not in FORMATS:
        raise SystemExit(f"unsupported ext {ext!r}; choose one of {sorted(FORMATS)}")
    sf_format, sf_subtype = FORMATS[ext]

    espeak_note = resolve_espeak()
    log(f"[synth] phonemiser: {espeak_note}")

    import numpy as np
    import soundfile as sf
    import torch
    from kokoro import KPipeline

    torch.set_num_threads(max(1, (os.cpu_count() or 2) // 2))

    log(f"[synth] loading Kokoro-82M (lang_code={lang_code!r}) ...")
    pipeline = KPipeline(lang_code=lang_code)
    sr = 24000  # Kokoro's native output rate; we never resample

    os.makedirs(out_dir, exist_ok=True)
    clips, failures = [], []

    for i, word in enumerate(words, 1):
        # A trailing period gives the model a complete declarative contour.
        # Bare tokens often come out with a trailing rise or a clipped tail,
        # which reads as a question rather than "this is the word".
        text = f"{word}."
        try:
            chunks = [
                np.asarray(res.audio, dtype=np.float32).reshape(-1)
                for res in pipeline(text, voice=voice, speed=speed)
                if res.audio is not None
            ]
            if not chunks:
                raise RuntimeError("model returned no audio")
            raw = np.concatenate(chunks)
            y = trim_and_normalize(raw, sr)
            if y.size == 0:
                raise RuntimeError("clip was empty after silence trim")

            path = os.path.join(out_dir, f"{word}.{ext}")
            sf.write(path, y, sr, format=sf_format, subtype=sf_subtype)
            clips.append(
                {
                    "word": word,
                    "file": f"{word}.{ext}",
                    "ext": ext,
                    "seconds": round(y.size / sr, 3),
                    "rawSeconds": round(raw.size / sr, 3),
                    "bytes": os.path.getsize(path),
                    "sampleRate": sr,
                }
            )
        except Exception as e:  # noqa: BLE001 - one bad word must not kill the build
            log(f"[synth] FAILED {word!r}: {e}")
            failures.append({"word": word, "error": str(e)})

        if i % 10 == 0 or i == len(words):
            log(f"[synth] {i}/{len(words)}")

    json.dump(
        {
            "model": "hexgrad/Kokoro-82M",
            "license": "Apache-2.0",
            "voice": voice,
            "langCode": lang_code,
            "speed": speed,
            "sampleRate": sr,
            "ext": ext,
            "format": f"{sf_format}/{sf_subtype}",
            "phonemizer": espeak_note,
            "clips": clips,
            "failures": failures,
        },
        sys.stdout,
    )
    sys.stdout.flush()


if __name__ == "__main__":
    main()
