import { describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import {
  collectOversizedTextChanges,
  EXTRACTION_PROMPT_MAX,
} from "@/modules/agents/text-caps";
import {
  CLASSIFIED,
  NAMES_AGENT_TOOLS,
  NO_TOOL_MEANING,
  PERSON_FACING,
  TOOL_COLUMNS,
} from "../utils/operator-text-classes";
import { withoutComments } from "../utils/source-text";

// The surface a rename of a model-visible name has to follow: the operator's prose, in the sites of
// the `src/modules/agents/text-caps.ts` walker. A site added to the walk is invisible to every
// rename written before it, so every site must be classified in
// `tests/utils/operator-text-classes.ts`, which the next rename inherits. It demands that decision,
// not a migration per site (a new field holds no old tool name). Nothing here reads a migration's
// `.sql`, which a reformat would turn red while changing nothing;
// `tests/prisma/settings-text-rename-migration.test.ts` checks the rows.

// An interpolated segment is a family of paths, and the family is one site.
const collapse = (path: string): string => path.replace(/\$\{[^}]*\}/g, "*");

// The walker's sites, read from its SOURCE, which catches a field somebody adds: an enumeration
// driven by a FIXTURE only yields the fields the fixture carries, so a new `add()` call stays green.
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
    input: { templateMessage: HUGE, handoffMessage: HUGE },
    output: {
      templateMessage: HUGE,
      generationPrompt: HUGE,
      handoffMessage: HUGE,
    },
  },
  signature: { text: HUGE },
  vision: { extractionPrompt: HUGE },
  followUp: { steps: [{ instructions: HUGE }, { instructions: HUGE }] },
  snoozedFollowUp: {
    cadences: [
      { steps: [{ instructions: HUGE }] },
      { steps: [{ instructions: HUGE }] },
    ],
  },
  tts: { spokenNoticeText: HUGE, textChoiceNote: HUGE },
};

const collapseYielded = (path: string): string =>
  path
    .replace(/^toolGuidance\..+$/, "toolGuidance.*")
    .replace(/^guardrails\.(input|output)\./, "guardrails.*.")
    .replace(/^followUp\.steps\[\d+\]\./, "followUp.steps[*].")
    .replace(
      /^snoozedFollowUp\.cadences\[\d+\]\.steps\[\d+\]\./,
      "snoozedFollowUp.cadences[*].steps[*].",
    );

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

  // NOTE: the second population is prose on the two tool definition tables. `text-caps.ts` cannot
  // see it, so the inventory is the generated client's own data model, which is the schema as the
  // runtime reads it.
  test("every STRING column of a tool definition is classified", () => {
    const client = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: "postgres://unused@localhost:1/unused",
      }),
    }) as unknown as {
      _runtimeDataModel: {
        models: Record<string, { fields: { name: string; type: string }[] }>;
      };
    };
    const found: string[] = [];
    for (const model of ["ToolDefinition", "CodeToolDefinition"]) {
      const fields = client._runtimeDataModel.models[model]?.fields;
      if (!fields)
        throw new Error(`model ${model} not in the generated client`);
      for (const f of fields) {
        if (f.type === "String") found.push(`${model}.${f.name}`);
      }
    }
    expect(found.sort()).toEqual(Object.keys(TOOL_COLUMNS).sort());
  });

  test("the tool columns a rename rewrites are exactly the two descriptions", () => {
    const rewritten = Object.entries(TOOL_COLUMNS)
      .filter(([, c]) => c === "names_agent_tools")
      .map(([k]) => k);
    expect(rewritten.sort()).toEqual([
      "CodeToolDefinition.description",
      "ToolDefinition.description",
    ]);
  });

  test("the three classes are disjoint, so no site is both", () => {
    expect(new Set(CLASSIFIED).size).toBe(CLASSIFIED.length);
    for (const site of NAMES_AGENT_TOOLS) {
      expect([...NO_TOOL_MEANING, ...PERSON_FACING]).not.toContain(site);
    }
  });
});
