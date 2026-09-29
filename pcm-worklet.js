// Converts mic float32 frames to 16-bit PCM chunks for AssemblyAI streaming.
class PcmWriter extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.len = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) {
      const pcm = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) pcm[i] = Math.max(-1, Math.min(1, ch[i])) * 0x7fff;
      this.buf.push(pcm); this.len += pcm.length;
      // ~50ms @16kHz. AssemblyAI's guidance for custom audio is 50-250ms
      // frames, with 50ms the recommended default: larger chunks add latency,
      // much smaller ones add per-message overhead. This was 1600 samples
      // (~100ms), which put a fixed ~50ms of avoidable delay in front of every
      // word before the model had even seen the audio — a real component of
      // the "slight lag with words being highlighted as we read".
      if (this.len >= 800) {
        const out = new Int16Array(this.len);
        let o = 0; for (const b of this.buf) { out.set(b, o); o += b.length; }
        this.port.postMessage(out.buffer, [out.buffer]);
        this.buf = []; this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-writer', PcmWriter);
