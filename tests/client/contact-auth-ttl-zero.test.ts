import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readContactAuthConfig } from "@/modules/contact-auth/settings";

// A typed zero must not serialize as the default where the reader's floor is something else. The
// Behavior save writes numeric fields as `Number(state.x) || <default>`, harmless where zero is
// cosmetic, but `contactAuth.grantTtlSeconds` IS how long an authorization counts: a typed 0 would
// store 86400 (a day), while passed through it is clamped by the reader to its 60-second floor.
// Checked on the source because rendering the editor pulls auth, theme, toast and a live catalog,
// and paired with the reader below so what zero MEANS is exercised, not asserted.

// Scope: the contactAuth block only. The other fields share the spelling, not the risk; changing
// them would change shipped behavior. The nearest neighbour, `contactAuth.timeoutMs`, has a floor of
// 1000 and a falsy fallback of 5000: a typed zero there holds the gate LONGER than the clamp would,
// the same direction, bounded by ten seconds instead of a day.
const SRC = readFileSync("src/client/pages/agents/AgentEditorPage.tsx", "utf8");

// The file holds TWO `contactAuth: {` blocks, the form-state reader and the save. Scanning from the
// first reads the reader's `num(ca.grantTtlSeconds) || "86400"`, whose quoted default does not
// match the pattern below, so the scan starts at the save's block.
const SAVE = SRC.slice(SRC.lastIndexOf("contactAuth: {"));

function savedLineFor(field: string): string {
  const at = SAVE.indexOf(`${field}:`);
  if (at < 0) return "";
  const end = SAVE.indexOf("\n", SAVE.indexOf(",", at));
  return SAVE.slice(at, end < 0 ? undefined : end);
}

describe("the grant TTL a save writes", () => {
  test("zero is passed through, not replaced by the default", () => {
    const line = savedLineFor("grantTtlSeconds");
    expect(line).not.toBe("");
    // The falsy fallback, in either spelling.
    expect(line).not.toMatch(/\|\|\s*86_?400/);
  });

  test("and the reader is what decides what zero means", () => {
    expect(
      readContactAuthConfig({ contactAuth: { grantTtlSeconds: 0 } })
        .grantTtlSeconds,
    ).toBe(60);
    // The control: the fallback is still what an EMPTY field gets, since a cleared input is not a
    // request for the shortest reuse, it is a request for the default.
    expect(savedLineFor("grantTtlSeconds")).toMatch(/86_?400/);
  });
});
