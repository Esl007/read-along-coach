import json, sys, numpy as np, soundfile as sf
from kokoro import KPipeline
LINES = {
 "01_title": "This is Read-Along Coach. A reading coach that listens patiently, helps only when a child is truly stuck, and never marks them wrong when it couldn't hear clearly.",
 "02_problem": "Children learn to read by reading aloud to someone who waits while they sound words out, and helps at exactly the right moment. In a class of thirty, that one-to-one attention is the scarcest thing there is. And reading fluency is still measured by a teacher with a stopwatch, one child at a time.",
 "03_intro": "The reader picks a leveled passage, from level one to level eight, and reads it aloud. AssemblyAI Universal-Streaming gives us every word, with its timestamp and a confidence score. We use those signals as a measuring instrument, not as input to a chatbot. Here is a recorded early reader.",
 "04_report": "When the reader finishes, the report arrives. Words correct per minute, the fluency measure schools already use. Accuracy. The words the coach supplied. And the exact words to practise next time.",
 "05_fair": "This is the part that matters most. When AssemblyAI is not confident about a word, we don't guess. The word turns grey, and it is left out of every score. A child is never marked wrong because the room was noisy.",
 "06_arch": "Under the hood, streaming words are aligned against the passage with sequence alignment, the same idea used to compare DNA, so we always know exactly where the reader is. A patience state machine tells thinking apart from being stuck, and sounding a word out earns more time. Only after a genuine stall does the coach speak, one word, in a neural voice rendered ahead of time. There is no language model in the scoring path, so every verdict is reproducible, and tested.",
 "07_value": "That makes it useful for teachers running fluency checks, for parents at home, and for adults learning English. Patient practice for every reader, with progress kept privately on their own device.",
 "08_close": "Read-Along Coach. Built on AssemblyAI.",
}
pipe = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M')
out = {}
for key, text in LINES.items():
    chunks = [np.asarray(r.audio) for r in pipe(text, voice='am_michael', speed=1.0) if r.audio is not None]
    audio = np.concatenate(chunks)
    sf.write(f'vo/{key}.wav', audio, 24000)
    out[key] = round(len(audio) / 24000, 3)
    print(key, out[key], file=sys.stderr)
json.dump(out, open('vo/durations.json', 'w'), indent=1)
print(json.dumps(out))
