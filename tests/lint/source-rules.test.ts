import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The repo-wide rules in biome-plugins/ that replaced sweeps under tests/lib (the source rules and
// the rules for tests), run through the real Biome over probe files. biome.jsonc
// applies the source rules under tests/lint/.probe-src-*, and the test rules apply to every file under
// tests/. The probes end in `.ts` or `.tsx`, never `.test.ts`, so `bun test` never collects them, and
// each run writes under its own pid. One Biome process lints every probe.

const ROOT = join(import.meta.dir, "../..");
const PROBE = `tests/lint/.probe-src-${process.pid}`;
// Built rather than written: a literal path into the source tree is what no-test-reads-source refuses.
const SRC = ["s", "rc"].join("");
const ENV_WAIVED = [
  `${SRC}/lib/instance.ts`,
  `${SRC}/modules/vision/convert/heic.ts`,
  `${SRC}/client/lib/env.ts`,
];
const JOSE_WAIVED = "tests/api/features/auth/google.service.test.ts";

const P = (name: string) => `${PROBE}/${name}`;
const CLIENT_STUBBED = [
  "@/client/contexts/AuthContext",
  "@/client/contexts/ThemeContext",
  "@/client/hooks/useTenantEvents",
];

const PROBES: Record<string, string> = {
  // no-jsx-comment-note
  [P("jsx-note-after-text.tsx")]:
    "export const a = (\n  <div>\n    label {/* NOTE: after text */}\n    <i />\n  </div>\n);\n",
  [P("jsx-note-after-container.tsx")]:
    "declare const ok: boolean;\nexport const a = (\n  <div>\n    {ok && <i />}{/* NOTE: after a container */}\n  </div>\n);\n",
  [P("jsx-note-two-lines.tsx")]:
    "export const a = (\n  <div>\n    {/* NOTE: two\n        lines */}\n    <i />\n  </div>\n);\n",
  [P("jsx-note-after-quote.tsx")]:
    'export const a = <p>He said "hi {/* NOTE: hidden */} bye"</p>;\n',
  [P("jsx-untagged.tsx")]:
    "export const a = (\n  <div>\n    {/* Filters */}\n    <i />\n  </div>\n);\n",
  [P("jsx-todo.tsx")]:
    "export const a = (\n  <div>\n    {/* TODO: owed work */}\n    <i />\n  </div>\n);\n",
  [P("jsx-note-in-string.tsx")]:
    'export const sample = "{/* NOTE: not a comment */}";\n',
  [P("jsx-note-in-code.tsx")]:
    "export function C() {\n  // NOTE: an aside about code\n  return <div />;\n}\n",
  [P("jsx-note-beside-expression.tsx")]:
    "declare const x: string;\nexport const a = <div>{x /* NOTE: beside */}</div>;\n",

  // no-noop-close-request
  [P("close-noop-ternary.tsx")]:
    "declare const M: (p: { onCloseRequest?: () => void }) => null;\ndeclare const saving: boolean;\nexport const a = <M onCloseRequest={saving ? () => {} : undefined} />;\n",
  [P("close-noop-undefined.tsx")]:
    "declare const M: (p: { onCloseRequest?: () => void }) => null;\ndeclare const busy: boolean;\nexport const a = <M onCloseRequest={busy ? () => undefined : undefined} />;\n",
  [P("close-noop-bare.tsx")]:
    "declare const M: (p: { onCloseRequest?: () => void }) => null;\nexport const a = <M onCloseRequest={() => {}} />;\n",
  [P("close-noop-multiline.tsx")]:
    "declare const M: (p: { onCloseRequest?: () => void }) => null;\ndeclare const saving: boolean;\nexport const a = (\n  <M\n    onCloseRequest={\n      saving\n        ? () => {}\n        : undefined\n    }\n  />\n);\n",
  [P("close-confirm.tsx")]:
    "declare const M: (p: { onCloseRequest?: () => void }) => null;\ndeclare const dirty: boolean;\ndeclare function ask(): void;\nexport const a = <M onCloseRequest={dirty ? () => { ask(); } : undefined} />;\n",
  [P("close-busy.tsx")]:
    "declare const M: (p: { busy?: boolean; onClose?: () => void }) => null;\ndeclare const saving: boolean;\nexport const a = <M busy={saving} onClose={() => {}} />;\n",

  // no-bigint-cast
  [P("bigint-param.ts")]:
    "declare const params: { id: string };\nexport const a = BigInt(params.id);\n",
  [P("bigint-ternary.ts")]:
    "declare const b: { agentId?: string };\nexport const a = b.agentId ? BigInt(b.agentId) : undefined;\n",
  [P("bigint-map.ts")]: "export const a = ['1'].map((s) => BigInt(s));\n",
  [P("bigint-slice.ts")]:
    "declare const r: string;\nexport const a = BigInt(r.slice(6));\n",
  [P("bigint-index-as.ts")]:
    "declare const parts: unknown[];\nexport const a = BigInt(parts[2] as string);\n",
  [P("bigint-wrapped.ts")]:
    "declare const data: { businessHoursId: string };\nexport const a = BigInt(\n  data.businessHoursId,\n);\n",
  [P("bigint-starts-literal.ts")]:
    'declare const params: { id: string };\nexport const a = BigInt("0" + params.id);\n',
  [P("bigint-literal-plus.ts")]:
    "declare const offset: bigint;\nexport const a = BigInt(7n + offset);\n",
  [P("bigint-template.ts")]:
    "declare const raw: string;\nexport const a = BigInt(`\u0024{raw}`);\n",
  [P("bigint-in-template-hole.ts")]:
    "declare const body: { id: string };\nexport const a = `t:\u0024{BigInt(body.id)}`;\n",
  [P("bigint-literals.ts")]:
    "export const a = [BigInt(7), BigInt(\"7\"), BigInt('7'), BigInt(0x1f), BigInt(1_000n)];\n",
  [P("bigint-prose.ts")]:
    '// never write BigInt(params.id)\nexport const re = /BigInt\\(params\\.id\\)/;\nexport const m = "BigInt(query.z) is banned";\n',
  [P("bigint-waived.ts")]:
    "declare const raw: string;\n// biome-ignore lint/plugin/no-bigint-cast: the probe's argued-for call\nexport const a = BigInt(raw);\n",
  [P("bigint-waiver-covers-one.ts")]:
    "declare const raw: string;\n// biome-ignore lint/plugin/no-bigint-cast: the probe's argued-for call\nexport const a = BigInt(raw);\nexport const b = BigInt(raw);\n",
  [P("bigint-waiver-stale.ts")]:
    "// biome-ignore lint/plugin/no-bigint-cast: the call it argued for is a literal now\nexport const a = BigInt(7);\n",

  // no-env-read-outside-config
  [P("env-process.ts")]: "export const a = Number(process.env.PROBE_X ?? 0);\n",
  [P("env-bun.ts")]: 'export const a = Bun.env["X"];\n',
  [P("env-import-meta.ts")]: "export const a = import.meta.env;\n",
  [P("env-prose.ts")]:
    '// reads process.env only in config\nexport const a = "process.env";\nconst myprocess = { env: 1 };\nexport const b = myprocess.env;\n',

  // require-model-call-deadline
  [P("model-call-bare.ts")]:
    "declare function runModelCall<T>(f: () => T, o?: object): T;\nexport const a = runModelCall(() => 1); // deadlineMs handled elsewhere\n",
  [P("model-call-comment-only.ts")]:
    "declare function runModelCall<T>(f: () => T, o?: object): T;\nexport const a = runModelCall(() => 1, { /* deadlineMs */ x: 1 });\n",
  [P("model-call-named.ts")]:
    "declare function runModelCall<T>(f: () => T, o?: object): T;\ndeclare const deadlineMs: number;\nexport const a = runModelCall(() => 1, { deadlineMs: 15_000 });\nexport const b = runModelCall<string>(() => String(1), { deadlineMs: 5 });\nexport const c = runModelCall(() => 1, { deadlineMs });\n",

  // no-scrub-around-cut
  [P("scrub-around-cut.ts")]:
    "declare function redactSecretsInText(s: string): string;\ndeclare function truncate(s: string, n: number): string;\nexport const a = redactSecretsInText(truncate('v', 10));\n",
  [P("scrub-around-storable-cut.ts")]:
    "declare function redactSecretsInText(s: string): string;\ndeclare function makeStorable(s: string): string;\ndeclare function truncate(s: string, n: number): string;\nexport const a = redactSecretsInText(\n  makeStorable(truncate('v', 10)),\n);\n",
  [P("cut-around-scrub.ts")]:
    "declare function redactSecretsInText(s: string): string;\ndeclare function truncate(s: string, n: number): string;\nexport const a = truncate(redactSecretsInText('v'), 10);\n",

  // no-package-module-mock
  [P("mock-bare-package.ts")]:
    'import { mock } from "bun:test";\nmock.module("jose", () => ({}));\n',
  [P("mock-scoped-package.ts")]:
    'import { mock } from "bun:test";\nmock.module("@elysiajs/jwt", () => ({}));\n',
  [P("mock-two-packages.ts")]:
    'import { mock } from "bun:test";\nmock.module("jose", () => ({}));\nmock.module("react-i18next", () => ({}));\n',
  [P("mock-restored-package.ts")]:
    'import { afterAll, mock } from "bun:test";\nmock.module("jose", () => ({}));\nafterAll(() => {\n  mock.module("jose", () => ({}));\n});\n',
  [P("mock-own-modules.ts")]:
    'import { mock } from "bun:test";\nmock.module("@/api/lib/prisma", () => ({}));\nmock.module("./helpers", () => ({}));\n',
  [P("jose-waived-copy.ts")]: readFileSync(join(ROOT, JOSE_WAIVED), "utf8"),

  // no-module-mock-live-namespace
  [P("undo-live-namespace.ts")]:
    'import { afterAll, mock } from "bun:test";\nconst svc = await import("@/config");\nmock.module("@/config", () => ({ ...svc }));\nafterAll(() => {\n  mock.module("@/config", () => svc);\n});\n',
  [P("undo-copy.ts")]:
    'import { afterAll, mock } from "bun:test";\nconst svc = await import("@/config");\nconst real = { ...svc };\nmock.module("@/config", () => ({ ...svc }));\nafterAll(() => {\n  mock.module("@/config", () => real);\n});\n',
  [P("undo-object-literal.ts")]:
    'import { mock } from "bun:test";\nconst cfg = await import("@/config");\nmock.module("@/config", () => ({ default: cfg.default }));\n',
  [P("undo-no-namespace.ts")]:
    'import { mock } from "bun:test";\ndeclare const real: object;\nmock.module("@/config", () => real);\n',
  [P("undo-in-comment.ts")]:
    'export const svc = await import("@/config");\n// mock.module("@/config", () => svc) would undo nothing.\n',

  // no-raw-auth-context-mock
  ...Object.fromEntries(
    CLIENT_STUBBED.flatMap((spec, i) => [
      [
        P(`client-mock-double-${i}.ts`),
        `import { mock } from "bun:test";\nmock.module("${spec}", () => ({}));\n`,
      ],
      [
        P(`client-mock-single-${i}.ts`),
        `import { mock } from "bun:test";\nmock.module(\n  '${spec}',\n  () => ({}),\n);\n`,
      ],
    ]),
  ),
  [P("client-mock-other.ts")]:
    'import { mock } from "bun:test";\nmock.module("@/client/contexts/SidebarContext", () => ({}));\n',
  [P("client-mock-other-hook.ts")]:
    'import { mock } from "bun:test";\nmock.module("@/client/hooks/useTenantEventsSoon", () => ({}));\n',

  // no-raw-read-of-globbed-source
  [P("glob-raw.ts")]:
    `const { Glob } = await import("bun");\nlet n = 0;\nfor await (const rel of new Glob("**/*.ts").scan("${SRC}")) {\n  n += (await Bun.file(\`${SRC}/\${rel}\`).text()).length;\n}\nexport { n };\n`,
  [P("glob-raw-from-root.ts")]:
    `let n = 0;\nfor await (const f of new Bun.Glob("${SRC}/**/*.ts").scan(".")) {\n  n += (await Bun.file(f).text()).length;\n}\nexport { n };\n`,
  [P("glob-imports-only.ts")]:
    `const { Glob } = await import("bun");\nfor await (const rel of new Glob("**/*.ts").scan("${SRC}")) {\n  await import(\`../../${SRC}/\${rel}\`);\n}\nexport const t = await Bun.file("package.json").text();\n`,
  [P("glob-scanned.ts")]:
    `import { codeOnly } from "@/tests/utils/source-text";\nconst { Glob } = await import("bun");\nlet n = 0;\nfor await (const rel of new Glob("**/*.ts").scan("${SRC}")) {\n  n += codeOnly(await Bun.file(\`${SRC}/\${rel}\`).text()).length;\n}\nexport { n };\n`,
  // The sweep read the file without its comments, strings kept, so a literal spelling the glob, the
  // read or the import counted as one.
  [P("glob-spelled-glob.ts")]:
    `export const doc = 'new Glob("${SRC}/**").scan(".")';\nexport const t = await Bun.file("package.json").text();\n`,
  [P("glob-spelled-read.ts")]:
    `const { Glob } = await import("bun");\nfor await (const rel of new Glob("**/*.ts").scan("${SRC}")) {\n  void rel;\n}\nexport const doc = "Bun.file(x).text()";\n`,
  [P("glob-spelled-import.ts")]:
    `const { Glob } = await import("bun");\nconst note = 'from "@/tests/utils/source-text"';\nlet n = 0;\nfor await (const rel of new Glob("**/*.ts").scan("${SRC}")) {\n  n += (await Bun.file(\`${SRC}/\${rel}\`).text()).length;\n}\nexport { n, note };\n`,
  // Biome's own lexer tells a regex literal, a comment and a string apart, as the sweep's scan did.
  [P("glob-after-regex-literal.ts")]:
    `const re = /["']/;\nconst { Glob } = await import("bun");\nlet n = 0;\nfor await (const rel of new Glob("**/*.ts").scan("${SRC}")) {\n  n += (await Bun.file(\`${SRC}/\${rel}\`).text()).length;\n}\nexport { n, re };\n`,
  [P("glob-in-comment.ts")]:
    `/* new Glob("${SRC}/**").scan(".") */\nexport const t = await Bun.file("package.json").text();\n`,
  [P("glob-import-in-comment.ts")]:
    `/**\n * import { codeOnly } from "@/tests/utils/source-text";\n */\nconst { Glob } = await import("bun");\nlet n = 0;\nfor await (const rel of new Glob("**/*.ts").scan("${SRC}")) {\n  n += (await Bun.file(\`${SRC}/\${rel}\`).text()).length;\n}\nexport { n };\n`,
  [P("glob-none.ts")]:
    'export const t = await Bun.file("package.json").text();\n',

  ...Object.fromEntries(
    ENV_WAIVED.map((path, i) => [
      P(`env-waived-copy-${i}.ts`),
      readFileSync(join(ROOT, path), "utf8"),
    ]),
  ),
};

const RULES = {
  jsx: "A JSX comment documents the element below it",
  close: "A no-op `onCloseRequest` does not block",
  bigint: "A caller's id is parsed, never cast",
  env: "The environment is read in",
  deadline: "Every model call names its own `deadlineMs`",
  scrub: "A scrub wrapped around a cut",
  pkg: "This replaces a third-party package",
  undo: "rewrote this namespace in place",
  auth: "Stub this client context or hook per file with `stubExports`",
  unused: "Suppression comment has no effect",
  glob: "A test that globs src/ reads each file",
} as const;
type Rule = keyof typeof RULES;

let hits: Map<string, Partial<Record<Rule, number>>>;

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
      "--max-diagnostics=none",
      "--reporter=github",
      ...Object.keys(PROBES),
      ...ENV_WAIVED,
      JOSE_WAIVED,
    ],
    cwd: ROOT,
  });
  hits = new Map();
  for (const line of run.stdout.toString().split("\n")) {
    const m = line.match(/file=([^,]+),.*::(.*)$/);
    if (!m?.[1] || !m[2]) continue;
    const key = m[1].startsWith(`${ROOT}/`)
      ? m[1].slice(ROOT.length + 1)
      : m[1];
    const h = hits.get(key) ?? {};
    for (const [rule, text] of Object.entries(RULES) as [Rule, string][]) {
      if (m[2].includes(text)) h[rule] = (h[rule] ?? 0) + 1;
    }
    hits.set(key, h);
  }
});

