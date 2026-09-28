import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// A field whose stored value is clamped by its reader has to say so on the control, or the operator
// meets the cap only in what the model receives. `maxLength` is the whole mechanism, so a new field
// that forgets it regresses silently. Two controls are scanned (`<Textarea` and
// `<HighlightedPromptEditor`): what makes a control need the declaration is its READER, not which
// component renders it.
// Checked on the source: rendering needs the auth/theme/toast providers and a live catalog, or a
// process-global `mock.module`. components/Textarea.test.tsx proves the counter, and
// pages/GuardrailsTab.test.tsx a tab rendering its fields with the cap.
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

function blocks(src: string, tag: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(tag.source, "g");
  let m = re.exec(src);
  while (m) {
    const end = src.indexOf("/>", m.index);
    out.push(src.slice(m.index, end === -1 ? src.length : end));
    m = re.exec(src);
  }
  return out;
}

const textareas = (src: string): string[] => blocks(src, /<Textarea\b/);

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

  // NOTE: "Stays honest" below is one direction only: it removes an entry whose file or field is gone. The
  // other one is what lets a new uncapped textarea ship, because both lists are subtracted from a set
  // read out of the editor sources (tests/utils/ledger.ts).
  test("the ledgers this file waives with may only shrink", () => {
    expectWaiverLedger("UNCLAMPED_FILES", UNCLAMPED_FILES, 2);
    expectWaiverLedger("UNCLAMPED_FIELDS", UNCLAMPED_FIELDS, 2);
  });

  // NOTE: the second control, and it needs no ledger: a highlighted editor whose block CLAMPS (a `_MAX`,
  // e.g. `clipText(v, SIGNATURE_MAX)`) must also DECLARE. The system prompt, the one uncapped
  // highlighted field, clamps nothing and is not flagged.
  test("a highlighted editor that clamps also declares the cap", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith(".tsx"))) {
      const src = readFileSync(`${DIR}/${file}`, "utf8");
      for (const block of blocks(
        src,
        /<Highlighted(PromptEditor|TemplateField)\b/,
      )) {
        // A `_MAX` inside the block is the clamp: every cap in modules/agents/text-caps.ts is spelled
        // that way, and a field that cuts its value has to name the number it cuts at.
        if (!/\b[A-Z][A-Z0-9_]*_MAX\b/.test(block)) continue;
        if (block.includes("maxLength=")) continue;
        offenders.push(`${file}: ${block.split("\n")[1]?.trim() ?? block}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // POSITIVE CONTROL over the predicate: the scan has to see a clamped block, or the empty answer
  // above is the scan failing rather than the code passing.
  test("the highlighted scan sees a clamped block and an unclamped one", () => {
    const clamped = `
      <HighlightedPromptEditor
        rows={3}
        value={x}
        onChange={(v) => set({ text: clipText(v, SIGNATURE_MAX) })}
      />`;
    const declared = clamped.replace(
      "rows={3}",
      "rows={3}\n maxLength={SIGNATURE_MAX}",
    );
    const unclamped = `
      <HighlightedPromptEditor
        rows={10}
        value={value}
        onChange={onChange}
      />`;
    const flag = (src: string) =>
      blocks(src, /<Highlighted(PromptEditor|TemplateField)\b/).filter(
        (b) => /\b[A-Z][A-Z0-9_]*_MAX\b/.test(b) && !b.includes("maxLength="),
      ).length;
    expect(flag(clamped)).toBe(1);
    expect(flag(declared)).toBe(0);
    expect(flag(unclamped)).toBe(0);
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
