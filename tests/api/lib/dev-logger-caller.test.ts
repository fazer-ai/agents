import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The caller lookup is mounted only when the module loads under NODE_ENV=development, and `bun test`
// pins NODE_ENV=test, so only a child process shows what the development logger does. The child runs
// in its own directory because the development transport writes `logs/` under the working directory.
// Each callback below is an expression-bodied arrow that native code calls: JSC's tail call drops the
// arrow's frame, which leaves the stack with no frame for the caller lookup to read.
const LOGGER = Bun.resolveSync("@/api/lib/logger", import.meta.dir);

const PROBE = `import logger from ${JSON.stringify(LOGGER)};
logger.warn("direct");
Promise.reject(new Error("boom")).catch((e) => logger.warn("from catch %s", e.message)).then(() => console.log("CATCH_RESOLVED"));
Promise.resolve().then(() => logger.warn("from then")).then(() => console.log("THEN_RESOLVED"));
setTimeout(() => logger.warn("from timeout"), 0);
setTimeout(() => console.log("SURVIVED"), 0);
`;

let dir: string;
let run: { out: string; err: string; code: number };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dev-logger-"));
  writeFileSync(join(dir, "probe.ts"), PROBE);
  const proc = Bun.spawn([process.execPath, "probe.ts"], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "development" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  run = {
    out: Bun.stripANSI(out),
    err: Bun.stripANSI(err),
    code: await proc.exited,
  };
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("development logger called with no caller frame on the stack", () => {
  test("the process survives and the reactions settle", () => {
    expect(run.err).not.toContain("TypeError");
    expect(run.code).toBe(0);
    expect(run.out).toContain("CATCH_RESOLVED");
    expect(run.out).toContain("THEN_RESOLVED");
    expect(run.out).toContain("SURVIVED");
  });

  test("each line is still written", () => {
    expect(run.out).toMatch(/WARN \(\d+\): from catch boom$/m);
    expect(run.out).toMatch(/WARN \(\d+\): from then$/m);
    expect(run.out).toMatch(/WARN \(\d+\): from timeout$/m);
  });

  test("a call with its frame on the stack still names that frame as the caller", () => {
    expect(run.out).toMatch(/WARN \(\d+\) <[^>]*probe\.ts:2:\d+>: direct$/m);
  });
});
