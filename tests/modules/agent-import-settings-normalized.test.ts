import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { dropUnusableImportedSettingsInPlace } from "@/modules/agents/service";
import { exportAgent, importAgent } from "@/modules/agents/transfer";

// WHAT CREATE REFUSES, AN IMPORT NORMALIZES AND NAMES (#631).
//
// Create and update refuse a closed settings value outside its domain (#626), half a model fallback and
// a tool guard that cannot parse. The import stored all of them as sent, with no warning, so a bundle
// edited by hand or written by another tool reached the table with exactly what the other two doors
// refuse, and the reader then answered its default while GET echoed the bundle. The import does not
// refuse a bundle whole over one field (transfer.ts already clamps over-cap prose for that reason): it
// takes the unusable value out, so the default applies, and says which path it took.
//
// Asked through `importAgent` alone, naming no new symbol, so on the base these fail on the assertion.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

let tenantId = 0n;
let agentId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

let seq = 0;
async function importWith(
  settings: Record<string, unknown>,
  opts: { dryRun?: boolean } = {},
) {
  const exp = await exportAgent(ctx(), agentId, appDb);
  seq += 1;
  const result = await importAgent(
    ctx(),
    { ...exp, agent: { ...exp.agent, name: `importado ${seq}`, settings } },
    appDb,
    opts,
  );
  const dropped = result.warnings
    .filter((w) => w.code === "settingsValueDropped")
    .map((w) => w.params?.field);
  if (opts.dryRun) return { result, dropped, stored: undefined };
  const row = await suDb.agent.findFirstOrThrow({
    where: { id: BigInt(result.agent.id) },
    select: { settings: true },
  });
  return {
    result,
    dropped,
    stored: row.settings as Record<string, Record<string, unknown>>,
  };
}

