import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The lint rules for test files (biome-plugins/no-test-*.grit, require-test-server-hostname.grit,
// no-swallowed-db-probe.grit, no-unscoped-pg-stat-activity.grit) through the real Biome: one process
// lints every probe, written under tests/ as `.ts` (not `.test.ts`, so `bun test` never collects
// them) in a directory named after the run's pid.
//
// The exemption is proven with the SMALLEST listed file of each rule, linted in place and as a copy.
// Biome's time grows with the lines it reads: the 11,772-line tests/graph/runtime.test.ts, linted twice,
// was over 2 s of the hook alone and put it past the 5 s hook timeout on a loaded machine.

const ROOT = join(import.meta.dir, "../..");
const PROBE = `tests/lint/.probe-${process.pid}`;
const TOOLING_PROBE = `tests/tooling/.probe-${process.pid}`;
const UTILS_PROBE = `tests/utils/.probe-${process.pid}`;
// Built rather than written: a literal path in this file is exactly what the first rule refuses, and
// the view's name in an unscoped probe is what the last one refuses.
const SRC = ["s", "rc"].join("");
const DOCS = ["do", "cs"].join("");
const VIEW = ["pg_stat", "activity"].join("_");
const DB = "declare const db: { $queryRaw: (...a: unknown[]) => unknown };\n";
// On the no-test-reads-source list in biome.jsonc. The no-test-real-wait rule has no list: no test
// file is exempt from it, so there is no listed file to prove an exemption with.
const LISTED_SOURCE = "tests/client/debug-warning-source.test.ts";
const APP = "declare const app: { listen: (...a: unknown[]) => unknown };\n";
const PROBE_HEAD =
  "declare const ping: () => Promise<boolean>;\nexport let dbUp = false;\n";

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
  [`${PROBE}/wrapper-arrow.ts`]:
    "export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n",
  [`${PROBE}/wrapper-untyped.ts`]:
    "// @ts-nocheck\nexport const nap = (ms) => new Promise((r) => setTimeout(r, ms));\n",
  [`${PROBE}/wrapper-function.ts`]:
    "export function delay(ms: number) {\n  return new Promise((r) => setTimeout(r, ms));\n}\n",
  [`${PROBE}/wrapper-block-body.ts`]:
    "export const pause = (ms = 5) => {\n  return new Promise<void>((resolve) => {\n    setTimeout(resolve, ms);\n  });\n};\n",
  [`${PROBE}/wrapper-method.ts`]:
    "export const o = {\n  wait(ms: number) {\n    return new Promise((r) => setTimeout(r, ms));\n  },\n};\n",
  [`${PROBE}/wrapper-resolve-arrow.ts`]:
    "export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(() => r(), ms));\n",
  [`${PROBE}/deadline-race.ts`]:
    'export const within = <T>(p: Promise<T>, ms: number) =>\n  Promise.race([p, new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);\n',
  [`${PROBE}/deadline-reject.ts`]:
    'export const bound = (ms: number) =>\n  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("late")), ms));\n',
  [`${PROBE}/timer-not-a-promise.ts`]:
    "export const later = (fn: () => void, ms: number) => setTimeout(fn, ms);\n",
  [`${PROBE}/fake-configured-delay.ts`]:
    "export const fake = (opts: { delayMs: number }) => async () => {\n  await new Promise((r) => setTimeout(r, opts.delayMs));\n};\n",
  [`${PROBE}/fake-closed-over-delay.ts`]:
    "export const fake = (delayMs: number) => async () => {\n  await new Promise((r) => setTimeout(r, delayMs));\n};\n",
  [`${PROBE}/named-constant-delay.ts`]:
    "const SETTLE_MS = 20;\nexport const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));\n",
  [`${UTILS_PROBE}/shared-sleep.ts`]:
    "export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\n",
  [`${PROBE}/listed-source-copy.ts`]: readFileSync(
    join(ROOT, LISTED_SOURCE),
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
  [`${PROBE}/probe-bare-catch.ts`]: `${PROBE_HEAD}try {\n  dbUp = await ping();\n} catch {\n  dbUp = false;\n}\n`,
  [`${PROBE}/probe-named-catch.ts`]: `${PROBE_HEAD}try {\n  dbUp = await ping();\n} catch (e) {\n  console.error(e);\n  dbUp = false;\n}\n`,
  [`${PROBE}/probe-hands-over.ts`]: `import { dbProbeFailed } from "@/tests/db-gate";\n${PROBE_HEAD}try {\n  dbUp = await ping();\n} catch (err) {\n  dbUp = dbProbeFailed(err);\n}\n`,
  [`${PROBE}/probe-false-outside-catch.ts`]: `${PROBE_HEAD}if (!process.env.X) dbUp = false;\n`,
  [`${PROBE}/activity-string.ts`]: `export const q = "SELECT count(*) FROM ${VIEW} WHERE query LIKE '%llm_usage%'";\n`,
  [`${PROBE}/activity-upper-case.ts`]: `export const q = "SELECT count(*) FROM ${VIEW.toUpperCase()}";\n`,
  [`${PROBE}/activity-own-backend-excluded.ts`]: `export const q = \`SELECT count(*) FROM ${VIEW}\n  WHERE state = 'active' AND pid <> pg_backend_pid()\`;\n`,
  [`${PROBE}/activity-tagged-by-name.ts`]: `${DB}const app = "x";\nexport const q = db.$queryRaw\`SELECT pid FROM ${VIEW} WHERE application_name = \${app}\`;\n`,
  [`${PROBE}/activity-own-database.ts`]: `${DB}export const q = db.$queryRaw\`SELECT count(*) FROM ${VIEW}\n  WHERE datname = current_database() AND pid <> pg_backend_pid()\`;\n`,
  [`${PROBE}/activity-target-database.ts`]: `export const q = "SELECT pid FROM ${VIEW} WHERE datname = $1";\n`,
  [`${PROBE}/activity-blocked-by-own-pid.ts`]: `${DB}const pid = 1;\nexport const q = db.$queryRaw\`SELECT pid FROM ${VIEW} WHERE \${pid} = ANY(pg_blocking_pids(pid))\`;\n`,
  [`${PROBE}/activity-joined-on-pid.ts`]: `export const q = "SELECT a.pid FROM pg_locks l JOIN ${VIEW} a ON a.pid = l.pid";\n`,
  [`${PROBE}/activity-in-regex.ts`]: `export const r = /${VIEW}[^.]*WHERE/;\n`,
};

type Hits = {
  source: number;
  wait: number;
  server: number;
  probe: number;
  activity: number;
  wrapper: number;
};
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
    ],
    cwd: ROOT,
  });
  hits = new Map();
  for (const line of run.stdout.toString().split("\n")) {
    const m = line.match(/file=([^,]+),.*::(.*)$/);
    if (!m?.[1] || !m[2]) continue;
    const file = m[1].slice(m[1].indexOf("tests/"));
    const h = hits.get(file) ?? {
      source: 0,
      wait: 0,
      server: 0,
      probe: 0,
      activity: 0,
      wrapper: 0,
    };
    if (m[2].includes("how its source reads")) h.source++;
    if (m[2].includes("does not wait real time")) h.wait++;
    if (m[2].includes("binds 127.0.0.1")) h.server++;
    if (m[2].includes("does not swallow its refusal")) h.probe++;
    if (m[2].includes("for its own database or its own backends")) h.activity++;
    if (m[2].includes("does not define its own sleep")) h.wrapper++;
    hits.set(file, h);
  }
});