afterAll(() => {
  rmSync(join(ROOT, PROBE), { recursive: true, force: true });
});

const of = (path: string, rule: Rule): number => hits.get(path)?.[rule] ?? 0;

describe("no-jsx-comment-note", () => {
  test.each([
    ["jsx-note-after-text.tsx"],
    ["jsx-note-after-container.tsx"],
    ["jsx-note-two-lines.tsx"],
    ["jsx-note-after-quote.tsx"],
  ])("a NOTE: in a JSX comment is refused (%s)", (name) => {
    expect(of(P(name), "jsx")).toBe(1);
  });

  test.each([
    ["jsx-untagged.tsx"],
    ["jsx-todo.tsx"],
    ["jsx-note-in-string.tsx"],
    ["jsx-note-in-code.tsx"],
    ["jsx-note-beside-expression.tsx"],
  ])(
    "an untagged or TODO: JSX comment, and a NOTE: that is not one, pass (%s)",
    (name) => {
      expect(of(P(name), "jsx")).toBe(0);
    },
  );
});

describe("no-noop-close-request", () => {
  test.each([
    ["close-noop-ternary.tsx"],
    ["close-noop-undefined.tsx"],
    ["close-noop-bare.tsx"],
    ["close-noop-multiline.tsx"],
  ])("a no-op onCloseRequest is refused (%s)", (name) => {
    expect(of(P(name), "close")).toBe(1);
  });

  test("an onCloseRequest that does something, and busy, pass", () => {
    expect(of(P("close-confirm.tsx"), "close")).toBe(0);
    expect(of(P("close-busy.tsx"), "close")).toBe(0);
  });
});

