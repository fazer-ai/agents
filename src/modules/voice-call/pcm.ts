// PCM helpers for the voice bridge: mono signed 16-bit little-endian, base64 on the wire, and a
// stateful windowed-sinc resampler so chunk boundaries do not click and downsampling does not alias.

export function pcmFromBase64(b64: string): Int16Array {
  const bytes = Buffer.from(b64, "base64");
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2);
  return out;
}

export function pcmToBase64(pcm: Int16Array): string {
  const bytes = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) bytes.writeInt16LE(pcm[i] ?? 0, i * 2);
  return bytes.toString("base64");
}

const HALF_TAPS = 16;

/** Converts a continuous stream from one sample rate to another, one chunk at a time. */
export class Resampler {
  private readonly step: number;
  private readonly cutoff: number;
  private history: number[] = [];
  // NOTE: position of the next output sample, in input samples relative to history[0].
  private pos = HALF_TAPS;

  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    this.step = from / to;
    this.cutoff = (Math.min(from, to) / from) * 0.92;
    this.history = new Array(HALF_TAPS).fill(0);
  }

  push(chunk: Int16Array): Int16Array {
    if (this.from === this.to) return chunk;
    for (const v of chunk) this.history.push(v);
    const out: number[] = [];
    while (this.pos + HALF_TAPS < this.history.length) {
      const base = Math.floor(this.pos);
      const frac = this.pos - base;
      let acc = 0;
      let norm = 0;
      for (let k = -HALF_TAPS + 1; k <= HALF_TAPS; k++) {
        const x = k - frac;
        const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / HALF_TAPS);
        const arg = Math.PI * this.cutoff * x;
        const s = arg === 0 ? 1 : Math.sin(arg) / arg;
        const c = s * w;
        acc += (this.history[base + k] ?? 0) * c;
        norm += c;
      }
      out.push(Math.max(-32768, Math.min(32767, Math.round(acc / norm))));
      this.pos += this.step;
    }
    const drop = Math.max(0, Math.floor(this.pos) - HALF_TAPS);
    if (drop > 0) {
      this.history = this.history.slice(drop);
      this.pos -= drop;
    }
    return Int16Array.from(out);
  }
}

/** Duration in milliseconds of a PCM chunk at a sample rate. */
export function pcmMs(samples: number, rate: number): number {
  return (samples / rate) * 1000;
}
