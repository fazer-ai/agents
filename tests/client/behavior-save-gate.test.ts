import { describe, expect, test } from "bun:test";

// EVERY FIELD CHECK THE BEHAVIOR TAB COMPUTES REACHES ITS SAVE BUTTON.
//
// The tab renders a field-level error for a value the runtime will refuse, and it also has to
// REFUSE THE SAVE — the two are not the same guarantee, and only the second one is load-bearing. A
// configuration the runtime will not build is worth nothing stored: the operator sees a red field,
// saves anyway, and the feature they configured is simply never there. For the fallback provider
// that is the whole feature, since a fallback that cannot be built is indistinguishable from having
// named none.
//
// This is a rule enforced PER CHECK rather than in one place, which is the shape that grows an
// N+1, and it grew one twice. First `fallbackBaseUrlInvalid`, added rendering its error and not
// blocking the save; this fence went in for it, reading the ENDPOINT checks by name. Then
// `fallbackModelMissing`, which is the same rule about a different kind of field and so passed
// straight through a scan looking for `BaseUrl` — review found that one too. So the scan now reads
// the shape all ten of this tab's checks actually share (`<feature><What>` ending in Invalid,
// Unsupported, Missing or Required), which is the rule as its own heading always stated it.

const SOURCE = await Bun.file("src/client/pages/agents/BehaviorTab.tsx").text();

// The checks, by the shape their names share: a feature prefix and a verdict suffix — the endpoint
// ones (`<feature>BaseUrlInvalid`, `<feature>BaseUrlUnsupported`, `<feature>UrlInvalid`, since
// contact auth's endpoint is not a base URL) and the field ones (`<feature>ModelMissing`). Read off
// the DECLARATIONS, so a check that exists is on the list whether or not anyone remembered it.
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

  // The scan has to find something, or an empty answer above would be the scan failing rather than
  // the code passing — the failure mode of every fence that reads source.
  test("the scan actually sees the checks", () => {
    const found = declaredEndpointChecks(SOURCE);
    expect(found.length).toBeGreaterThanOrEqual(10);
    expect(found).toContain("fallbackBaseUrlInvalid");
    expect(found).toContain("fallbackBaseUrlUnsupported");
    // The one the endpoint-only scan could not see, which is why the shape widened.
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

  // The SECOND control, for the widening itself: this fixture is exactly what the endpoint-only
  // scan answered `[]` to, which is how `fallbackModelMissing` reached review.
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
