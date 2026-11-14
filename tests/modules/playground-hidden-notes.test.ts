import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { runPlaygroundTurn } from "@/modules/playground/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { ScriptedSilenceModel } from "../utils/scripted-models";

// The playground is where an operator first meets a model that hid its answer before a tool call and
// closed with a dash. The dash is not shown as the agent's reply, and the turn's hidden notes get the
// same `generate` line an inbox turn writes. Read from the real `execution_logs` rows.

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const NOTE =
  "O curso tem 5 módulos e 20 aulas, e a matrícula está no link que eu deixei acima.";

let tenantId = 0n;
let agentId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

describe.skipIf(!dbUp)(
  "a playground turn that hid a note and closed with a dash",
  () => {
    beforeAll(async () => {
      tenantId = (
        await suDb.tenant.create({
          data: { name: "PHN", slug: `phn-1788-${process.pid}` },
        })
      ).id;
      const key = (
        await suDb.vaultEntry.create({
          data: { tenantId, name: "k", secret: encryptJson("sk-k") },
          select: { id: true },
        })
      ).id;
      agentId = (
        await suDb.agent.create({
          data: {
            tenantId,
            name: "Vendas",
            systemPrompt: "x",
            modelConfig: {
              provider: "openai",
              model: "m",
              credentialRef: `vault:${key}`,
            },
          },
        })
      ).id;
    });

    beforeEach(async () => {
      await clearFlowLog(suDb, { tenantId });
    });

    afterAll(async () => {
      if (su && tenantId) {
        await clearFlowLog(su, { tenantId });
        await su.tenant.delete({ where: { id: tenantId } });
      }
      await su?.$disconnect();
      await app?.$disconnect();
    });

    test("the dash is not the reply, and the note's size is logged", async () => {
      const model = new ScriptedSilenceModel([
        { text: "", note: NOTE, calls: [{ name: "set_labels", args: {} }] },
        { text: "—" },
      ]);
      const result = await runPlaygroundTurn({
        ctx: ctx(),
        agentId,
        message: "quero ver o conteúdo do curso",
        guardrails: false,
        base: appDb,
        deps: {
          makeModel: (() => model) as never,
          checkpointer: new MemorySaver(),
        },
      });
      expect(result.reply).toBe("");
      const rows = await flowLogRows(suDb, {
        // flowlog-scope: agent — the file's one agent, whose lines beforeEach clears.
        where: { tenantId, agentId, stage: "generate" },
        select: { detail: true },
        orderBy: { id: "asc" },
      });
      const line = rows
        .map((r) => r.detail as Record<string, unknown> | null)
        .find((d) => d?.hiddenNotes !== undefined);
      expect(line).toEqual({ hiddenNotes: 1, hiddenNoteChars: NOTE.length });
    });
  },
);
