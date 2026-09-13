import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
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

  test("half a model fallback is no fallback: the pair goes, the rest of the block stays", async () => {
    const half = await importWith({
      modelFallback: { provider: "openai", baseURL: "https://llm.example" },
    });
    expect(half.dropped).toEqual(["modelFallback"]);
    expect(half.stored?.modelFallback).toEqual({
      baseURL: "https://llm.example",
    });
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
  });

  test("observability.fullDetail is derived: it is not stored, and nothing configured was lost to warn about", async () => {
    const { stored, dropped } = await importWith({
      observability: { fullDetail: true },
    });
    expect(dropped).toEqual([]);
    expect(stored?.observability).toEqual({});
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
