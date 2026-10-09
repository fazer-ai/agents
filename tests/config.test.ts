import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseIntSetting } from "@/config";

// Every numeric environment variable goes through one validated parser, and this file keeps that
// true as variables are added. An unchecked `Number(RAW)` turns "15s" into NaN and "1e309" into
// Infinity: a `setInterval` worker then ticks about every millisecond against the database, and
// `Date` arithmetic gets an Invalid Date (the retention sweep stops, the heartbeat never comes due).
// Checked on the SOURCE because `bun test` evaluates `@/config` once per worker, so a hostile
// environment set here never reaches it. The parser itself is driven with hostile input in
// tests/api/middlewares/credentialRateLimit.test.ts; this file proves config.ts routes through it.

// Whole comment lines are dropped before scanning, since the NOTEs in config.ts quote `Number(RAW)`.
// A `Number(` after code on the same line is still read as code, the safe direction to be wrong in.
const isComment = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

const CODE = readFileSync("src/config.ts", "utf8")
  .split("\n")
  .filter((line) => !isComment(line))
  .join("\n");
const ENV_EXAMPLE = readFileSync(".env.example", "utf8");

// Every `Number(x)` call, by argument. The parser converts its own input, so `raw` is the one
// argument allowed to appear; anything else is an environment variable being converted without being
// checked. `Number.isInteger` and `Number.isSafeInteger` do not match, which is deliberate: they are
// the check, not the conversion.
const numberCallArguments = (code: string): string[] => {
  const found = new Set<string>();
  for (const match of code.matchAll(/\bNumber\(([^)]*)\)/g)) {
    const argument = (match[1] ?? "").trim();
    if (argument) found.add(argument);
  }
  return [...found].sort();
};

// Each `parseIntSetting(...)` call, split into its top-level arguments. Walked rather than matched: a
// regex cannot tell the call's closing paren from an inner one, nor an argument comma from a comma
// inside a consequence sentence, which several calls have.
interface Call {
  variable: string;
  reportedAs: string;
  fallback: string;
  minimum: string | undefined;
}

