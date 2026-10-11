import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The lint rules for test files (biome-plugins/no-test-reads-source.grit, no-test-real-wait.grit and
// require-test-server-hostname.grit), run through the real Biome over probe files written under
// tests/. One Biome process lints every probe. The probes end in `.ts`, not `.test.ts`, so `bun test`
// never collects them, and each run writes under its own pid.
//
// The exemption is proven with the SMALLEST listed file of each rule, linted in place and as a copy.
// Biome's time grows with the lines it reads: the 11,772-line tests/graph/runtime.test.ts, linted twice,
// was over 2 s of the hook alone and put it past the 5 s hook timeout on a loaded machine.

const ROOT = join(import.meta.dir, "../..");
const PROBE = `tests/lint/.probe-${process.pid}`;
const TOOLING_PROBE = `tests/tooling/.probe-${process.pid}`;
// Built rather than written: a literal path in this file is exactly what the first rule refuses.
const SRC = ["s", "rc"].join("");
const DOCS = ["do", "cs"].join("");
// On the no-test-reads-source list, and on the no-test-real-wait list, in biome.jsonc.
const LISTED_SOURCE = "tests/client/import-warnings-rendered.test.ts";
const LISTED_WAIT = "tests/api/features/realtime/realtime.controller.test.ts";
const APP = "declare const app: { listen: (...a: unknown[]) => unknown };\n";

const PROBES: Record<string, string> = {
  [`${PROBE}/src-path.ts`]: `import { readFileSync } from "node:fs";\nexport const a = readFileSync("${SRC}/config.ts", "utf8");\n`,
  [`${PROBE}/src-dir.ts`]: `export const a = ["x", "${SRC}"];\n`,
  [`${PROBE}/src-relative.ts`]: `export const a = "../../${SRC}/config.ts";\n`,
  [`${PROBE}/src-template.ts`]: `const f = "config";\nexport const a = \`${SRC}/\${f}.ts\`;\n`,
  [`${PROBE}/docs-path.ts`]: `export const a = "${DOCS}/deploy.md";\n`,
  [`${PROBE}/not-a-source-path.ts`]: `export const a = ["tests/fixtures/a.pdf", "srcset", "a-${SRC}-b"];\n`,
  [`${TOOLING_PROBE}/path-as-data.ts`]: `export const a = "${SRC}/api/v1/tenants.ts";\n`,
  [`${PROBE}/sleep-300.ts`]: "export const a = Bun.sleep(300);\n",
  [`${PROBE}/sleep-3000-separated.ts`]: "export const a = Bun.sleep(3_000);\n",
  [`${PROBE}/timeout-2500.ts`]:
    "export const a = new Promise((r) => setTimeout(r, 2500));\n",
  [`${PROBE}/sleep-50.ts`]: "export const a = Bun.sleep(50);\n",
  [`${PROBE}/sleep-5_0.ts`]: "export const a = Bun.sleep(5_0);\n",
  [`${PROBE}/sleep-50.5.ts`]: "export const a = Bun.sleep(50.5);\n",
  [`${PROBE}/sleep-150.5.ts`]: "export const a = Bun.sleep(150.5);\n",
  [`${PROBE}/sleep-49.ts`]: "export const a = Bun.sleep(49);\n",
  [`${PROBE}/sleep-49.9.ts`]: "export const a = Bun.sleep(49.9);\n",
  [`${PROBE}/sleep-0.500.ts`]: "export const a = Bun.sleep(0.500);\n",
  [`${PROBE}/sleep-digits-in-name.ts`]:
    "const ms500 = 1;\nexport const a = Bun.sleep(ms500);\n",
  [`${PROBE}/timeout-10.ts`]:
    "export const a = (fn: () => void) => setTimeout(fn, 10);\n",
  [`${PROBE}/listed-source-copy.ts`]: readFileSync(
    join(ROOT, LISTED_SOURCE),
    "utf8",
  ),
  [`${PROBE}/listed-wait-copy.ts`]: readFileSync(
    join(ROOT, LISTED_WAIT),
    "utf8",
  ),
  [`${PROBE}/serve-no-hostname.ts`]:
    'export const s = Bun.serve({ port: 0, fetch: () => new Response("x") });\n',
  [`${PROBE}/serve-reads-hostname.ts`]:
    "export const s = Bun.serve({ port: 0, fetch: (r: Request) => new Response(new URL(r.url).hostname) });\n",
  [`${PROBE}/listen-port-only.ts`]: `${APP}export const l = app.listen(0);\n`,
  [`${PROBE}/listen-port-callback.ts`]: `${APP}export const l = app.listen(0, () => {});\n`,
  [`${PROBE}/listen-other-host.ts`]: `${APP}export const l = app.listen(0, "0.0.0.0", () => {});\n`,
  [`${PROBE}/serve-wildcard-host.ts`]:
    'export const s = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("x") });\n',
  [`${PROBE}/serve-ipv6-wildcard.ts`]:
    'export const s = Bun.serve({ hostname: "::", port: 0, fetch: () => new Response("x") });\n',
  [`${PROBE}/listen-options-wildcard.ts`]: `${APP}export const l = app.listen({ port: 0, hostname: "0.0.0.0" });\n`,
  [`${PROBE}/serve-loopback.ts`]:
    'export const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });\n',
  [`${PROBE}/listen-options-loopback.ts`]: `${APP}export const l = app.listen({ port: 0, hostname: "127.0.0.1" });\n`,
  [`${PROBE}/listen-node-loopback.ts`]: `${APP}export const l = app.listen(0, "127.0.0.1", () => {});\n`,
};

type Hits = { source: number; wait: number; server: number };
let hits: Map<string, Hits>;

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
      LISTED_SOURCE,
      LISTED_WAIT,
    ],
    cwd: ROOT,
  });
  hits = new Map();
  for (const line of run.stdout.toString().split("\n")) {
    const m = line.match(/file=([^,]+),.*::(.*)$/);
    if (!m?.[1] || !m[2]) continue;
    const file = m[1].slice(m[1].indexOf("tests/"));
    const h = hits.get(file) ?? { source: 0, wait: 0, server: 0 };
    if (m[2].includes("how its source reads")) h.source++;
    if (m[2].includes("does not wait real time")) h.wait++;
    if (m[2].includes("binds 127.0.0.1")) h.server++;
    hits.set(file, h);
  }
});

