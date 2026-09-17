import { describe, expect, test } from "bun:test";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import {
  collectOversizedTextChanges,
  EXTRACTION_PROMPT_MAX,
} from "@/modules/agents/text-caps";
import {
  CLASSIFIED,
  MODEL_WITH_TOOLS,
  MODEL_WITHOUT_TOOLS,
  PERSON_FACING,
} from "../utils/operator-text-classes";
import { withoutComments } from "../utils/source-text";

// THE SURFACE A RENAME HAS TO FOLLOW, asked once here instead of once per rename (issue #604).
//
// A rename of a model-visible name has to follow the operator's own prose, and that prose lives in
// eleven sites of one walker. `20260909120000_rename_http_tools_named_after_natives` rewrote one of
// them (the system prompt) and moved the KEY of another without its text, which left the model
// reading, on the description of `set_labels`, a rule about calling `assign_label`: a name it is
// never shown and cannot call. The follow-up migration
// `20260917120000_rename_tool_names_in_operator_settings_text` rewrote the sites whose text reaches
// a model that has tools, and `tests/prisma/settings-text-rename-migration.test.ts` measures that
// against Postgres, field by field.
//
// What no migration can carry is the NEXT site. `text-caps.ts` says of itself that it is the one
// place that knows where operator text lives, and a site added to its walk is invisible to every
// rename written before it: nothing anywhere would say whether a tool name there reaches a model. So
// this file asks that every site be classified, and fails on one it does not know.
//
// IT DOES NOT ASK FOR A MIGRATION PER SITE. A field added next year holds no old tool name, and a
// fence demanding a migration for it would be asking for an empty one. What it demands is the
// DECISION, in `tests/utils/operator-text-classes.ts`, which the next rename then inherits.
//
// NOTHING HERE READS THE `.sql`. A test that asserted the migration's text would go red on a
// reformat that changes nothing a database does, which is coverage in appearance only; the
// migration's surface is measured where it happens, in the rows it rewrites.

// An interpolated segment is a family of paths, and the family is one site.
const collapse = (path: string): string => path.replace(/\$\{[^}]*\}/g, "*");

// The walker's sites, read from its SOURCE. This is the direction that catches a field somebody
// adds: an enumeration driven by a FIXTURE can only ever yield the fields the fixture carries, which
// is what the first version of this file measured, and a new `add()` call left it green.
async function sitesInSource(): Promise<string[]> {
  const src = withoutComments(
    await Bun.file("src/modules/agents/text-caps.ts").text(),
  );
  const calls = [...src.matchAll(/\badd\(([\s\S]*?)\);/g)];
  const paths = calls.map((m) => {
    const args = (m[1] as string).split(",").map((a) => a.trim());
    const third = args[2];
    if (third === undefined) {
      throw new Error(`add() with fewer than three arguments: ${m[1]}`);
    }
    const literal = /^["'`]([\s\S]*)["'`]$/.exec(third);
    if (!literal) throw new Error(`add() path is not a literal: ${third}`);
    return collapse(literal[1] as string);
  });
  return [...new Set(paths)].sort();
}

// Longer than the largest cap in the module, so every field the walker yields is reported.
const HUGE = "x".repeat(EXTRACTION_PROMPT_MAX + 1);

// Every block, each carrying text over its cap, for the SECOND direction: what the walker yields at
// runtime. It catches a site whose source spelling this file misread, which the scan cannot see.
const EVERY_BLOCK = {
  handoff: { instructions: HUGE },
  availability: { awayMessage: HUGE },
  contactAuth: { denyMessage: HUGE },
  kanban: { instructions: HUGE },
  toolGuidance: Object.fromEntries(NATIVE_TOOL_NAMES.map((n) => [n, HUGE])),
  guardrails: {
    customPolicy: HUGE,
    input: { templateMessage: HUGE },
    output: { templateMessage: HUGE, generationPrompt: HUGE },
  },
  signature: { text: HUGE },
  vision: { extractionPrompt: HUGE },
  followUp: { steps: [{ instructions: HUGE }, { instructions: HUGE }] },
};

const collapseYielded = (path: string): string =>
  path
    .replace(/^toolGuidance\..+$/, "toolGuidance.*")
    .replace(/^guardrails\.(input|output)\./, "guardrails.*.")
    .replace(/^followUp\.steps\[\d+\]\./, "followUp.steps[*].");

describe("the operator-text surface a rename has to follow", () => {
  test("every site in the walker's SOURCE is classified by who reads it", async () => {
    expect(await sitesInSource()).toEqual([...CLASSIFIED].sort());
  });

  test("what the walker YIELDS at runtime is the same set of sites", () => {
    const yielded = [
      ...new Set(
        collectOversizedTextChanges(EVERY_BLOCK, {}).map((f) =>
          collapseYielded(f.path),
        ),
      ),
    ].sort();
    expect(yielded).toEqual([...CLASSIFIED].sort());
  });

  test("the three classes are disjoint, so no site is both", () => {
    expect(new Set(CLASSIFIED).size).toBe(CLASSIFIED.length);
    for (const site of MODEL_WITH_TOOLS) {
      expect([...MODEL_WITHOUT_TOOLS, ...PERSON_FACING]).not.toContain(site);
    }
  });
});
