import { describe, expect, test } from "bun:test";

// EVERY ENDPOINT CHECK THE BEHAVIOR TAB COMPUTES REACHES ITS SAVE BUTTON.
//
// The tab renders a field-level error for a base URL that is malformed, or that the chosen provider
// would silently drop, and it also has to REFUSE THE SAVE — the two are not the same guarantee, and
// only the second one is load-bearing. A configuration the runtime will not build is worth nothing
// stored: the operator sees a red field, saves anyway, and the feature they configured is simply
// never there. For the fallback provider that is the whole feature, since a fallback that cannot be
// built is indistinguishable from having named none.
//
// This is a rule enforced PER CHECK rather than in one place, which is the shape that grows an
// N+1: seven checks reached the gate and the eighth (`fallbackBaseUrlInvalid`) was added rendering
// its error and not blocking the save. Review found it, so the next one is found here instead.

const SOURCE = await Bun.file("src/client/pages/agents/BehaviorTab.tsx").text();

// The checks, by the shape their names share: `<feature>BaseUrlInvalid`, `<feature>BaseUrlUnsupported`
// and `<feature>UrlInvalid` (contact auth's endpoint is not a base URL). Read off the DECLARATIONS,
// so a check that exists is on the list whether or not anyone remembered it.
export function declaredEndpointChecks(source: string): string[] {
  const decl =
    /\bconst\s+(\w*(?:BaseUrlInvalid|BaseUrlUnsupported|UrlInvalid))\s*=/g;
  return [
    ...new Set([...source.matchAll(decl)].map((m) => m[1] as string)),
  ].sort();
}

// The expression the Save button is disabled by. Matched to its closing brace rather than to the
// first one, so a multi-line `||` chain is read whole.
export function saveGateExpression(source: string): string {
  const at = source.indexOf("saveDisabled={");
  if (at < 0) return "";
  let depth = 0;
  for (let i = at + "saveDisabled=".length; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  return "";
}

export function checksMissingFromGate(source: string): string[] {
  const gate = saveGateExpression(source);
  return declaredEndpointChecks(source).filter((c) => !gate.includes(c));
}

describe("the Behavior tab's save gate", () => {
  test("every endpoint check it computes also blocks the save", () => {
    expect(checksMissingFromGate(SOURCE)).toEqual([]);
  });

  // The scan has to find something, or an empty answer above would be the scan failing rather than
  // the code passing — the failure mode of every fence that reads source.
  test("the scan actually sees the checks", () => {
    const found = declaredEndpointChecks(SOURCE);
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(found).toContain("fallbackBaseUrlInvalid");
    expect(found).toContain("fallbackBaseUrlUnsupported");
    expect(saveGateExpression(SOURCE)).toContain("saveDisabled={");
  });

  // POSITIVE CONTROL. The predicate is proved against a fixture that HAS the defect, because a
  // fence with no offender left in the tree passes for either reason and cannot tell them apart.
  test("a check that renders its error and does not block the save is caught", () => {
    const broken = `
      const sttBaseUrlInvalid = compute();
      const newFeatureBaseUrlInvalid = compute();
      return <TabActionBar saveDisabled={sttBaseUrlInvalid} />;
    `;
    expect(checksMissingFromGate(broken)).toEqual(["newFeatureBaseUrlInvalid"]);
  });

  test("and the same fixture with the gate complete is clean", () => {
    const fixed = `
      const sttBaseUrlInvalid = compute();
      const newFeatureBaseUrlInvalid = compute();
      return <TabActionBar saveDisabled={sttBaseUrlInvalid || newFeatureBaseUrlInvalid} />;
    `;
    expect(checksMissingFromGate(fixed)).toEqual([]);
  });
});
