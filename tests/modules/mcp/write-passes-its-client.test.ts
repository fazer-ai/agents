import { describe, expect, test } from "bun:test";
import { codeOnly } from "@/tests/utils/source-text";

// Every MCP write tool opens with `const base = deps.base ?? basePrisma`, and the client it settles
// on is the caller's answer to "which database is this write about". A tool that then calls a helper
// WITHOUT passing it does not fail: the helper falls back to its own module-level client, and the
// tool reads one database while writing another.
//
// The fallback is a default parameter (`base: PrismaClient = prisma`), which is the repo's
// convention and is not the defect — 411 functions carry it, and the reason it exists is that most
// callers have no client to offer. What it costs is a silent miss: dropping the argument is spelled
// exactly like not having one.
//
// It has now happened twice in the same file. #490 fixed `brandingSet`, which was unmeasurable until
// `getGlobalBranding` took the caller's client; #502 is `brandingAssetSet`, the sibling left behind,
// where the preview reported a replacement that lived in a different database. Two sites, one
// invariant, and nothing obliging the third — so the invariant is cobrado here instead of per tool.
//
// WHAT THIS DOES NOT COVER, measured rather than assumed. The same shape is possible anywhere in
// `src/`, not only in these nine files. A tree-wide version of this sweep was written and thrown
// away: it reported eleven sites, ten of them false — a Chatwoot client's `client.listInboxes()`
// matched the module function `listInboxes` by bare name, a local closure shadowed an exported name,
// and one "argument list" was the prose of a comment. The transports are where the invariant is
// load-bearing (they are handed a client on purpose, by a caller that means it) and where the sweep
// is exact, so that is what it claims.

