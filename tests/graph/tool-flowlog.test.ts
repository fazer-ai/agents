import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildAgentGraph } from "@/graph/graph";
import { ToolFlowLogger } from "@/graph/tool-flowlog";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import type { TenantContext } from "@/lib/tenancy";
import { createAlertChannel } from "@/modules/flowlog/channels";
import type { FlowContext } from "@/modules/flowlog/service";
import { outboundUrl } from "../utils/outbound";

// NOTE: The tool line of the execution-flow log must distinguish integration failures from successes:
// a ToolMessage with status "error" (failableTool) is logged as ONE warn/error line with the
// friendly string as errorMessage, so alert channels (minLevel warn) can fire (issue #40).

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

function flowCtx(): FlowContext {
  return {
    tenantId,
    turnId: crypto.randomUUID(),
    source: "inbox",
    base: appDb,
  };
}

type LogRow = {
  level: string;
  status: string | null;
  errorMessage: string | null;
  detail: unknown;
};

// NOTE: emitFlowEvent is fire-and-forget; poll until the expected row count lands.
async function pollToolRows(turnId: string, count: number): Promise<LogRow[]> {
  for (let i = 0; i < 50; i++) {
    const rows = await suDb.executionLog.findMany({
      where: { tenantId, turnId, stage: "tool" },
      select: {
        level: true,
        status: true,
        errorMessage: true,
        detail: true,
      },
    });
    if (rows.length >= count) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

// NOTE: Scripted model: first call emits a tool_call for `toolName`, second call replies with text.
// Captures every message list it is invoked with, so the test can assert what the model SAW.
class ToolCallThenReplyModel {
  seen: BaseMessage[][] = [];
  constructor(
    private toolName: string,
    private reply: string,
  ) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage(this.reply);
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(messages: BaseMessage[]): Promise<AIMessage> {
        self.seen.push(messages);
        n++;
        return n === 1
          ? new AIMessage({
              content: "",
              tool_calls: [
                { name: self.toolName, args: { fail: true }, id: "call_f1" },
              ],
            })
          : new AIMessage(self.reply);
      },
    };
  }
}

describe.skipIf(!dbUp)("ToolFlowLogger — failure-aware tool lines", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TFL", slug: `tfl-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "alert_deliveries",
        "alert_channels",
        "execution_logs",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a plain string output logs info/ok (regression pin)", async () => {
    const flow = flowCtx();
    const logger = new ToolFlowLogger(flow);
    logger.handleToolStart(
      {} as never,
      '{"q":"x"}',
      "run-ok",
      undefined,
      undefined,
      undefined,
      "probe",
    );
    logger.handleToolEnd("all good", "run-ok");
    const rows = await pollToolRows(flow.turnId, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe("info");
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.errorMessage).toBeNull();
  });

  test("a ToolMessage with status error logs ONE warn/error line carrying the message", async () => {
    const flow = flowCtx();
    const logger = new ToolFlowLogger(flow);
    logger.handleToolStart(
      {} as never,
      "{}",
      "run-fail",
      undefined,
      undefined,
      undefined,
      "probe",
    );
    logger.handleToolEnd(
      new ToolMessage({
        status: "error",
        content: "Google Calendar returned HTTP 500.",
        tool_call_id: "c1",
        name: "probe",
      }),
      "run-fail",
    );
    const rows = await pollToolRows(flow.turnId, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe("warn");
    expect(rows[0]?.status).toBe("error");
    expect(rows[0]?.errorMessage).toContain(
      "Google Calendar returned HTTP 500.",
    );
    expect((rows[0]?.detail as Record<string, unknown> | null)?.output).toBe(
      "Google Calendar returned HTTP 500.",
    );
  });

  test("e2e through the graph: one warn line AND the model sees the exact friendly string", async () => {
    const MSG = "The payment provider rejected the request (HTTP 503).";
    const probe = failableTool(async () => toolFailure(MSG), {
      name: "probe_fail",
      description: "always fails",
      schema: z.object({ fail: z.boolean().optional() }),
    });
    const model = new ToolCallThenReplyModel("probe_fail", "entendi");
    const graph = buildAgentGraph({
      model: model as unknown as BaseChatModel,
      systemPrompt: "Você é prestativa.",
      checkpointer: new MemorySaver(),
      tools: [probe],
    });
    const flow = flowCtx();
    await graph.invoke(
      { messages: [new HumanMessage("oi")] },
      {
        configurable: { thread_id: `tfl-${process.pid}` },
        callbacks: [new ToolFlowLogger(flow)],
      },
    );

    const second = model.seen[1] ?? [];
    const toolMsg = second.find((m) => m.getType() === "tool") as
      | ToolMessage
      | undefined;
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toBe(MSG);
    expect(toolMsg?.status).toBe("error");
    expect(toolMsg?.tool_call_id).toBe("call_f1");

    const rows = await pollToolRows(flow.turnId, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe("warn");
    expect(rows[0]?.status).toBe("error");
    expect(rows[0]?.errorMessage).toContain("HTTP 503");
  });

  test("the issue's full loop: a marked failure creates an alert delivery for a minLevel:warn channel", async () => {
    const ctx: TenantContext = { tenantId, userId: null, role: "TENANT_ADMIN" };
    const channel = await createAlertChannel(
      ctx,
      {
        name: "Ops",
        type: "webhook",
        url: outboundUrl("/hooks/ops"),
        minLevel: "warn",
      },
      appDb,
    );

    const MSG = "Google Drive returned HTTP 403.";
    const probe = failableTool(async () => toolFailure(MSG), {
      name: "probe_alert",
      description: "always fails",
      schema: z.object({ fail: z.boolean().optional() }),
    });
    const model = new ToolCallThenReplyModel("probe_alert", "ok");
    const graph = buildAgentGraph({
      model: model as unknown as BaseChatModel,
      systemPrompt: "Você é prestativa.",
      checkpointer: new MemorySaver(),
      tools: [probe],
    });
    const flow = flowCtx();
    await graph.invoke(
      { messages: [new HumanMessage("oi")] },
      {
        configurable: { thread_id: `tfl-alert-${process.pid}` },
        callbacks: [new ToolFlowLogger(flow)],
      },
    );

    // NOTE: The delivery row is what the alert worker POSTs from — before this fix the failure was
    // logged info/ok and no channel could ever produce one (the issue's exact complaint).
    let delivery: { stage: string | null; level: string | null } | null = null;
    for (let i = 0; i < 50 && !delivery; i++) {
      delivery = await suDb.alertDelivery.findFirst({
        where: { tenantId, channelId: BigInt(channel.id), stage: "tool" },
        select: { stage: true, level: true },
      });
      if (!delivery) await new Promise((r) => setTimeout(r, 100));
    }
    expect(delivery).not.toBeNull();
    expect(delivery?.level).toBe("warn");
  });
});
