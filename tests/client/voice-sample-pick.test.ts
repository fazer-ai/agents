import { expect, test } from "bun:test";
import { pickVoiceSample } from "@/client/lib/voiceSample";

// The sample played for a voice follows the console's language: same locale first, then the same
// language in another locale, then the voice's general sample.

const voice = {
  previewUrl: "https://s.test/general.mp3",
  languageSamples: [
    { language: "pt", locale: "pt-PT", url: "https://s.test/pt-pt.mp3" },
    { language: "pt", locale: "pt-BR", url: "https://s.test/pt-br.mp3" },
    { language: "es", url: "https://s.test/es.mp3" },
  ],
};

test("the operator's locale wins over another locale of the same language", () => {
  expect(pickVoiceSample(voice, "pt-BR")).toBe("https://s.test/pt-br.mp3");
});

test("with no sample in the operator's locale, the same language still beats the general sample", () => {
  expect(pickVoiceSample(voice, "es-MX")).toBe("https://s.test/es.mp3");
});

test("a language the voice was not verified in plays the general sample", () => {
  expect(pickVoiceSample(voice, "en")).toBe("https://s.test/general.mp3");
  expect(pickVoiceSample({}, "pt-BR")).toBeUndefined();
});
