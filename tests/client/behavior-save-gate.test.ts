import { describe, expect, test } from "bun:test";

// Every field check the Behavior tab computes reaches its Save button. Rendering a field error is
// not enough: only refusing the save is load-bearing, since a configuration the runtime will not
// build is worth nothing stored (a fallback that cannot be built is the same as none).
// The rule is per check, so the scan reads the shape all this tab's checks share (`<feature><What>`
// ending in Invalid, Unsupported, Missing or Required), not only the endpoint checks.

const SOURCE = await Bun.file("src/client/pages/agents/BehaviorTab.tsx").text();

// The checks, by the shape their names share: a feature prefix and a verdict suffix (endpoint ones
// like `<feature>BaseUrlInvalid` or `<feature>UrlInvalid`, field ones like `<feature>ModelMissing`).
// Read off the DECLARATIONS, so a check that exists is on the list whether or not anyone remembered.
export function declaredEndpointChecks(source: string): string[] {
  const decl = /\bconst\s+(\w+(?:Invalid|Unsupported|Missing|Required))\s*=/g;
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

  // NOTE: the scan has to find something, or an empty answer above would be the scan failing rather
  // than the code passing.
  test("the scan actually sees the checks", () => {
    const found = declaredEndpointChecks(SOURCE);
    expect(found.length).toBeGreaterThanOrEqual(10);
    expect(found).toContain("fallbackBaseUrlInvalid");
    expect(found).toContain("fallbackBaseUrlUnsupported");
    // NOTE: a field check, which an endpoint-only scan would not see.
    expect(found).toContain("fallbackModelMissing");
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

  // NOTE: the second control: a field check an endpoint-only scan would answer `[]` to.
  test("a non-endpoint check off the gate is caught too", () => {
    const broken = `
      const sttBaseUrlInvalid = compute();
      const newFeatureModelMissing = compute();
      return <TabActionBar saveDisabled={sttBaseUrlInvalid} />;
    `;
    expect(checksMissingFromGate(broken)).toEqual(["newFeatureModelMissing"]);
    const endpointOnly =
      /\bconst\s+(\w*(?:BaseUrlInvalid|BaseUrlUnsupported|UrlInvalid))\s*=/g;
    expect([...broken.matchAll(endpointOnly)].map((m) => m[1])).toEqual([
      "sttBaseUrlInvalid",
    ]);
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