// THE CEILINGS ARE ON WORK, NOT ON THE ANSWER. Each reader comparison reads the whole block, so a bag
// with thousands of lists has to spend a bounded number of them and still normalize what it can: five
// thousand of these lists took 7.6s before the budget, past the import's own 5s transaction (review
// round 4). Asked of the pass itself, with no database in the way.
describe("the reader comparisons a bag can cost", () => {
  test("thousands of lists, one padding the reader does not honour, and the values still come out", () => {
    const labels = Array.from({ length: 1000 }, (_, i) => `l${i}`);
    const steps: unknown[] = [
      { delayValue: 1, delayUnit: " hours ", assignLabels: labels },
    ];
    for (let i = 1; i < 5000; i++) {
      steps.push({ delayValue: 1, delayUnit: "minutes", assignLabels: [1] });
    }
    const bag = { followUp: { enabled: true, steps } };
    const started = Date.now();
    const dropped = dropUnusableImportedSettingsInPlace(bag);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(dropped.count).toBe(5_000);
    expect(dropped.paths[0]).toBe("followUp.steps.0.delayUnit");
    // The pass answers a normalized copy of the block, so the bag is what to read.
    const first = (bag.followUp as { steps: { delayUnit?: string }[] })
      .steps[0];
    expect(first?.delayUnit).toBeUndefined();
  });
  // The tail cut is for a list the reader cuts to a window, and no cut reaches past what it is willing
  // to take: trying it on a long list read the whole block once per element for nothing (review round 5
  // measured 12s on fifteen thousand labels).
  test("a long list is not walked from the tail for a difference that is not its own", () => {
    const bag = {
      followUp: {
        enabled: true,
        steps: [
          {
            delayValue: 1,
            delayUnit: " hours ",
            assignLabels: [
              1,
              ...Array.from({ length: 15_000 }, (_, i) => `l${i}`),
            ],
          },
        ],
      },
    };
    const started = Date.now();
    const dropped = dropUnusableImportedSettingsInPlace(bag);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(dropped.count).toBe(2);
    expect(dropped.paths).toEqual([
      "followUp.steps.0.delayUnit",
      "followUp.steps.0.assignLabels.0",
    ]);
  });

  // AND THE BUDGET IS THE BAG'S, not the block's: a list the cut cannot reach is not only slow, it
  // spends comparisons the blocks after it needed. Two invalid steps leave this block unsettleable at
  // any price, and without the length gate the attempts walk eight lists of a hundred labels for
  // nothing, after which everything below is judged with nothing left: the nine values here come out
  // with the gate and none without it (measured while reading the mutation battery).
  test("a list too long for the tail cut does not spend the comparisons another block needs", () => {
    const labels = Array.from({ length: 100 }, (_, i) => `l${i}`);
    const steps: unknown[] = ["x", "x"];
    for (let i = 0; i < 8; i++) {
      steps.push({
        delayValue: 1,
        delayUnit: "minutes",
        assignLabels: [1, ...labels],
      });
    }
    for (let i = 0; i < 191; i++) {
      steps.push({ delayValue: 1, delayUnit: "minutes" });
    }
    const bag = {
      followUp: { enabled: true, steps },
      guardrails: { competitors: [1] },
    };
    const dropped = dropUnusableImportedSettingsInPlace(bag);
    expect(dropped.paths).toContain("followUp.steps.2.assignLabels.0");
    expect(dropped.paths).toContain("guardrails.competitors.0");
    expect(dropped.count).toBe(9);
    // The invalid steps themselves stay: taking one out moves the reader's ten-step window, which is
    // the difference no cut of this list can undo.
    expect(steps.length).toBe(201);
  });

  // The one-by-one path is the quadratic one, and its ceiling is the same promise: past it the block's
  // values stay where they are, and the bag's remaining comparisons go to the blocks that can use them.
  // Without the ceiling this block takes two hundred and fifty-five of its own values out and leaves
  // the one below it untouched.
  test("a block past the one-by-one ceiling does not spend the comparisons another block needs", () => {
    const steps: unknown[] = [];
    for (let i = 0; i < 500; i++) {
      steps.push(i < 300 ? "x" : { delayValue: 1, delayUnit: "minutes" });
    }
    const bag = {
      followUp: { enabled: true, steps },
      guardrails: { competitors: [1] },
    };
    const dropped = dropUnusableImportedSettingsInPlace(bag);
    expect(dropped.paths).toEqual(["guardrails.competitors.0"]);
    expect(steps.length).toBe(500);
  });

  // The reader this pass compares with is the one every TURN runs, and its label de-dupe scanned what it
  // had kept for each entry: a hundred thousand labels cost about ten seconds per read, so one
  // comparison overran the import's transaction however few comparisons were made (review round 6).
  test("a step with a hundred thousand labels is read in one pass, not one scan per label", () => {
    const bag = {
      followUp: {
        enabled: "sim",
        steps: [
          {
            delayValue: 1,
            delayUnit: "minutes",
            assignLabels: Array.from({ length: 100_000 }, (_, i) => `l${i}`),
          },
        ],
      },
    };
    const started = Date.now();
    const dropped = dropUnusableImportedSettingsInPlace(bag);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(dropped.paths).toEqual(["followUp.enabled"]);
  });

  // Bounding how MANY comparisons a block gets does not bound what one costs, and each is a clone and a
  // read of the block: a 2.8 MB block spent a small budget over six seconds (review round 7). A block
  // gets fewer comparisons the bigger it is, down to the single pass the batch exists to be.
  test("a block of three hundred thousand labels is judged in one pass, not in a budget of them", () => {
    const step = (labels: unknown[]) => ({
      delayValue: 1,
      delayUnit: "minutes",
      assignLabels: labels,
    });
    const bag = {
      followUp: {
        enabled: true,
        steps: [
          "x",
          step([1, ...Array.from({ length: 300_000 }, (_, i) => `l${i}`)]),
          ...Array.from({ length: 9 }, () => step([1, "vip"])),
        ],
      },
    };
    const started = Date.now();
    dropUnusableImportedSettingsInPlace(bag);
    // Eight times what the pass costs with the allowance (118ms measured here, 1.7s without it).
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  // A bundle's list is caller-sized, and the paths taken out are answered bounded and counted: spreading
  // a million of them threw `RangeError` and took the import and its preview with it.
  test("a million unusable entries answer a bounded list of paths and their count", () => {
    const bag = { guardrails: { competitors: Array(1_000_000).fill(1) } };
    const dropped = dropUnusableImportedSettingsInPlace(bag);
    expect(dropped.count).toBe(1_000_000);
    expect(dropped.paths.length).toBeLessThanOrEqual(64);
    expect(dropped.paths[0]).toBe("guardrails.competitors.0");
    expect((bag.guardrails as { competitors: unknown[] }).competitors).toEqual(
      [],
    );
  });
});

describe.skipIf(!dbUp)("an imported settings bag create would refuse", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Import normalizado", slug: `import-norm-${process.pid}` },
    });
    tenantId = t.id;
    const a = await suDb.agent.create({
      data: {
        tenantId,
        name: "Origem",
        systemPrompt: "Você atende.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {},
      },
    });
    agentId = a.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of ["agent_tool_selections", "agents"]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a closed value outside its domain is left out, and the warning names its path", async () => {
    const { stored, dropped } = await importWith({
      split: { enabled: "sim" },
      tts: { mode: "sempre" },
      signature: { enabled: true, text: "Equipe", position: "esquerda" },
      guardrails: { input: { checks: { promptAdherence: "sim" } } },
    });
    // As a set: the order follows the schema's blocks, which is not what this asks.
    expect([...dropped].sort()).toEqual(
      [
        "guardrails.input.checks.promptAdherence",
        "signature.position",
        "split.enabled",
        "tts.mode",
      ].sort(),
    );
    expect(stored?.split).toEqual({});
    expect(stored?.tts).toEqual({});
    // Only the unusable field goes: the rest of the block is what the bundle said.
    expect(stored?.signature).toEqual({ enabled: true, text: "Equipe" });
    expect(stored?.guardrails).toEqual({ input: { checks: {} } });
  });

  // A step keeps its place and its other fields: the reader reads a unit it does not know as its
  // default, so taking the unit out stores what the runtime already runs. An element of the wrong type
  // is one the reader drops, so it leaves the list, and every warning names the path AS WRITTEN.
  test("inside a list, a bad field leaves the element and a bad element leaves the list", async () => {
    const { stored, dropped } = await importWith({
      followUp: {
        enabled: true,
        steps: ["x", { delayValue: 2, delayUnit: "semanas" }, "y"],
      },
    });
    expect(dropped).toEqual([
      "followUp.steps.0",
      "followUp.steps.1.delayUnit",
      "followUp.steps.2",
    ]);
    expect(stored?.followUp).toEqual({
      enabled: true,
      steps: [{ delayValue: 2 }],
    });
  });

  // THE INVARIANT IS THE RUNTIME'S READING (review round 1). A value the reader throws away leaves the
  // reading unchanged when it goes; three that looked the same to the schema did not.
  test("a padded value the reader trims is stored trimmed, silently, and a padded guard keeps guarding", async () => {
    const { stored, dropped } = await importWith({
      tts: { mode: " mirror " },
      stt: { language: " pt-BR " },
      toolPreconditions: {
        handoff_to_human: { kind: "attribute", scope: " contact ", key: "cpf" },
      },
    });
    expect(dropped).toEqual([]);
    expect(stored?.tts).toEqual({ mode: "mirror" });
    expect(stored?.stt).toEqual({ language: "pt-BR" });
    expect(stored?.toolPreconditions).toEqual({
      handoff_to_human: { kind: "attribute", scope: "contact", key: "cpf" },
    });
  });

  // The follow-up reader cuts the list to its window BEFORE it drops bad steps, so taking out a bad
  // step inside the window alone would pull the step past it in, and that step can resolve the
  // conversation. The step that would slide in goes too, and both are named.
  test("taking a bad step out of the reader's window does not pull a step in from past it", async () => {
    const steps = Array.from({ length: 10 }, (_, i) => ({
      delayValue: i + 1,
      delayUnit: "minutes",
    }));
    const { stored, dropped } = await importWith({
      followUp: { enabled: true, steps: ["x", ...steps] },
    });
    expect(dropped).toEqual(["followUp.steps.0", "followUp.steps.10"]);
    expect(stored?.followUp).toEqual({
      enabled: true,
      steps: steps.slice(0, 9),
    });
  });

  // A BUNDLE IS CALLER INPUT, and the import runs inside a 5s transaction. One pass over the block,
  // not one pass per entry: judged one by one this took about 17 seconds for this list (review round 2).
  test("a list of fifty thousand unusable entries costs one pass, and the warnings are counted past the first twenty", async () => {
    const started = Date.now();
    const { stored, result } = await importWith({
      guardrails: { competitors: Array(50_000).fill(1) },
    });
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(stored?.guardrails).toEqual({ competitors: [] });
    const named = result.warnings.filter(
      (w) => w.code === "settingsValueDropped",
    );
    expect(named).toHaveLength(20);
    expect(named[0]?.params?.field).toBe("guardrails.competitors.0");
    const rest = result.warnings.find(
      (w) => w.code === "settingsValuesDroppedMore",
    );
    expect(rest?.params?.count).toBe(49_980);
  });

  // Every path names the position the BUNDLE wrote, however many elements came out before it.
  test("a second bad step past the window is named by its own index, not by where it ended up", async () => {
    const steps = Array.from({ length: 9 }, (_, i) => ({
      delayValue: i + 1,
      delayUnit: "minutes",
      instructions: `s${i}`,
    }));
    const { stored, dropped } = await importWith({
      followUp: {
        enabled: true,
        steps: ["x", ...steps, "y", { delayValue: 5, delayUnit: "hours" }],
      },
    });
    expect(dropped).toEqual([
      "followUp.steps.0",
      "followUp.steps.10",
      "followUp.steps.11",
    ]);
    expect(stored?.followUp).toEqual({ enabled: true, steps });
  });

  // A nested list is addressed through its element's index, so once an outer element is out that path
  // names something else. Resolving it a second time threw and took the import down (review round 3).
  test("a bad label inside a step survives an outer element leaving the list before it", async () => {
    const step = (i: number) => ({
      delayValue: i + 1,
      delayUnit: "minutes",
      instructions: `s${i}`,
    });
    const withLabels = { ...step(1), assignLabels: [1, "vip"] };
    const { stored, dropped } = await importWith({
      followUp: {
        enabled: true,
        steps: [
          "x",
          withLabels,
          ...Array.from({ length: 8 }, (_, i) => step(i + 2)),
          step(10),
        ],
      },
    });
    expect(dropped).toEqual([
      "followUp.steps.0",
      "followUp.steps.1.assignLabels.0",
      "followUp.steps.10",
    ]);
    const kept = stored?.followUp as
      | { steps?: { assignLabels?: string[] }[] }
      | undefined;
    expect(kept?.steps?.[0]?.assignLabels).toEqual(["vip"]);
  });

  test("half a model fallback is no fallback: the pair goes, the rest of the block stays", async () => {
    const half = await importWith({
      modelFallback: { provider: "openai", baseURL: "https://llm.example" },
    });
    expect(half.dropped).toEqual(["modelFallback"]);
    expect(half.stored?.modelFallback).toEqual({
      baseURL: "https://llm.example",
    });

    // The other half: a model with no provider names no destination either.
    const modelOnly = await importWith({ modelFallback: { model: "gpt-4o" } });
    expect(modelOnly.dropped).toEqual(["modelFallback"]);
    expect(modelOnly.stored?.modelFallback).toEqual({});
  });

  // Issue #646: the contact gate's local rule, which create refuses and the reader drops. Carried in
  // silently it reads as a list in the bundle and as no rule at runtime. A valid one is kept.
  test("a contact-gate rule that cannot parse is dropped and named, a valid one is kept", async () => {
    const bad = await importWith({
      contactAuth: {
        enabled: true,
        rule: { kind: "allowlist", phones: ["123"] },
      },
    });
    expect(bad.dropped).toEqual(["contactAuth.rule"]);
    expect(
      (bad.stored?.contactAuth as Record<string, unknown>)?.rule,
    ).toBeUndefined();
    const good = await importWith({
      contactAuth: {
        enabled: true,
        rule: { kind: "allowlist", phones: ["+5511988887777"] },
      },
    });
    expect(good.dropped).toEqual([]);
    expect((good.stored?.contactAuth as Record<string, unknown>)?.rule).toEqual(
      { kind: "allowlist", phones: ["+5511988887777"] },
    );
  });

  // Whole, never one field of it: taking out only the `equals` of the wrong type would turn "the
  // attribute must be X", which the runtime ignores, into "the attribute must exist".
  test("a tool guard that cannot parse is dropped whole, and a valid one under a renamed native is kept", async () => {
    const { stored, dropped } = await importWith({
      toolPreconditions: {
        handoff_to_human: {
          kind: "attribute",
          scope: "contact",
          key: "cpf",
          equals: 5,
        },
        assign_label: { kind: "attribute", scope: "contact", key: "cpf" },
      },
    });
    expect(dropped).toEqual(["toolPreconditions.handoff_to_human"]);
    expect(stored?.toolPreconditions).toEqual({
      set_labels: { kind: "attribute", scope: "contact", key: "cpf" },
    });

    const shape = await importWith({ toolPreconditions: "x" });
    expect(shape.dropped).toEqual(["toolPreconditions"]);
    expect(shape.stored?.toolPreconditions).toBeUndefined();

    // A `null` rule is a removal create accepts and the reader ignores: nothing to take out or warn about.
    const tombstone = await importWith({
      toolPreconditions: { handoff_to_human: null },
    });
    expect(tombstone.dropped).toEqual([]);
    expect(tombstone.stored?.toolPreconditions).toEqual({
      handoff_to_human: null,
    });
  });

  test("observability.fullDetail is derived: it is not stored, and the warning names it", async () => {
    const { stored, dropped } = await importWith({
      observability: { fullDetail: true, logToolValues: true },
    });
    expect(dropped).toEqual(["observability.fullDetail"]);
    expect(stored?.observability).toEqual({ logToolValues: true });
  });

  test("what create accepts is imported untouched, with no warning", async () => {
    const settings = {
      split: { enabled: false },
      tts: { mode: "mirror" },
      vision: { extractionPrompt: null },
      guardrails: {
        input: {
          checks: { promptAdherence: false, answerRelevance: false },
          generationPrompt: "",
        },
      },
      followUp: {
        enabled: true,
        steps: [{ delayValue: 3, delayUnit: "days" }],
      },
      memory: {},
      // No fallback named at all is not half of one.
      modelFallback: {},
      somethingNew: { a: 1 },
    };
    const { stored, dropped } = await importWith(structuredClone(settings));
    expect(dropped).toEqual([]);
    expect(stored).toEqual(settings);
  });

  test("the dry run answers the same warnings and creates nothing", async () => {
    const bag = { split: { enabled: "sim" }, modelFallback: { model: "m" } };
    const before = await suDb.agent.count({ where: { tenantId } });
    const dry = await importWith(structuredClone(bag), { dryRun: true });
    expect(await suDb.agent.count({ where: { tenantId } })).toBe(before);
    const real = await importWith(structuredClone(bag));
    expect(dry.dropped).toEqual(["split.enabled", "modelFallback"]);
    expect(real.dropped).toEqual(dry.dropped);
  });

  test("an export of a valid agent imports with the same bag and no warning", async () => {
    const settings = {
      split: { enabled: true },
      signature: { enabled: true, text: "Equipe", position: "bottom" },
      handoff: { mode: "route" },
    };
    const src = await suDb.agent.create({
      data: {
        tenantId,
        name: "Válida",
        systemPrompt: "Você atende.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings,
      },
    });
    const exp = await exportAgent(ctx(), src.id, appDb);
    const { agent, warnings } = await importAgent(
      ctx(),
      { ...exp, agent: { ...exp.agent, name: "Válida importada" } },
      appDb,
    );
    const row = await suDb.agent.findFirstOrThrow({
      where: { id: BigInt(agent.id) },
      select: { settings: true },
    });
    expect(row.settings).toEqual(settings);
    expect(warnings.filter((w) => w.code === "settingsValueDropped")).toEqual(
      [],
    );
  });
});
