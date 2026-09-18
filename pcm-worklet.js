// Converts mic float32 frames to 16-bit PCM chunks for AssemblyAI streaming.
class PcmWriter extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.len = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) {
      const pcm = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) pcm[i] = Math.max(-1, Math.min(1, ch[i])) * 0x7fff;
      this.buf.push(pcm); this.len += pcm.length;
      if (this.len >= 1600) { // ~100ms @16kHz
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
