import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseIntSetting } from "@/config";

// Every numeric environment variable goes through one validated parser, and this file is what keeps
// that true as variables are added.
//
// The shape being replaced was `RAW ? Number(RAW) : fallback`, which converts and asks nothing.
// `Number("15s")` is NaN and `Number("1e309")` is Infinity, and both reach whatever consumes them.
// On the five that feed `setInterval` (the webhook, scheduler, debounce, compaction and alert
// workers) that is not a slow tick, it is a HOT one: measured in Bun, twenty ticks at a NaN delay
// took 23.6ms and twenty at Infinity took 22.8ms, about 1.15ms each, against the 15_000ms the
// operator wrote. `COMPACTION_WORKER_INTERVAL_MS=15s` is a plausible typo, the compaction worker is
// on by default, and its tick claims jobs against the database. The rest fail quietly instead:
// `FLOWLOG_RETENTION_DAYS` and `HEARTBEAT_INTERVAL_MS` reach `Date` arithmetic, where the same
// values give an Invalid Date, so the daily sweep stops deleting and the heartbeat never comes due.
//
// Checked on the SOURCE, not by driving config with a hostile environment. `bun test` shares one
// module registry across files in a worker, so `@/config` is evaluated once with whatever the
// environment held at that moment, and a later dynamic import returns the cached module. The parser
// itself is a pure exported function and IS driven with hostile input, in
// tests/api/middlewares/credentialRateLimit.test.ts, which covers blanks, `Infinity`, `1e309`,
// fractions, zero, negatives, garbage and the upper bound. What that cannot show is whether
// config.ts routes through it, which is what this file is for.
//
// NOTE: comment lines are dropped before scanning. The NOTEs in config.ts quote the shape being
// replaced, so scanning the raw text reported `Number("x")` and `Number(RAW)` out of prose and would
// have tied this test to how the file explains itself. Only whole comment lines are dropped, which
// is where every mention in that file lives; a `Number(` written after code on the same line is
// still read as code, and that is the safe direction to be wrong in.
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

// Each `parseIntSetting(...)` call, split into its top-level arguments.
//
// NOTE: walked rather than matched. A regex reaching for "the last argument" cannot tell the closing
// paren of the call from one inside it, and cannot tell an argument comma from a comma inside a
// consequence sentence, which several of these have. The first attempt at the zero test below did
// exactly that and reported AGENT_PROMPT_MAX_CHARS, whose fallback happens to be the last number on
// its own line. Tracking depth and quotes is a dozen lines and cannot be wrong in that way.
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
  // The guard against the next one. A variable added with the old shape shows up here by name, which
  // is the failure mode this whole change is about: the shape was not wrong once, it was copied into
  // thirteen places over time and would have been copied into the fourteenth.
  test("nothing is converted to a number without being checked", () => {
    expect(numberCallArguments(CODE)).toEqual(["raw"]);
  });

  // The mechanical error a thirteen-site change invites: the value of one variable reported under
  // another's name. The operator then gets an error naming a variable they never set, which is worse
  // than no message at all, and no type checker can see it because both sides are just strings.
  test("every parsed variable is reported under its own name", () => {
    const mismatched = CALLS.filter(
      (call) => call.variable !== call.reportedAs,
    ).map((call) => `${call.variable} reported as ${call.reportedAs}`);
    expect(mismatched).toEqual([]);
  });

  // The other mechanical error, and the one a reviewer reading a thirteen-site diff is least likely
  // to catch: a fallback mistyped, so the app runs on a number nobody chose and nothing says so.
  // Checked against `.env.example` rather than against a list here, because that file is where an
  // operator reads the default, so the same test also fails when the documentation drifts from the
  // code, and when a parsed variable is not documented at all. Both sides are literals in different
  // files, which no type checker can relate.
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

  // Zero is admitted at exactly one call site, and this names it. The distinction the parser draws is
  // whether the CONSUMER treats zero as a value or as an absence, which is narrower than "the old
  // code let it through": it let zero through on nine of the thirteen, and on eight of those it was
  // the pathology (a 1ms tick, a heartbeat due at `now`, a port nothing can route to). Widening the
  // exception is therefore a decision, and it fails here until someone makes it deliberately.
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

// Why the timer bound is 2_147_483_647 rather than a number someone picked. Above it the delay is not
// stretched, it is SET TO 1, so a variable that reads as "tick every 25 days" is a worker spinning
// against the database. Proven rather than asserted, because the bound is the entire reason a timer
// variable is refused above it.
describe("the timer bound is the runtime's, not a policy", () => {
  test("a delay above it is not honoured, it collapses to about a millisecond", async () => {
    const firedImmediately = await new Promise<boolean>((resolve) => {
      // If the runtime honoured this, the callback would be due in about 24.8 days.
      const interval = setInterval(() => {
        clearInterval(interval);
        clearTimeout(guard);
        resolve(true);
      }, 2_147_483_648);
      // Resolves false instead of hanging, so a runtime that ever starts honouring long delays fails
      // this test in two seconds rather than blocking the suite.
      const guard = setTimeout(() => {
        clearInterval(interval);
        resolve(false);
      }, 2_000);
    });
    expect(firedImmediately).toBe(true);
  });
});

// The parser's own handling of the minimum, driven directly. Everything else about it (blanks,
// `Infinity`, `1e309`, fractions, negatives, garbage, the upper bound) is covered in
// tests/api/middlewares/credentialRateLimit.test.ts, where it arrived.
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
