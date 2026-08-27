import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readContactAuthConfig } from "@/modules/contact-auth/settings";

// A TYPED ZERO MUST NOT SERIALIZE AS THE DEFAULT, WHERE THE READER'S FLOOR IS SOMETHING ELSE (#189).
//
// The Behavior save writes twelve numeric fields as `Number(state.x) || <default>`, which is the
// right shape wherever zero is not a value the reader keeps: a zeroed debounce window or balloon
// size is cosmetic, and the default is as good a guess as any. `contactAuth.grantTtlSeconds` is the
// one field in that block where it is not, because the number IS how long an authorization counts:
//
//   typed 0  ->  `|| 86_400`  ->  stored 86400  ->  a day
//   typed 0  ->  passed through -> stored 0     ->  the reader clamps to 60, the documented floor
//
// The operator who types zero is asking for the shortest possible reuse, and the falsy fallback
// hands them the longest — silently, on the next save of ANY Behavior edit, and to a configuration
// that may have arrived through an import rather than through the field. `noticeCooldownSeconds`
// two lines above already carries the empty-string form for the same class of reason.
//
// Checked on the source because rendering the editor pulls auth, theme, toast and a live catalog
// (the same reason editor-save-errors.test.ts reads the file), and paired with the reader below so
// the claim about what zero MEANS is measured rather than asserted.
//
// SCOPE: this covers the contactAuth block, not the other eleven fields. They share the spelling and
// not the risk, and a sweep that changed them would be changing shipped behavior on fields nobody
// reported. `contactAuth.timeoutMs` is the nearest neighbour: it has a floor of 1000 and a falsy
// fallback of 5000, so a typed zero there lands on a LONGER gate hold than the clamp would give —
// the same direction, bounded by ten seconds instead of by a day.
const SRC = readFileSync("src/client/pages/agents/AgentEditorPage.tsx", "utf8");

// The file holds TWO `contactAuth: {` blocks — the form-state reader (which turns stored numbers
// into strings) and the save (which turns them back). Scanning from the first one reads the reader's
// `num(ca.grantTtlSeconds) || "86400"`, whose quoted default does not match the pattern below, so
// the check passed with the defect in place. Caught by running it against the restored defect, which
// is the only thing that tells a fence from a decoration.
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
