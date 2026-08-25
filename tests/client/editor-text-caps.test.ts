import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// A field whose stored value is clamped by its reader has to say so on the control, or the operator
// meets the cap only in what the model receives. `maxLength` is the whole mechanism, which makes
// "someone adds a guidance field and forgets it" the way this regresses — a silent one, since the
// field looks and behaves exactly right until the text is long.
//
// Checked on the source rather than by rendering: the tabs pull the auth/theme/toast providers and a
// live catalog, and the only alternative to that setup is `mock.module`, which is global to the
// process and leaks into whatever else shares the worker. What the render WOULD add over this is
// covered elsewhere: Textarea.test.tsx proves the counter, GuardrailsTab.test.tsx proves a real tab
// renders its fields with the cap on them.
const DIR = "src/client/pages/agents";

// Files with no reader clamp behind any of their textareas: nothing is ever cut, so there is no cap
// to declare. Channel-redirect messages are stored and sent whole (readChannelRedirectConfig has no
// slice at all), and the playground composer is a message the operator sends, not stored settings.
const UNCLAMPED_FILES = ["ChannelRedirectTab.tsx", "PlaygroundChat.tsx"];

// Individual fields inside files that DO carry capped ones. Both are lists: their readers bound how
// many entries survive, and a dropped entry shows up as a missing row rather than as a sentence that
// ends early.
const UNCLAMPED_FIELDS = [
  "g.competitors.join", // guardrails competitors (bounded by entry COUNT and per-entry length)
  "sendImage.allowedHosts", // one host per line
];

function textareas(src: string): string[] {
  const out: string[] = [];
  const re = /<Textarea\b/g;
  let m = re.exec(src);
  while (m) {
    const end = src.indexOf("/>", m.index);
    out.push(src.slice(m.index, end === -1 ? src.length : end));
    m = re.exec(src);
  }
  return out;
}

describe("agent editor text caps", () => {
  test("every Textarea declares its cap, or is listed as deliberately uncapped", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".tsx"))) {
      if (UNCLAMPED_FILES.includes(file)) continue;
      const src = readFileSync(`${DIR}/${file}`, "utf8");
      for (const block of textareas(src)) {
        if (block.includes("maxLength=")) continue;
        if (UNCLAMPED_FIELDS.some((u) => block.includes(u))) continue;
        offenders.push(`${file}: ${block.split("\n")[1]?.trim() ?? block}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // "Stays honest" below is one direction only: it removes an entry whose file or field is gone. The
  // other one is what lets a new uncapped textarea ship, because both lists are subtracted from a set
  // read out of the editor sources. tests/utils/ledger.ts, issue #293.
  test("the ledgers this file waives with may only shrink", () => {
    expectWaiverLedger("UNCLAMPED_FILES", UNCLAMPED_FILES, 2);
    expectWaiverLedger("UNCLAMPED_FIELDS", UNCLAMPED_FIELDS, 2);
  });

  test("the allowlist itself stays honest (every entry still exists)", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".tsx"));
    for (const f of UNCLAMPED_FILES) expect(files.includes(f)).toBe(true);
    const all = files
      .map((f) => readFileSync(`${DIR}/${f}`, "utf8"))
      .join("\n");
    for (const u of UNCLAMPED_FIELDS) expect(all.includes(u)).toBe(true);
  });
});
