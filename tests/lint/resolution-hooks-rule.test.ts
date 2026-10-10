import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// biome-plugins/require-resolution-hooks.grit, run through the real Biome over probe files written
// under tests/lint (biome.jsonc applies the rule there and to the modules). The probes end in `.ts`,
// not `.test.ts`, so `bun test` never collects them, and each run writes under its own pid.

const ROOT = join(import.meta.dir, "../..");
const PROBE = `tests/lint/.probe-hooks-${process.pid}`;

const DECL =
  "declare function announceStatusChange(db: unknown, t: bigint, p: unknown): Promise<void>;\ndeclare function runResolutionHooks(p: unknown): Promise<void>;\n";

const PROBES: Record<string, string> = {
  // A status the caller hands in can be `resolved`.
  [`${PROBE}/variable-status.ts`]: `${DECL}export async function w(db: unknown, s: string) {\n  await announceStatusChange(db, 1n, { conversationId: 1n, status: s, previousStatus: "open" });\n}\n`,
  [`${PROBE}/literal-resolved.ts`]: `${DECL}export async function w(db: unknown) {\n  await announceStatusChange(db, 1n, { status: "resolved", previousStatus: "open" });\n}\n`,
  // Inside a callback, with a return type: the shape the real writers have.
  [`${PROBE}/nested-typed.ts`]: `${DECL}export async function w(db: unknown, s: string): Promise<void> {\n  await [1].map(async () => {\n    await announceStatusChange(db, 1n, { status: s, previousStatus: "open" });\n  });\n}\n`,
  [`${PROBE}/literal-open.ts`]: `${DECL}export async function w(db: unknown) {\n  await announceStatusChange(db, 1n, { status: "open", previousStatus: "pending" });\n}\n`,
  [`${PROBE}/runs-hooks.ts`]: `${DECL}export async function w(db: unknown, s: string): Promise<void> {\n  await [1].map(async () => {\n    await announceStatusChange(db, 1n, { status: s, previousStatus: "open" });\n  });\n  if (s === "resolved") await runResolutionHooks({});\n}\n`,
  // The hooks in one function do not cover a writer in another.
  [`${PROBE}/neighbour.ts`]: `${DECL}export async function a(db: unknown, s: string) {\n  await announceStatusChange(db, 1n, { status: s, previousStatus: "open" });\n  await runResolutionHooks({});\n}\nexport async function b(db: unknown, s: string) {\n  await announceStatusChange(db, 1n, { status: s, previousStatus: "open" });\n}\n`,
};

let hits: Map<string, number[]>;

beforeAll(() => {
  for (const [path, body] of Object.entries(PROBES)) {
    mkdirSync(join(ROOT, path, ".."), { recursive: true });
    writeFileSync(join(ROOT, path), body);
  }
  const run = Bun.spawnSync({
    cmd: [
      "bun",
      "biome",
      "lint",
      "--only=plugin",
      "--max-diagnostics=none",
      "--reporter=github",
      ...Object.keys(PROBES),
    ],
    cwd: ROOT,
  });
  hits = new Map();
  for (const line of run.stdout.toString().split("\n")) {
    const m = line.match(/file=([^,]+),line=(\d+),.*::(.*)$/);
    if (!m?.[1] || !m[2] || !m[3]?.includes("runResolutionHooks")) continue;
    const file = m[1].slice(m[1].indexOf("tests/"));
    hits.set(file, [...(hits.get(file) ?? []), Number(m[2])]);
  }
});

afterAll(() => {
  rmSync(join(ROOT, PROBE), { recursive: true, force: true });
});

describe("require-resolution-hooks", () => {
  test("a writer that can resolve and runs no hooks is refused", () => {
    expect(hits.get(`${PROBE}/variable-status.ts`)).toEqual([3]);
    expect(hits.get(`${PROBE}/literal-resolved.ts`)).toEqual([3]);
    expect(hits.get(`${PROBE}/nested-typed.ts`)).toEqual([3]);
  });

  test("a writer of another literal, or one that runs the hooks, passes", () => {
    expect(hits.get(`${PROBE}/literal-open.ts`)).toBeUndefined();
    expect(hits.get(`${PROBE}/runs-hooks.ts`)).toBeUndefined();
  });

  test("the hooks one function runs do not cover its neighbour", () => {
    expect(hits.get(`${PROBE}/neighbour.ts`)).toEqual([7]);
  });
});
