// NOTE: minimal RIFF/WAVE wrapper for raw 16-bit little-endian PCM. Some TTS providers (ElevenLabs) emit
// raw PCM but no aac/wav container, while Meta's Instagram messaging refuses ogg and mp3 — wrapping
// PCM is a 44-byte header write, not a transcode, so no ffmpeg dependency enters the image.
export function pcmToWav(
  pcm: ArrayBuffer,
  sampleRate: number,
  channels = 1,
): ArrayBuffer {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const out = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(out);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format: linear PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(out).set(new Uint8Array(pcm), 44);
  return out;
}