// Everything the sweep decides, over source text it is handed, so the fixture cases below drive the
// same code the tree does. Returns one entry per call that reaches a client-taking function without
// naming a client.
function bareCalls(
  code: string,
  accepts: ReadonlySet<string>,
): { name: string; line: number; args: string }[] {
  const found: { name: string; line: number; args: string }[] = [];
  // `[^\w.$]` in front is what keeps `client.listInboxes()` from matching the module-level
  // `listInboxes`: a method call is a different function that happens to share a name.
  for (const m of code.matchAll(/(^|[^\w.$])(\w+)\s*\(/g)) {
    const name = m[2] as string;
    if (!accepts.has(name)) continue;
    const args = argsAt(code, m.index + (m[0] as string).length);
    // The names a Prisma client goes by in these files. All three of `base`, `(base|db|tx)` and
    // `(base|db|tx|suDb|client)` returned the same single offender when this was written, so the
    // middle one is not buying an exemption for anything that exists — it is here because a helper
    // called inside a `$transaction` receives `tx`, and `client` is left OUT because a Chatwoot
    // client is called that.
    if (/\b(base|db|tx)\b/.test(args)) continue;
    found.push({
      name,
      line: code.slice(0, m.index).split("\n").length,
      args: args.trim(),
    });
  }
  return found;
}

// The parenthesised run starting just past an open paren, depth-aware so a nested call or object
// literal does not end it early. Comments and string bodies are already blanked by `codeOnly`, which
// is why a bare scan for the closing paren is enough here.
//
// MEASURED, so the next reader does not have to: `codeOnly` changes no number in this tree today.
// Dropping it leaves the sweep at 174 calls reached and 0 offenders, identical. It is here so the
// fence's answer does not depend on what the transports say ABOUT these calls in prose, which is the
// failure `tests/utils/source-text.ts` was written for after a sweep read a comment as a use. The
// fixture below is the proof that the predicate needs it; the tree is simply not exercising it yet.
function argsAt(code: string, openEnd: number): string {
  let depth = 1;
  let i = openEnd;
  for (; i < code.length && depth > 0; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
  }
  return code.slice(openEnd, i - 1);
}

// A function "takes a client" when a `PrismaClient` appears anywhere in its parameter list, whether
// the parameter is required, optional, or defaulted. The defaulted ones are the whole point.
async function clientTakingFunctions(): Promise<Set<string>> {
  const names = new Set<string>();
  for await (const rel of new Bun.Glob("**/*.ts").scan("src")) {
    const code = codeOnly(await Bun.file(`src/${rel}`).text());
    for (const m of code.matchAll(/\bfunction\s+(\w+)\s*\(/g)) {
      const params = argsAt(code, m.index + (m[0] as string).length);
      if (params.includes("PrismaClient")) names.add(m[1] as string);
    }
  }
  return names;
}

describe("the sweep itself", () => {
  // Every case is a spelling this sweep got wrong at some point, or would have. Without these the
  // tree assertion below is a green that proves nothing: after #502 there is no offender left in
  // `src/`, so a sweep that had stopped matching anything would look exactly the same.
  const accepts = new Set(["getGlobalBranding", "listInboxes"]);

  test("it flags a call that drops the client", () => {
    const hits = bareCalls(
      codeOnly("const before = await getGlobalBranding();"),
      accepts,
    );
    expect(hits.map((h) => h.name)).toEqual(["getGlobalBranding"]);
  });

  test("it passes a call that hands the client on", () => {
    expect(
      bareCalls(codeOnly("await getGlobalBranding(base);"), accepts),
    ).toEqual([]);
    expect(
      bareCalls(codeOnly("await getGlobalBranding(tx);"), accepts),
    ).toEqual([]);
  });

  test("a method that shares the name is a different function", () => {
    expect(
      bareCalls(
        codeOnly("const remote = await client.listInboxes();"),
        accepts,
      ),
    ).toEqual([]);
  });

  test("prose naming the call is not the call", () => {
    const code = codeOnly(`
      // Do not call getGlobalBranding() here without a client.
      const label = "getGlobalBranding()";
      await getGlobalBranding(base);
    `);
    expect(bareCalls(code, accepts)).toEqual([]);
  });

  test("a nested argument does not end the argument list early", () => {
    const code = codeOnly("await getGlobalBranding(pick({ a: f(1) }, base));");
    expect(bareCalls(code, accepts)).toEqual([]);
  });

  test("it reports the line the call is on", () => {
    const code = codeOnly(
      "const a = 1;\nconst b = 2;\nawait getGlobalBranding();",
    );
    expect(bareCalls(code, accepts)[0]?.line).toBe(3);
  });
});

describe("every MCP write transport hands its client on", () => {
  test("no tool reaches a client-taking helper without naming a client", async () => {
    const accepts = await clientTakingFunctions();
    // Worthless if it matched nothing. A rename of `PrismaClient`, or a glob that stops finding the
    // transports, would empty both numbers and leave the assertion below trivially true.
    //
    // The floors are far below what any edition reports, because this file runs in all three trees
    // and a sweep with an edition-sensitive count is how a test passes on master and fails in Free
    // (#516, days before this one). Measured on the derived trees: master and Pro 411 client-taking
    // functions, Free 410 — the Pro-only admin service that is swapped for a stub — with 9 transport
    // files, 174 calls reached and 0 offenders in all three, identically.
    expect(accepts.size).toBeGreaterThan(200);

    const offenders: string[] = [];
    let reached = 0;
    let files = 0;
    for await (const rel of new Bun.Glob("write*.ts").scan("src/modules/mcp")) {
      const path = `src/modules/mcp/${rel}`;
      files++;
      const code = codeOnly(await Bun.file(path).text());
      for (const m of code.matchAll(/(^|[^\w.$])(\w+)\s*\(/g)) {
        if (accepts.has(m[2] as string)) reached++;
      }
      for (const hit of bareCalls(code, accepts)) {
        offenders.push(`${path}:${hit.line} ${hit.name}(${hit.args})`);
      }
    }
    expect(files).toBeGreaterThan(5);
    expect(reached).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
