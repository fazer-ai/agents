import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Serialized } from "@langchain/core/load/serializable";
import { ToolMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { SKIP_REPLY_MARK, SKIP_REPLY_REASON_KEY } from "@/graph/silence";
import { ToolFlowLogger } from "@/graph/tool-flowlog";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// The dashboard counts the agent's silences by the reason it picked. The reason is a
// closed vocabulary, so `skip_reply`'s line records it as a value; the arguments stay shapes, and no
// other tool's line gains the key.

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
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;

async function run(
  tool: string,
  input: string,
  output: unknown,
  opts: { handedOff?: () => boolean } = {},
): Promise<Record<string, unknown>> {
  const turnId = crypto.randomUUID();
  const logger = new ToolFlowLogger(
    {
      tenantId,
      turnId,
      source: "inbox",
      base: appDb,
    },
    opts,
  );
  logger.handleToolStart(
    {} as Serialized,
    input,
    "run-1",
    undefined,
    undefined,
    undefined,
    tool,
  );
  logger.handleToolEnd(output, "run-1");
  const rows = await flowLogRows(suDb, {
    where: { tenantId, turnId, stage: "tool" },
    select: { detail: true },
  });
  expect(rows).toHaveLength(1);
  return (rows[0]?.detail ?? {}) as Record<string, unknown>;
}

function skipResult(reason: unknown) {
  return new ToolMessage({
    content: "Skipped (needs_human). Produce no message now.",
    tool_call_id: "call-1",
    name: "skip_reply",
    additional_kwargs: {
      [SKIP_REPLY_MARK]: true,
      [SKIP_REPLY_REASON_KEY]: reason,
    },
  });
}

describe.skipIf(!dbUp)("skip_reply's line carries the reason picked", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SKIPREASON", slug: `skipreason-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("each reason of the vocabulary is recorded as itself", async () => {
    for (const reason of ["acknowledged", "not_for_us", "needs_human"]) {
      const detail = await run(
        "skip_reply",
        JSON.stringify({ reason, detail: "texto do modelo" }),
        skipResult(reason),
      );
      expect(detail.skipReason).toBe(reason);
      // The free-text detail stays a shape, as every argument does.
      expect(JSON.stringify(detail.args)).not.toContain("texto do modelo");
    }
  });

  test("a value outside the vocabulary, or no mark at all, records nothing", async () => {
    expect(
      (await run("skip_reply", "{}", skipResult("anything"))).skipReason,
    ).toBeUndefined();
    expect(
      (await run("skip_reply", "{}", { content: "ok" })).skipReason,
    ).toBeUndefined();
  });

  test("no other tool's line gains the key", async () => {
    const detail = await run(
      "handoff_to_human",
      "{}",
      skipResult("needs_human"),
    );
    expect("skipReason" in detail).toBe(false);
  });

  test("handoff_to_human's line says whether the transfer happened, not only that the call returned", async () => {
    // A call off while the note was in flight returns normally and transfers nothing.
    const declined = await run(
      "handoff_to_human",
      "{}",
      {
        content:
          "Did not hand off (the run was called off while the note was in flight).",
      },
      { handedOff: () => false },
    );
    expect(declined.handedOff).toBe(false);
    const done = await run(
      "handoff_to_human",
      "{}",
      { content: "Handed off." },
      { handedOff: () => true },
    );
    expect(done.handedOff).toBe(true);
    // Nobody to ask (playground, observer), or another tool: the key is absent, never false.
    expect(
      "handedOff" in (await run("handoff_to_human", "{}", { content: "x" })),
    ).toBe(false);
    expect(
      "handedOff" in
        (await run("skip_reply", "{}", skipResult("needs_human"), {
          handedOff: () => true,
        })),
    ).toBe(false);
  });
});