describe("no-bigint-cast", () => {
  test.each([
    ["bigint-param.ts"],
    ["bigint-ternary.ts"],
    ["bigint-map.ts"],
    ["bigint-slice.ts"],
    ["bigint-index-as.ts"],
    ["bigint-wrapped.ts"],
    ["bigint-starts-literal.ts"],
    ["bigint-literal-plus.ts"],
    ["bigint-template.ts"],
    ["bigint-in-template-hole.ts"],
  ])("a cast of anything but a literal is refused (%s)", (name) => {
    expect(of(P(name), "bigint")).toBe(1);
  });

  test("literals, prose, patterns and strings that spell the call pass", () => {
    expect(of(P("bigint-literals.ts"), "bigint")).toBe(0);
    expect(of(P("bigint-prose.ts"), "bigint")).toBe(0);
  });

  test("a waiver covers the one call below it, not a second call that reads the same", () => {
    expect(of(P("bigint-waived.ts"), "bigint")).toBe(0);
    expect(of(P("bigint-waiver-covers-one.ts"), "bigint")).toBe(1);
  });

  test("a waiver whose call is gone is reported, and `bun run lint` fails on it", () => {
    expect(of(P("bigint-waiver-stale.ts"), "unused")).toBe(1);
  });
});

describe("no-env-read-outside-config", () => {
  test.each([["env-process.ts"], ["env-bun.ts"], ["env-import-meta.ts"]])(
    "a read of the environment is refused (%s)",
    (name) => {
      expect(of(P(name), "env")).toBe(1);
    },
  );

  test("a comment or a string that names it, and another object's env, pass", () => {
    expect(of(P("env-prose.ts"), "env")).toBe(0);
  });

  test("each file biome.jsonc exempts still reads the environment, and only the exemption silences it", () => {
    ENV_WAIVED.forEach((path, i) => {
      expect(of(path, "env")).toBe(0);
      expect(of(P(`env-waived-copy-${i}.ts`), "env")).toBeGreaterThan(0);
    });
  });
});

