// Asks the ElevenLabs CDN for every sound preset's sample file, the one the Call settings tab plays
// before a preset is chosen. The path is not documented by ElevenLabs, and a file that stops
// answering only turns its control back to idle, so nothing in the console says it broke. Run weekly
// by .github/workflows/sound-samples.yml, which opens an issue from the report. Needs no key.
// Run: bun scripts/check-sound-samples.ts
import {
  CALL_BACKGROUND_SOUNDS,
  CALL_TOOL_SOUNDS,
  callSoundSampleUrl,
} from "@/modules/voice-call/settings";

/** The exit code for "a file failed", kept apart from 1 so a crash of the script opens no issue. */
export const SAMPLES_FAILED_EXIT = 3;

const REQUEST_TIMEOUT_MS = 15_000;

export interface SampleProblem {
  preset: string;
  url: string;
  answer: string;
}

/** Each preset once (a preset can be in both lists), with what its file answered when it failed. */
export async function soundSampleProblems(
  fetchImpl: typeof fetch = fetch,
): Promise<{ checked: number; problems: SampleProblem[] }> {
  const presets = [
    ...new Set([...CALL_BACKGROUND_SOUNDS, ...CALL_TOOL_SOUNDS]),
  ];
  const answers = await Promise.all(
    presets.map(async (preset): Promise<SampleProblem | null> => {
      const url = callSoundSampleUrl(preset);
      try {
        const res = await fetchImpl(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const type = res.headers.get("content-type") ?? "";
        if (res.status === 200 && type.startsWith("audio/")) return null;
        return {
          preset,
          url,
          answer: `${res.status} ${type || "(no content type)"}`,
        };
      } catch (e) {
        return {
          preset,
          url,
          answer: `request failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }),
  );
  return {
    checked: presets.length,
    problems: answers.filter((a): a is SampleProblem => a !== null),
  };
}

/** The issue body, or comment, the workflow posts. */
export function problemReport(
  checked: number,
  problems: SampleProblem[],
): string {
  const lines = problems.map(
    (p) => `- \`${p.preset}\`: ${p.answer} (${p.url})`,
  );
  return [
    `${problems.length} of the ${checked} sound sample files the Call settings tab plays did not answer \`200\` with an audio type. The control on each of these presets falls back to idle when pressed.`,
    "",
    ...lines,
    "",
    "The URL comes from `callSoundSampleUrl` in `src/modules/voice-call/settings.ts`.",
  ].join("\n");
}

if (import.meta.main) {
  const { checked, problems } = await soundSampleProblems();
  if (problems.length === 0) {
    console.log(`all ${checked} sound sample files answer`);
  } else {
    console.log(problemReport(checked, problems));
    process.exit(SAMPLES_FAILED_EXIT);
  }
}