const parserCalls = (code: string): Call[] => {
  const calls: Call[] = [];
  const CALL = "parseIntSetting(";
  for (
    let at = code.indexOf(CALL);
    at !== -1;
    at = code.indexOf(CALL, at + 1)
  ) {
    let depth = 1;
    let quote: string | undefined;
    const args: string[] = [];
    let current = "";
    let i = at + CALL.length;
    for (; i < code.length && depth > 0; i++) {
      const ch = code[i] as string;
      if (quote) {
        if (ch === "\\") {
          current += ch + (code[i + 1] ?? "");
          i++;
          continue;
        }
        if (ch === quote) quote = undefined;
        current += ch;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === "(") depth++;
      if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
      if (ch === "," && depth === 1) {
        args.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    if (current.trim()) args.push(current.trim());
    calls.push({
      variable: args[0] ?? "",
      reportedAs: (args[1] ?? "").replaceAll('"', ""),
      fallback: (args[2] ?? "").replaceAll("_", ""),
      minimum: args[5],
    });
  }
  return calls;
};

const CALLS = parserCalls(CODE);

describe("numeric environment parsing", () => {
  // NOTE: a variable added with the unchecked `Number(RAW)` shape shows up here by name.
  test("nothing is converted to a number without being checked", () => {
    expect(numberCallArguments(CODE)).toEqual(["raw"]);
  });

  // NOTE: one variable's value reported under another's name gives the operator an error naming a variable
  // they never set, and no type checker sees it because both sides are just strings.
  test("every parsed variable is reported under its own name", () => {
    const mismatched = CALLS.filter(
      (call) => call.variable !== call.reportedAs,
    ).map((call) => `${call.variable} reported as ${call.reportedAs}`);
    expect(mismatched).toEqual([]);
  });

  // NOTE: a mistyped fallback runs the app on a number nobody chose. Checked against `.env.example` rather
  // than a list here, because that is where the operator reads the default, so this also fails when
  // the documentation drifts from the code or a parsed variable is not documented at all.
  test("every default is the one .env.example documents", () => {
    const documented = new Map(
      [...ENV_EXAMPLE.matchAll(/^([A-Z][A-Z0-9_]*)=([0-9]+)\s*$/gm)].map(
        (match) => [match[1] as string, match[2] as string],
      ),
    );
    const disagreements = CALLS.filter(
      (call) => documented.get(call.variable) !== call.fallback,
    ).map(
      (call) =>
        `${call.variable}: config.ts says ${call.fallback}, .env.example says ${documented.get(call.variable) ?? "nothing"}`,
    );
    expect(disagreements).toEqual([]);
  });

  // NOTE: zero is admitted only where the CONSUMER treats it as a value rather than an absence; elsewhere it
  // is a 1ms tick, a heartbeat due at `now`, or a port nothing can route to. Widening the exception
  // fails here until someone makes it deliberately.
  test("zero is a value at one setting, and this is which", () => {
    const admitZero = CALLS.filter((call) => call.minimum === "0").map(
      (call) => call.variable,
    );
    expect(admitZero).toEqual(["ALERT_COALESCE_WINDOW_MS"]);
  });

  // Every variable is checked, so the scan above must be finding calls at all. Without this, deleting
  // the parser and every call site would leave both tests above green.
  test("the parser is actually used", () => {
    expect(CALLS.length).toBeGreaterThanOrEqual(13);
    expect(new Set(CALLS.map((call) => call.variable)).size).toBe(CALLS.length);
  });
});

// Why a timer variable is refused above 2_147_483_647: past it the runtime SETS the delay to 1, so
// "tick every 25 days" is a worker spinning against the database.
describe("the timer bound is the runtime's, not a policy", () => {
  test("a delay above it is not honoured, it collapses to about a millisecond", async () => {
    const firedImmediately = await new Promise<boolean>((resolve) => {
      // If the runtime honoured this, the callback would be due in about 24.8 days.
      const interval = setInterval(() => {
        clearInterval(interval);
        clearTimeout(guard);
        resolve(true);
      }, 2_147_483_648);
      // Resolves false instead of hanging, so a runtime that starts honouring long delays fails
      // this test in two seconds rather than blocking the suite.
      const guard = setTimeout(() => {
        clearInterval(interval);
        resolve(false);
      }, 2_000);
    });
    expect(firedImmediately).toBe(true);
  });
});

// An agent's burst window may be shorter than the observe drain's interval, so the
// interval is a safety net with a floor of its own, and the operator reads both numbers where the
// variable is set.
describe("the observe drain's interval", () => {
  const call = CALLS.find((c) => c.variable === "OBSERVE_WORKER_INTERVAL_MS");

  test("has a default and a minimum of its own", () => {
    expect(call?.fallback).toBe("2500");
    expect(call?.minimum).toBe("100");
  });

  test(".env.example states the default and the minimum next to the variable", () => {
    const at = ENV_EXAMPLE.indexOf("OBSERVE_WORKER_INTERVAL_MS=");
    expect(at).toBeGreaterThan(-1);
    const note = ENV_EXAMPLE.slice(Math.max(0, at - 700), at);
    expect(note).toContain("default 2500, minimum 100");
  });

  test("a value below the minimum is refused by name at boot", () => {
    expect(() =>
      parseIntSetting(
        "99",
        "OBSERVE_WORKER_INTERVAL_MS",
        2_500,
        "why.",
        2_147_483_647,
        Number(call?.minimum),
      ),
    ).toThrow(/OBSERVE_WORKER_INTERVAL_MS must be a whole number between 100/);
  });
});

// The parser's own handling of the minimum, driven directly. Everything else about it (blanks,
// `Infinity`, `1e309`, fractions, negatives, garbage, the upper bound) is covered in
// tests/api/middlewares/credentialRateLimit.test.ts.
describe("the minimum", () => {
  test("zero is refused by default and admitted when a setting asks for it", () => {
    expect(() =>
      parseIntSetting(
        "0",
        "COMPACTION_WORKER_INTERVAL_MS",
        15_000,
        "why.",
        2_147_483_647,
      ),
    ).toThrow(/between 1 and/);
    expect(
      parseIntSetting(
        "0",
        "ALERT_COALESCE_WINDOW_MS",
        30_000,
        "why.",
        2_147_483_647,
        0,
      ),
    ).toBe(0);
  });

  // The message has to name the minimum it applied, not a constant 1, or the operator who set zero
  // deliberately is told the opposite of what the setting accepts.
  test("the error names the minimum that was applied", () => {
    expect(() =>
      parseIntSetting(
        "-1",
        "ALERT_COALESCE_WINDOW_MS",
        30_000,
        "why.",
        2_147_483_647,
        0,
      ),
    ).toThrow(/between 0 and/);
  });
});

// The storage-directory fallback chain, read off config.ts rather than driven with an environment.
// Same reason as above: `@/config` is evaluated once per worker, so a test that set the variables
// would be asserting whatever the environment held when the first file in the worker imported it.
describe("documentsStorageDir fallback chain", () => {
  const source = readFileSync("src/config.ts", "utf8");

  // NOTE: the ORDER matters: Coolify freezes a compose `environment:` value at install time, so an existing
  // install keeps QUOTES_STORAGE_DIR forever. Without that fallback it lands on the in-container
  // default and every PDF disappears on the next redeploy, silently.
  test("prefers the new name, then the frozen old one, then the default", () => {
    expect(source).toContain(
      'DOCUMENTS_STORAGE_DIR || QUOTES_STORAGE_DIR || "./data/documents"',
    );
  });

  // NOTE: a variable the composes do not declare lands on that in-container default, which is the same
  // silent loss from the other direction, for a NEW installation.
  test("every deploy compose declares the storage directory", () => {
    for (const file of [
      "docker-compose.prod.yml",
      "docker-compose.coolify.yml",
      "docker-compose.portainer.yml",
    ]) {
      const compose = readFileSync(file, "utf8");
      expect(compose).toContain("DOCUMENTS_STORAGE_DIR=/app/storage/documents");
      // NOTE: the old name stays declared too, for installations created before the rename.
      expect(compose).toContain("QUOTES_STORAGE_DIR=");
    }
  });
});

// A setting the deploy composes do not forward cannot be tuned there: the stack's variable never
// reaches the container, which keeps the default in silence.
describe("Chatwoot receiver settings in the deploy composes", () => {
  test("every deploy compose forwards both, with the documented defaults", () => {
    for (const file of [
      "docker-compose.prod.yml",
      "docker-compose.coolify.yml",
      "docker-compose.portainer.yml",
    ]) {
      const compose = readFileSync(file, "utf8");
      expect(compose).toMatch(
        /CHATWOOT_DELIVERY_CONCURRENCY=\$\{CHATWOOT_DELIVERY_CONCURRENCY:-15\}/,
      );
      expect(compose).toMatch(
        /CHATWOOT_ACK_POOL_MAX=\$\{CHATWOOT_ACK_POOL_MAX:-4\}/,
      );
    }
  });
});