afterAll(() => {
  rmSync(join(ROOT, PROBE), { recursive: true, force: true });
  rmSync(join(ROOT, TOOLING_PROBE), { recursive: true, force: true });
});

const of = (path: string): Hits =>
  hits.get(path) ?? { source: 0, wait: 0, server: 0 };
const NONE: Hits = { source: 0, wait: 0, server: 0 };

describe("no-test-reads-source", () => {
  test.each([
    ["src-path.ts"],
    ["src-dir.ts"],
    ["src-relative.ts"],
    ["src-template.ts"],
    ["docs-path.ts"],
  ])("a path into src/ or docs/ in a new test file is refused (%s)", (name) => {
    expect(of(`${PROBE}/${name}`).source).toBe(1);
  });

  test("a path that only contains the word is not", () => {
    expect(of(`${PROBE}/not-a-source-path.ts`)).toEqual(NONE);
  });

  test("tests/tooling handles paths as data and is out of scope", () => {
    expect(of(`${TOOLING_PROBE}/path-as-data.ts`)).toEqual(NONE);
  });
});

describe("no-test-real-wait", () => {
  test.each([
    ["sleep-300.ts"],
    ["sleep-3000-separated.ts"],
    ["timeout-2500.ts"],
    ["sleep-50.ts"],
    ["sleep-5_0.ts"],
    ["sleep-50.5.ts"],
    ["sleep-150.5.ts"],
  ])("a literal wait of 50ms or more is refused (%s)", (name) => {
    expect(of(`${PROBE}/${name}`).wait).toBe(1);
  });

  test.each([
    ["sleep-49.ts"],
    ["sleep-49.9.ts"],
    ["sleep-0.500.ts"],
    ["timeout-10.ts"],
    ["sleep-digits-in-name.ts"],
  ])("under 50ms, or not a literal, is allowed (%s)", (name) => {
    expect(of(`${PROBE}/${name}`).wait).toBe(0);
  });
});

test.each([
  ["source", LISTED_SOURCE, "listed-source-copy.ts"],
  ["wait", LISTED_WAIT, "listed-wait-copy.ts"],
] as const)(
  "a file on the %s list is exempt, and the same content anywhere else is not",
  (rule, listed, copy) => {
    expect(of(`${PROBE}/${copy}`)[rule]).toBeGreaterThan(0);
    expect(of(listed)).toEqual(NONE);
  },
);

describe("require-test-server-hostname", () => {
  test.each([
    ["serve-no-hostname.ts"],
    ["serve-reads-hostname.ts"],
    ["listen-port-only.ts"],
    ["listen-port-callback.ts"],
    ["listen-other-host.ts"],
    ["serve-wildcard-host.ts"],
    ["serve-ipv6-wildcard.ts"],
    ["listen-options-wildcard.ts"],
  ])("a test server that names no loopback host is refused (%s)", (name) => {
    expect(of(`${PROBE}/${name}`).server).toBe(1);
  });

  test.each([
    ["serve-loopback.ts"],
    ["listen-options-loopback.ts"],
    ["listen-node-loopback.ts"],
  ])("one bound to 127.0.0.1 is allowed (%s)", (name) => {
    expect(of(`${PROBE}/${name}`)).toEqual(NONE);
  });
});
