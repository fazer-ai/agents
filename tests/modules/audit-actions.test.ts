import { describe, expect, test } from "bun:test";
import {
  AUDIT_ACTIONS,
  FLEET_LEVEL_ACTIONS,
  isFleetLevelAction,
} from "@/lib/audit/actions";
import { withoutComments } from "@/tests/utils/source-text";

// The console's action filter offers a list, and the list is a constant rather than a query (see the
// note on AUDIT_ACTIONS for why). A constant is only worth offering while it agrees with the code
// that writes the rows, and it can disagree in two directions that fail differently:
//
//   MISSING — a family adds `channel.foo` and the operator cannot pick it. The trail holds rows
//   nobody can filter to, which is the failure the filter exists to prevent.
//   EXTRA — a producer is deleted or renamed and its name stays on the list. The operator picks a
//   value that can never match and reads the empty page as "nothing happened".
//
// Both are asserted, and the sweep counts through `tests/utils/source-text` so a name that only
// appears in PROSE — every one of these modules explains its own actions in comments — is not read
// as a producer.
//
// `withoutComments` and NOT `codeOnly`: the thing being looked for IS a string literal, so blanking
// string bodies blanks the answer. Measured — the first version of this file used `codeOnly` and
// counted zero producers, which without the floor below would have read as a clean tree.
// The value expression written after `action:`, up to the comma or brace that ends the property.
//
// NOT a `action:\s*"([a-z_]+\.[a-z_]+)"` match, which is what this file did first and which reads
// only the simplest producer. `setCompanyLogoKey` writes
//
//   action: logoKey === null ? "company_logo.clear" : "company_logo.set",
//
// and a literal-initializer pattern sees neither name — so both were missing from the vocabulary
// while this test was green, which is exactly the direction that leaves an action unfilterable.
// Review found it. Reading the whole expression finds every literal in any shape of it.
//
// Depth-aware and string-aware, because the value can contain a nested call, an object, or a comma
// inside a template. A producer that computes its name from a variable contributes nothing, which is
// the one gap left and is visible: the entry it needs would show up as `extra` on the list.
function actionValue(code: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  let i = from;
  for (; i < code.length; i++) {
    const ch = code[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if (ch === "," && depth === 0) break;
  }
  return code.slice(from, i);
}

function literalsIn(expr: string): string[] {
  return [...expr.matchAll(/"([a-z_]+\.[a-z_]+)"/g)].map((m) => m[1] as string);
}

// Every `src/**/*.ts` but the list itself, with comments blanked. Read once and shared, because both
// directions below sweep the same bytes asking different questions.
async function producerSources(): Promise<string[]> {
  const out: string[] = [];
  for await (const rel of new Bun.Glob("**/*.ts").scan("src")) {
    const path = `src/${rel}`;
    // The list is not a producer; every entry in it would match everything below.
    if (path === "src/lib/audit/actions.ts") continue;
    out.push(withoutComments(await Bun.file(path).text()));
  }
  return out;
}

describe("the audit action vocabulary", () => {
  // MISSING — a family adds `channel.foo` and the operator cannot pick it.
  //
  // The type is the real fence here now (`AuditEntry.action` is `AuditAction`, so this cannot
  // compile), and this stays because it costs one sweep and fails with the NAME rather than with a
  // union of ninety alternatives.
  test("every action the code writes is on the list", async () => {
    const written = new Set<string>();
    for (const code of await producerSources()) {
      for (const m of code.matchAll(/\baction:/g)) {
        for (const name of literalsIn(
          actionValue(code, m.index + m[0].length),
        )) {
          written.add(name);
        }
      }
    }
    // Worthless if it matched nothing, which is what a rename of the `action:` field would do to it.
    expect(written.size).toBeGreaterThan(50);
    expect(
      [...written].filter((a) => !AUDIT_ACTIONS.includes(a as never)),
    ).toEqual([]);
  });

  // EXTRA — a producer is deleted or renamed and its name stays on the list. The operator picks a
  // value that can never match and reads the empty page as "nothing happened". NO TYPE CAN CHECK
  // THIS: a union member nobody constructs is not an error anywhere.
  //
  // Asked as PRESENCE, not by parsing producers, and that is the lesson of three rounds of review.
  // Read off `action:` sites, this direction was wrong for every name written any other way: a
  // ternary (`company_logo.*`), and a helper taking the name as an argument
  // (`auditConsentDecision`, whose two names it reported as extra while they are written on every
  // consent decision). Presence cannot be fooled by the shape, because it does not look at one.
  test("every action on the list still has a producer", async () => {
    const sources = await producerSources();
    const orphaned = AUDIT_ACTIONS.filter(
      (a) => !sources.some((code) => code.includes(`"${a}"`)),
    );
    expect(orphaned).toEqual([]);
  });

  test("no entry is listed twice", () => {
    const unique = new Set<string>(AUDIT_ACTIONS);
    expect(unique.size).toBe(AUDIT_ACTIONS.length);
  });

  // The filter renders these verbatim, so the shape is part of the contract: `<entity>.<verb>`, the
  // naming #392 settled. A name in another shape reaches the operator as noise and, worse, suggests
  // the family it belongs to is somewhere else.
  //
  // The two exceptions are NAMED rather than pattern-matched, so a third one is a decision somebody
  // makes on purpose and not a hole the regex quietly widened. They predate #392 and are written by
  // live code on every OAuth consent decision; renaming them orphans every row already recorded
  // under those names, which is #523 and its backfill, not this list's problem.
  const PREDATE_THE_CONVENTION = [
    "mcp_oauth_consent_denied",
    "mcp_oauth_consent_granted",
  ];

  test("every action is <entity>.<verb>", () => {
    const odd = AUDIT_ACTIONS.filter(
      (a) =>
        !PREDATE_THE_CONVENTION.includes(a) &&
        !/^[a-z][a-z_]*\.[a-z][a-z_]*$/.test(a),
    );
    expect(odd).toEqual([]);
  });

  // An exception that stops being one is an exception that stays forever.
  test("every exception is still in the list", () => {
    const gone = PREDATE_THE_CONVENTION.filter(
      (a) => !(AUDIT_ACTIONS as readonly string[]).includes(a),
    );
    expect(gone).toEqual([]);
  });
});

// WHICH ACTIONS BELONG TO NO TENANT, asked of the producers rather than of the list.
//
// SPLIT BY COUNTING PARENS, not by a lookahead over `[^,]+`. The first version of this used
// `,\s*(?!null\s*,)[^,]+,` to mean "the tenant argument is not null", and a regex backtracks: with
// `\s*` matching zero spaces the lookahead sees " null", which does not start with `null`, so every
// fleet call also matched the tenant pattern and disqualified itself. It reported five fleet actions
// where there are eleven, and it reported them confidently.
//
// Three call shapes reach the row, and all three are enumerated because the sweep must fail LOUDLY
// on a fourth rather than quietly shrink: a new shape makes an action look tenant-scoped, the
// declared entry becomes `extra`, and this goes red. A new fleet action in a known shape is
// `missing` and goes red too. Neither direction degrades to a pass.
//
// `api_key.*` and `mcp_oauth_consent_*` are correctly absent from the declaration: they take the
// tenant id on the tenant path and `null` on the fleet path, so membership is asked as "writes null
// ALWAYS" — an action seen in any tenant-scoped write is disqualified.
describe("which actions belong to no tenant", () => {
  // Where the tenant is written in each call, and `null` for the local `fleetAudit` alias in
  // `mcp/oauth/admin.ts`, which supplies the null itself.
  const CALLS: { name: string; tenantArg: number | null }[] = [
    { name: "auditMutationOn", tenantArg: 2 },
    { name: "recordAudit", tenantArg: 1 },
    { name: "fleetAudit", tenantArg: null },
  ];

  // The top-level arguments of the call whose `(` sits at `open`. Depth- and string-aware, so a
  // nested call, object or template with commas inside does not split an argument in two.
  function callArgs(code: string, open: number): string[] {
    const args: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = open + 1;
    for (let i = start; i < code.length; i++) {
      const ch = code[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" && depth === 0) {
        args.push(code.slice(start, i));
        return args;
      } else if (ch === ")" || ch === "]" || ch === "}") depth--;
      else if (ch === "," && depth === 0) {
        args.push(code.slice(start, i));
        start = i + 1;
      }
    }
    return args;
  }

  async function sweep(): Promise<{ fleet: Set<string>; tenant: Set<string> }> {
    const fleet = new Set<string>();
    const tenant = new Set<string>();
    let calls = 0;
    for (const code of await producerSources()) {
      for (const { name, tenantArg } of CALLS) {
        for (const m of code.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
          const args = callArgs(code, m.index + m[0].length - 1);
          if (args.length === 0) continue;
          calls++;
          const isFleet =
            tenantArg === null || args[tenantArg]?.trim() === "null";
          const into = isFleet ? fleet : tenant;
          // The entry object is the last argument, wherever the shape put it.
          for (const a of literalsIn(args[args.length - 1] ?? "")) into.add(a);
        }
      }
    }
    // Worthless if it matched nothing, which is what renaming any of the three would do to it.
    expect(calls).toBeGreaterThan(20);
    return { fleet, tenant };
  }

  test("the declaration matches the producers, in both directions", async () => {
    const { fleet, tenant } = await sweep();
    const alwaysFleet = [...fleet].filter((a) => !tenant.has(a)).sort();
    expect(alwaysFleet).toEqual([...FLEET_LEVEL_ACTIONS].sort());
  });

  test("every declared entry is a real action", () => {
    const unknown = FLEET_LEVEL_ACTIONS.filter(
      (a) => !(AUDIT_ACTIONS as readonly string[]).includes(a),
    );
    expect(unknown).toEqual([]);
  });

  // The two that write both ways: naming them is what keeps a future edit from "simplifying" the
  // sweep into one that cannot tell them apart.
  test("an action written both ways is not fleet-only", async () => {
    const { fleet, tenant } = await sweep();
    for (const a of ["api_key.create", "api_key.revoke"]) {
      expect([fleet.has(a), tenant.has(a)]).toEqual([true, true]);
      expect(isFleetLevelAction(a)).toBe(false);
    }
  });
});
