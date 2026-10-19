// Which of a voice's samples to play for an operator reading the console in `uiLanguage`: the sample
// in the same locale ("pt-BR"), else in the same language ("pt"), else the voice's general sample.
// A voice verified in European Portuguese only still beats an English sample for a Brazilian operator.

export interface VoiceSamples {
  previewUrl?: string;
  languageSamples?: { language: string; locale?: string; url: string }[];
}

export function pickVoiceSample(
  voice: VoiceSamples,
  uiLanguage: string,
): string | undefined {
  const wanted = uiLanguage.toLowerCase();
  const base = wanted.split("-")[0];
  const samples = voice.languageSamples ?? [];
  return (
    samples.find((s) => s.locale?.toLowerCase() === wanted)?.url ??
    samples.find((s) => s.language.toLowerCase() === base)?.url ??
    voice.previewUrl
  );
}