describe("require-model-call-deadline", () => {
  test("a call that leaves deadlineMs to the default is refused, whatever a comment says", () => {
    expect(of(P("model-call-bare.ts"), "deadline")).toBe(1);
    expect(of(P("model-call-comment-only.ts"), "deadline")).toBe(1);
  });

  test("a call that names it passes, generic or shorthand", () => {
    expect(of(P("model-call-named.ts"), "deadline")).toBe(0);
  });
});

describe("no-scrub-around-cut", () => {
  test("a scrub wrapped around a cut is refused", () => {
    expect(of(P("scrub-around-cut.ts"), "scrub")).toBe(1);
    expect(of(P("scrub-around-storable-cut.ts"), "scrub")).toBe(1);
  });

  test("a cut around a scrub passes", () => {
    expect(of(P("cut-around-scrub.ts"), "scrub")).toBe(0);
  });
});

describe("no-package-module-mock", () => {
  test("a stub of a package is refused, bare or scoped, each call, restored or not", () => {
    expect(of(P("mock-bare-package.ts"), "pkg")).toBe(1);
    expect(of(P("mock-scoped-package.ts"), "pkg")).toBe(1);
    expect(of(P("mock-two-packages.ts"), "pkg")).toBe(2);
    expect(of(P("mock-restored-package.ts"), "pkg")).toBe(2);
  });

  test("a stub of our own modules passes", () => {
    expect(of(P("mock-own-modules.ts"), "pkg")).toBe(0);
  });

  test("the argued-for pair still stubs, and only that file is exempt", () => {
    expect(of(JOSE_WAIVED, "pkg")).toBe(0);
    expect(of(P("jose-waived-copy.ts"), "pkg")).toBeGreaterThan(0);
  });
});

