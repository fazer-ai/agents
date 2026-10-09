import { describe, expect, test } from "bun:test";
import { join } from "node:path";

// The real signal on a real process: SIGTERM no longer exits on the spot. The process waits for its
// work, exits as soon as the work ends, and at the bound cuts what is left and logs how many were still
// running. tests/fixtures/shutdown/harness.ts installs the same handlers src/index.ts does.

const HARNESS = join(import.meta.dir, "../fixtures/shutdown/harness.ts");

async function runUntilSignal(
  args: string[],
  signal: "SIGTERM" | "SIGINT" = "SIGTERM",
): Promise<{ exitedAfterMs: number; code: number | null; out: string }> {
  const proc = Bun.spawn(["bun", HARNESS, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NODE_ENV: "test" },
  });
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (!out.includes("HARNESS ready")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`harness ended before ready: ${out}`);
    out += decoder.decode(value);
  }
  const t = performance.now();
  proc.kill(signal);
  const rest = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      out += decoder.decode(value);
    }
  })();
  const code = await proc.exited;
  const exitedAfterMs = performance.now() - t;
  await rest;
  return { exitedAfterMs, code, out };
}

describe("SIGTERM drains before exiting", () => {
  test("an idle process exits at once", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const r = await runUntilSignal(["5000"], signal);
      expect(r.code).toBe(0);
      expect(r.exitedAfterMs).toBeLessThan(1_000);
      expect(r.out).toContain("drained");
    }
  });

  test("work in flight finishes before the exit, and the exit follows it", async () => {
    const r = await runUntilSignal(["5000", "1500"]);
    expect(r.out).toContain("HARNESS stop");
    expect(r.out).toContain("HARNESS done 1500");
    expect(r.out).not.toContain("HARNESS cut");
    expect(r.code).toBe(0);
    expect(r.exitedAfterMs).toBeGreaterThanOrEqual(1_300);
    expect(r.exitedAfterMs).toBeLessThan(3_000);
  });

  test("at the bound the rest is cut, and the log says how many were still running", async () => {
    const r = await runUntilSignal(["1000", "300", "hang", "hang"]);
    expect(r.code).toBe(0);
    expect(r.exitedAfterMs).toBeGreaterThanOrEqual(900);
    expect(r.exitedAfterMs).toBeLessThan(2_500);
    expect(r.out.match(/HARNESS cut/g)).toHaveLength(2);
    const line = r.out
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l))
      .find((l) => String(l.msg).includes("drain bound"));
    expect(line?.stillRunning).toBe(2);
    expect(line?.byKind).toEqual({ DEBOUNCE: 2 });
  });
});
