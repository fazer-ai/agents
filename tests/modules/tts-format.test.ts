import { describe, expect, test } from "bun:test";
import { getTtsProvider, pickTtsFormat } from "@/modules/tts/providers";
import { pcmToWav } from "@/modules/tts/wav";

// NOTE: the reply container is decided per destination channel: WhatsApp renders a PTT voice note only for
// Ogg/Opus, while Meta's Instagram messaging accepts audio only as aac/m4a/wav/mp4 (ogg and mp3 are
// refused). pickTtsFormat maps (provider capabilities, channel) → container, or null when the
// provider cannot emit anything the channel accepts (the caller then falls back to a text reply).
describe("pickTtsFormat", () => {
  const openai = getTtsProvider("openai");
  const elevenlabs = getTtsProvider("elevenlabs");
  const openrouter = getTtsProvider("openrouter");
  if (!openai || !elevenlabs || !openrouter) throw new Error("providers");

  test("default channels keep the WhatsApp-first container", () => {
    expect(pickTtsFormat(openai, null)).toBe("ogg_opus");
    expect(pickTtsFormat(openai, "Channel::Api")).toBe("ogg_opus");
    expect(pickTtsFormat(openai, "Channel::Whatsapp")).toBe("ogg_opus");
    expect(pickTtsFormat(elevenlabs, null)).toBe("ogg_opus");
    // openrouter has no Opus output; its default stays mp3 (today's behavior).
    expect(pickTtsFormat(openrouter, null)).toBe("mp3");
  });

  test("Instagram picks an accepted container per provider", () => {
    expect(pickTtsFormat(openai, "Channel::Instagram")).toBe("aac");
    expect(pickTtsFormat(elevenlabs, "Channel::Instagram")).toBe("wav");
  });

  test("Instagram with a provider that cannot comply returns null (text fallback)", () => {
    // openrouter only emits mp3, which Instagram refuses: synthesizing would produce a message that
    // Chatwoot shows as sent and Meta then rejects. Better an honest text reply.
    expect(pickTtsFormat(openrouter, "Channel::Instagram")).toBeNull();
  });

  test("an unknown channel string behaves like the default", () => {
    expect(pickTtsFormat(openai, "Channel::WebWidget")).toBe("ogg_opus");
  });
});

describe("pcmToWav", () => {
  test("wraps raw 16-bit mono PCM in a canonical 44-byte RIFF header", () => {
    const pcm = new Uint8Array([0x01, 0x02]).buffer;
    const wav = pcmToWav(pcm, 24_000);
    expect(wav.byteLength).toBe(46); // 44-byte header + 2 data bytes
    const bytes = new Uint8Array(wav);
    const ascii = (off: number, len: number) =>
      new TextDecoder().decode(bytes.slice(off, off + len));
    const u32 = (off: number) => new DataView(wav).getUint32(off, true);
    const u16 = (off: number) => new DataView(wav).getUint16(off, true);
    expect(ascii(0, 4)).toBe("RIFF");
    expect(u32(4)).toBe(38); // 36 + data size
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(u32(16)).toBe(16); // PCM fmt chunk size
    expect(u16(20)).toBe(1); // audio format: PCM
    expect(u16(22)).toBe(1); // mono
    expect(u32(24)).toBe(24_000); // sample rate
    expect(u32(28)).toBe(48_000); // byte rate = rate * block align
    expect(u16(32)).toBe(2); // block align = channels * 2
    expect(u16(34)).toBe(16); // bits per sample
    expect(ascii(36, 4)).toBe("data");
    expect(u32(40)).toBe(2); // data size
    expect(bytes[44]).toBe(0x01);
    expect(bytes[45]).toBe(0x02);
  });

  test("byte rate and block align follow the channel count", () => {
    const wav = pcmToWav(new ArrayBuffer(8), 44_100, 2);
    const u32 = (off: number) => new DataView(wav).getUint32(off, true);
    const u16 = (off: number) => new DataView(wav).getUint16(off, true);
    expect(u16(22)).toBe(2);
    expect(u32(28)).toBe(176_400); // 44100 * 2ch * 2 bytes
    expect(u16(32)).toBe(4);
  });
});