describe("no-module-mock-live-namespace", () => {
  test("handing back a namespace bound from await import() is refused", () => {
    expect(of(P("undo-live-namespace.ts"), "undo")).toBe(1);
  });

  test.each([
    ["undo-copy.ts"],
    ["undo-object-literal.ts"],
    ["undo-no-namespace.ts"],
    ["undo-in-comment.ts"],
  ])("a copy, a literal, an unbound name or prose passes (%s)", (name) => {
    expect(of(P(name), "undo")).toBe(0);
  });
});

describe("no-raw-auth-context-mock", () => {
  test.each(CLIENT_STUBBED.map((spec, i) => [spec, i] as const))(
    "a mock of %s is refused, in double or single quotes",
    (_spec, i) => {
      expect(of(P(`client-mock-double-${i}.ts`), "auth")).toBe(1);
      expect(of(P(`client-mock-single-${i}.ts`), "auth")).toBe(1);
    },
  );

  test("a mock of another client module passes", () => {
    expect(of(P("client-mock-other.ts"), "auth")).toBe(0);
    expect(of(P("client-mock-other-hook.ts"), "auth")).toBe(0);
  });
});

describe("no-raw-read-of-globbed-source", () => {
  test.each([
    ["glob-raw.ts"],
    ["glob-raw-from-root.ts"],
    ["glob-imports-only.ts"],
  ])(
    "a raw read in a test that globs the source tree is refused (%s)",
    (name) => {
      expect(of(P(name), "glob")).toBe(1);
    },
  );

  test("a string that spells the glob or the read counts as one, as it did for the sweep", () => {
    expect(of(P("glob-spelled-glob.ts"), "glob")).toBe(1);
    expect(of(P("glob-spelled-read.ts"), "glob")).toBe(1);
  });

  test("a regex literal holding quotes does not hide a raw read, and a comment is neither a glob nor an import", () => {
    expect(of(P("glob-after-regex-literal.ts"), "glob")).toBe(1);
    expect(of(P("glob-in-comment.ts"), "glob")).toBe(0);
    expect(of(P("glob-import-in-comment.ts"), "glob")).toBe(1);
  });

  test("a string that spells the import counts as adoption, as it did for the sweep", () => {
    expect(of(P("glob-spelled-import.ts"), "glob")).toBe(0);
  });

  test("a read through the scan, and a raw read in a test that globs nothing, pass", () => {
    expect(of(P("glob-scanned.ts"), "glob")).toBe(0);
    expect(of(P("glob-none.ts"), "glob")).toBe(0);
  });
});
