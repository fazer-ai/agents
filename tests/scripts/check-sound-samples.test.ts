import { describe, expect, test } from "bun:test";
import {
  problemReport,
  soundSampleProblems,
} from "@/../scripts/check-sound-samples";
import {
  CALL_BACKGROUND_SOUNDS,
  CALL_TOOL_SOUNDS,
  callSoundSampleUrl,
} from "@/modules/voice-call/settings";

// A CDN that answers each file the way `answer` says, and records what was asked.
function cdn(answer: (url: string) => Response | Error) {
  const asked: { url: string; method: string }[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    asked.push({ url, method: init?.method ?? "GET" });
    const a = answer(url);
    if (a instanceof Error) throw a;
    return a;
  }) as typeof fetch;
  return { asked, fetchImpl };
}

const audio = () =>
  new Response(null, {
    status: 200,
    headers: { "content-type": "audio/mpeg" },
  });

const presets = [...new Set([...CALL_BACKGROUND_SOUNDS, ...CALL_TOOL_SOUNDS])];

describe("the weekly sound sample check", () => {
  test("asks for every preset's file once, by HEAD, and finds nothing when all answer audio", async () => {
    const { asked, fetchImpl } = cdn(audio);
    const { checked, problems } = await soundSampleProblems(fetchImpl);
    expect(problems).toEqual([]);
    expect(checked).toBe(presets.length);
    expect(asked.map((a) => a.url).sort()).toEqual(
      presets.map((p) => callSoundSampleUrl(p)).sort(),
    );
    expect(new Set(asked.map((a) => a.method))).toEqual(new Set(["HEAD"]));
  });

  test("a file that is gone is reported with its status, and only that one", async () => {
    const gone = callSoundSampleUrl("restaurant");
    const { fetchImpl } = cdn((url) =>
      url === gone ? new Response(null, { status: 404 }) : audio(),
    );
    const { problems } = await soundSampleProblems(fetchImpl);
    expect(problems).toEqual([
      { preset: "restaurant", url: gone, answer: "404 (no content type)" },
    ]);
  });

  test("a 200 that is not audio is a failure too", async () => {
    const page = callSoundSampleUrl("typing");
    const { fetchImpl } = cdn((url) =>
      url === page
        ? new Response(null, {
            status: 200,
            headers: { "content-type": "text/html" },
          })
        : audio(),
    );
    const { problems } = await soundSampleProblems(fetchImpl);
    expect(problems.map((p) => [p.preset, p.answer])).toEqual([
      ["typing", "200 text/html"],
    ]);
  });

  test("an error status is a failure even when it says audio", async () => {
    const locked = callSoundSampleUrl("office1");
    const { fetchImpl } = cdn((url) =>
      url === locked
        ? new Response(null, {
            status: 403,
            headers: { "content-type": "audio/mpeg" },
          })
        : audio(),
    );
    const { problems } = await soundSampleProblems(fetchImpl);
    expect(problems.map((p) => [p.preset, p.answer])).toEqual([
      ["office1", "403 audio/mpeg"],
    ]);
  });

  test("a request that fails is reported, and the others are still checked", async () => {
    const down = callSoundSampleUrl("city");
    const { asked, fetchImpl } = cdn((url) =>
      url === down ? new Error("connection reset") : audio(),
    );
    const { problems } = await soundSampleProblems(fetchImpl);
    expect(problems.map((p) => [p.preset, p.answer])).toEqual([
      ["city", "request failed: connection reset"],
    ]);
    expect(asked).toHaveLength(presets.length);
  });

  test("the report names each failed preset with what it answered and its URL", () => {
    const report = problemReport(9, [
      {
        preset: "city",
        url: "https://cdn.example/city.mp3",
        answer: "404 (no content type)",
      },
    ]);
    expect(report).toContain("1 of the 9 sound sample files");
    expect(report).toContain(
      "- `city`: 404 (no content type) (https://cdn.example/city.mp3)",
    );
  });
});