afterAll(() => {
  rmSync(join(ROOT, PROBE), { recursive: true, force: true });
  rmSync(join(ROOT, TOOLING_PROBE), { recursive: true, force: true });
  rmSync(join(ROOT, UTILS_PROBE), { recursive: true, force: true });
});

const of = (path: string): Hits =>
  hits.get(path) ?? {
    source: 0,
    wait: 0,
    server: 0,
    probe: 0,
    activity: 0,
    wrapper: 0,
  };
const NONE: Hits = {
  source: 0,
  wait: 0,
  server: 0,
  probe: 0,
  activity: 0,
  wrapper: 0,
};

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

describe("no-test-sleep-wrapper", () => {
  test.each([
    ["wrapper-arrow.ts"],
    ["wrapper-untyped.ts"],
    ["wrapper-function.ts"],
    ["wrapper-block-body.ts"],
    ["wrapper-method.ts"],
    ["wrapper-resolve-arrow.ts"],
  ])(
    "a function whose own parameter is the sleep's delay is refused (%s)",
    (name) => {
      expect(of(`${PROBE}/${name}`).wrapper).toBe(1);
    },
  );

  test.each([
    ["timer-not-a-promise.ts"],
    ["fake-configured-delay.ts"],
    ["fake-closed-over-delay.ts"],
    ["named-constant-delay.ts"],
    ["deadline-race.ts"],
    ["deadline-reject.ts"],
  ])(
    "a timer, a deadline, or a fake's configured delay, is not a sleep of its own (%s)",
    (name) => {
      expect(of(`${PROBE}/${name}`)).toEqual(NONE);
    },
  );

  test("a shared helper under tests/utils/ is outside the rule", () => {
    expect(of(`${UTILS_PROBE}/shared-sleep.ts`)).toEqual(NONE);
  });
});

test.each([["source", LISTED_SOURCE, "listed-source-copy.ts"]] as const)(
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

describe("no-swallowed-db-probe", () => {
  test.each([["probe-bare-catch.ts"], ["probe-named-catch.ts"]])(
    "a catch that sets dbUp = false is refused (%s)",
    (name) => {
      expect(of(`${PROBE}/${name}`).probe).toBe(1);
    },
  );

  test.each([["probe-hands-over.ts"], ["probe-false-outside-catch.ts"]])(
    "a catch that hands the error to dbProbeFailed, or a false set outside a catch, is allowed (%s)",
    (name) => {
      expect(of(`${PROBE}/${name}`)).toEqual(NONE);
    },
  );
});

describe("no-unscoped-pg-stat-activity", () => {
  test.each([
    ["activity-string.ts"],
    ["activity-upper-case.ts"],
    ["activity-own-backend-excluded.ts"],
    ["activity-tagged-by-name.ts"],
  ])(
    "a read of the view narrowed to neither its database nor its own pids is refused (%s)",
    (name) => {
      expect(of(`${PROBE}/${name}`).activity).toBe(1);
    },
  );

  test.each([
    ["activity-own-database.ts"],
    ["activity-target-database.ts"],
    ["activity-blocked-by-own-pid.ts"],
    ["activity-joined-on-pid.ts"],
    ["activity-in-regex.ts"],
  ])(
    "one narrowed by database or pid, or a regex over SQL text, is allowed (%s)",
    (name) => {
      expect(of(`${PROBE}/${name}`)).toEqual(NONE);
    },
  );
});
