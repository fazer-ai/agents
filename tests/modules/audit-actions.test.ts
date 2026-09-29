import { describe, expect, test } from "bun:test";
import {
  AUDIT_ACTIONS,
  canonicalAuditAction,
  FLEET_LEVEL_ACTIONS,
  isFleetLevelAction,
  RENAMED_AUDIT_ACTIONS,
} from "@/lib/audit/actions";
import { withoutComments } from "@/tests/utils/source-text";

// The console's action filter offers a constant list (see AUDIT_ACTIONS), worth offering only while
// it agrees with the code that writes the rows: MISSING and EXTRA below are the two directions.

// The whole value expression after `action:`, up to the comma or brace that ends the property, so
// `cond ? "company_logo.clear" : "company_logo.set"` yields both literals. Depth- and string-aware
// for nested calls, objects and commas inside templates. A name computed from a variable
// contributes nothing, and the entry it needs shows up as `extra` on the list.
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

// Every `src/**/*.ts` but the list itself, through `withoutComments` (a name in prose is not a
// producer) and NOT `codeOnly`: the name looked for IS a string literal, and blanking string bodies
// would blank the answer. Read once and shared: both directions sweep the same bytes.
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
  // MISSING: a family adds `channel.foo` and the operator cannot pick it. The type is the real
  // fence (`AuditEntry.action` is `AuditAction`); this costs one sweep and fails with the NAME
  // rather than with a union of ninety alternatives.
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

  // EXTRA: a producer is deleted or renamed and its name stays on the list, so an operator picks a
  // value that can never match and reads the empty page as "nothing happened". NO TYPE CAN CHECK
  // THIS: a union member nobody constructs is not an error anywhere. Asked as PRESENCE, not by
  // parsing producers: parsing `action:` sites misses a name written through a ternary or passed to
  // a helper (`auditConsentDecision`), and presence does not depend on the shape.
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

  // The filter renders these verbatim, so the shape is part of the contract: `<entity>.<verb>`,
  // with no exceptions. A name in another shape reaches the operator as noise and suggests the
  // family it belongs to is somewhere else.
  test("every action is <entity>.<verb>", () => {
    const odd = AUDIT_ACTIONS.filter(
      (a) => !/^[a-z][a-z_]*\.[a-z][a-z_]*$/.test(a),
    );
    expect(odd).toEqual([]);
  });
});

// WHICH ACTIONS BELONG TO NO TENANT, asked of the producers. Arguments are SPLIT BY COUNTING PARENS:
// a lookahead like `,\s*(?!null\s*,)[^,]+,` backtracks and lets every fleet call match the tenant
// pattern. All three call shapes are enumerated so a fourth fails LOUDLY (its action looks
// tenant-scoped and the declared entry becomes `extra`) rather than quietly shrinking the sweep.
// Membership is "writes null ALWAYS", so `api_key.*` and `mcp_oauth_consent.*`, which write the
// tenant id on the tenant path and `null` on the fleet path, are correctly absent.
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

// THE RENAMED CONSENT SPELLINGS ARE ACCEPTED AS INPUT ONLY. Saved filter links, scripts and quoted
// exports still name the old spellings, and without the redirect they read "no consent decision was
// ever recorded" while the rows sit one name over. The three halves of "input only" can break
// separately: it translates, it is not in the vocabulary, and it does not leak into what is written.
describe("audit actions: the spellings the rename left behind", () => {
  test("an old spelling is redirected to the name the rows now carry", () => {
    expect([
      canonicalAuditAction("mcp_oauth_consent_granted"),
      canonicalAuditAction("mcp_oauth_consent_denied"),
    ]).toEqual(["mcp_oauth_consent.grant", "mcp_oauth_consent.deny"]);
  });

  test("everything else is handed back untouched, including nonsense", () => {
    for (const value of ["mcp_client.create", "", "not_an_action", "mcp_"]) {
      expect(canonicalAuditAction(value)).toBe(value);
    }
  });

  // A NAME OFF `Object.prototype` IS STILL JUST A NAME THE TRAIL DOES NOT HAVE. `?action=toString`
  // is a string like any other, and a plain-object lookup answers it with an inherited FUNCTION,
  // which `?? action` then keeps because it is not nullish. That value goes on to Prisma as the
  // `action` filter (a 500 where this endpoint promises an empty result) and into the page's
  // filter state, which expects a string. Asserted as a type, not as a spelling, so the next reader
  // to add a member cannot pick one this misses.
  test("a name that Object.prototype happens to carry is handed back untouched", () => {
    for (const value of [
      "toString",
      "constructor",
      "__proto__",
      "hasOwnProperty",
      "valueOf",
    ]) {
      const answer = canonicalAuditAction(value);
      expect(typeof answer).toBe("string");
      expect(answer).toBe(value);
    }
  });

  // THE DIRECTION THAT MATTERS MOST. A redirect is not a name: the moment one of these appears in
  // the picker, the operator can choose it, and the rename is undone in the only place it was
  // visible. Every target, meanwhile, must be a real action or the redirect points at nothing.
  test("no old spelling is offered, and every target is a real action", () => {
    const offered = [...RENAMED_AUDIT_ACTIONS.keys()].filter((a) =>
      (AUDIT_ACTIONS as readonly string[]).includes(a),
    );
    const dangling = [...RENAMED_AUDIT_ACTIONS.values()].filter(
      (a) => !(AUDIT_ACTIONS as readonly string[]).includes(a),
    );
    expect([offered, dangling]).toEqual([[], []]);
  });
});
