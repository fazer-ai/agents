import { describe, expect, test } from "bun:test";

// The audio check's deadline is the deployment's, and its default has to cover the slow checks:
// the detector listens again to the doubtful stretches, so the audios most likely to be corrupted
// are the ones that take longest, and a deadline that cuts them sends exactly those unchecked. In
// subprocesses because `bun test` evaluates `@/config` once per worker, so only a child process can
// show what a DIFFERENT environment produces, the empty one included.

async function timeoutIn(
  overrides: Record<string, string | undefined>,
): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined) env[k] = v;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `import config from "@/config"; console.log(String(config.ttsCheck.timeoutMs));`,
    ],
    { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim().split("\n").at(-1) ?? "";
}

describe("the audio check deadline", () => {
  test("unset, it is 30s", async () => {
    expect(await timeoutIn({ TTS_CHECK_TIMEOUT_MS: undefined })).toBe("30000");
  }, 30_000);

  test("set, it is the operator's value", async () => {
    expect(await timeoutIn({ TTS_CHECK_TIMEOUT_MS: "45000" })).toBe("45000");
  }, 30_000);

  test("the example env states the same default", async () => {
    const example = await Bun.file(".env.example").text();
    expect(example).toMatch(/^TTS_CHECK_TIMEOUT_MS=30000$/m);
  });
});
