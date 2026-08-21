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
    private args: Record<string, unknown> = { fail: true },
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
                { name: self.toolName, args: self.args, id: "call_f1" },
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
    // The failure text lives in errorMessage, which has its own sanitizer and its own contract.
    // `detail` keeps only the shape of what came back (issue #78): a tool result is a provider's
    // response body, which is no more allowlisted than the arguments that produced it.
    expect((rows[0]?.detail as Record<string, unknown> | null)?.output).toBe(
      "string(34)",
    );
  });

  // The other half of that same contract, which was not being kept (issue #141). An operator's HTTP
  // tool returns `HTTP <status>\n<body>`, and the body is the other end's: a business API answers a
  // failed lookup with the customer's own record in it. `detail.output` was already reduced to a
  // shape; `errorMessage` was taking the identical string whole, so the row kept by one column what
  // the column beside it had just refused. The diagnosis is the part we wrote: the status line.
  test("a returned failure keeps the status line we wrote, never the body the other end sent", async () => {
    const flow = flowCtx();
    const logger = new ToolFlowLogger(flow);
    logger.handleToolStart(
      {} as never,
      "{}",
      "run-body",
      undefined,
      undefined,
      undefined,
      "consulta_paciente",
    );
    logger.handleToolEnd(
      new ToolMessage({
        status: "error",
        content:
          'HTTP 422\n{"erro":"paciente Zebrafina Quixotesca (CPF 12345678900) nao encontrado"}',
        tool_call_id: "c2",
        name: "consulta_paciente",
      }),
      "run-body",
    );
    const rows = await pollToolRows(flow.turnId, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe("warn");
    // Still enough to alert on and to diagnose: which tool, and what the other end answered.
    expect(rows[0]?.errorMessage).toBe("HTTP 422");
    expect(rows[0]?.errorMessage).not.toContain("Zebrafina");
    expect(rows[0]?.errorMessage).not.toContain("12345678900");
    expect(JSON.stringify(rows[0]?.detail)).not.toContain("12345678900");
  });

  // `logToolValues` is the escape hatch the repo already gives an operator investigating one agent,
  // and it has to reach this column too: switching it on and still getting a truncated cause would
  // send them looking for a second switch that does not exist.
  test("logToolValues keeps the whole failure, body included", async () => {
    const flow = flowCtx();
    const logger = new ToolFlowLogger(flow, { logValues: true });
    logger.handleToolStart(
      {} as never,
      "{}",
      "run-body-on",
      undefined,
      undefined,
      undefined,
      "consulta_paciente",
    );
    logger.handleToolEnd(
      new ToolMessage({
        status: "error",
        content: 'HTTP 422\n{"erro":"registro 991 nao encontrado"}',
        tool_call_id: "c3",
        name: "consulta_paciente",
      }),
      "run-body-on",
    );
    const rows = await pollToolRows(flow.turnId, 1);
    expect(rows[0]?.errorMessage).toContain("registro 991 nao encontrado");
  });

  // A result is authored end to end by whatever answered the call, so no key in it has a declaration
  // behind it and none is ever named.
  test("a tool result never contributes key names, only its size", async () => {
    const flow = flowCtx();
    const logger = new ToolFlowLogger(flow, { tools: [] });
    logger.handleToolStart(
      {} as never,
      "{}",
      "run-obj",
      undefined,
      undefined,
      undefined,
      "probe",
    );
    // The ToolMessage-like shape the callback receives, with a structured content — which is where a
    // provider's own keys would arrive.
    logger.handleToolEnd(
      { content: { cpf: "12345678900", nome: "Maria Souza" } },
      "run-obj",
    );
    const rows = await pollToolRows(flow.turnId, 1);
    const detail = rows[0]?.detail as Record<string, unknown> | null;
    expect(JSON.stringify(detail)).not.toContain("Maria");
    expect(JSON.stringify(detail)).not.toContain("12345678900");
    expect(JSON.stringify(detail)).not.toContain("cpf");
    expect(detail?.output).toBe("object(2 keys)");
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
  // Issue #65 review: a tool's ARGUMENTS land in ExecutionLog.detail, which docs/logs.md states never
  // carries message text or PII. send_image adds two shapes the secret redactor does not catch: a URL
  // whose credential rides in the query (a presigned link — `redactSecretsDeep` keys off names like
  // `api_key`, not off `X-Amz-Signature`), and a caption, which is text written for the customer.
  describe("tool args reaching storage", () => {
    async function argsLoggedFor(
      args: Record<string, unknown>,
      opts: { logValues?: boolean } = {},
    ) {
      const probe = failableTool(async () => "ok", {
        name: "probe_image",
        description: "probe",
        schema: z.object({
          url: z.string().optional(),
          caption: z.string().optional(),
        }),
      });
      const model = new ToolCallThenReplyModel("probe_image", "pronto", args);
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
          configurable: { thread_id: `tfl-args-${crypto.randomUUID()}` },
          // Same as production: the logger gets the toolset, which is where the declared parameter
          // names come from. Without it no key is ever named (issue #78, round 1).
          callbacks: [new ToolFlowLogger(flow, { ...opts, tools: [probe] })],
        },
      );
      const rows = await pollToolRows(flow.turnId, 1);
      const detail = rows[0]?.detail as { args?: Record<string, unknown> };
      return detail?.args;
    }

    test("a URL is replaced, not trimmed down to something still readable", async () => {
      const logged = await argsLoggedFor({
        url: "https://bucket.s3.amazonaws.com/fotos/camiseta.png?X-Amz-Signature=deadbeefcafe0000&X-Amz-Credential=CRED",
      });
      expect(logged?.url).toMatch(/^string\(\d+\)$/);
      expect(JSON.stringify(logged)).not.toContain("deadbeefcafe0000");
    });

    // Everything past the scheme is model-written free text: an order number, a document, a person's
    // name in a filename — and the HOST too, because an operator who allows `*.loja.com.br` has handed
    // the model the subdomain. `detail` is documented to hold ids/counts/enums and to be exportable.
    test("an identifying path does not survive into storage", async () => {
      const logged = await argsLoggedFor({
        url: "https://cdn.loja.com.br/pedidos/48213/nota-fiscal-maria-silva.png",
      });
      expect(logged?.url).toMatch(/^string\(\d+\)$/);
      expect(JSON.stringify(logged)).not.toContain("maria-silva");
      expect(JSON.stringify(logged)).not.toContain("48213");
    });

    test("a subdomain the model chose under a wildcard host is gone too", async () => {
      const logged = await argsLoggedFor({
        url: "https://pedido-48213.loja.com.br/foto.png",
      });
      expect(logged?.url).toMatch(/^string\(\d+\)$/);
      expect(JSON.stringify(logged)).not.toContain("48213");
    });

    test("credentials embedded in the URL itself are dropped too", async () => {
      const logged = await argsLoggedFor({
        url: "https://usuario:senha-secreta@cdn.loja.com.br/fotos/x.png",
      });
      expect(logged?.url).toMatch(/^string\(\d+\)$/);
      expect(JSON.stringify(logged)).not.toContain("senha-secreta");
      expect(JSON.stringify(logged)).not.toContain("usuario");
    });

    // WHATWG ignores leading spaces and control characters, so this is a working URL to `new URL()`
    // and to `fetch` — and was ordinary text to a `^https?` prefix check, which stored it whole.
    test("whitespace in front of a URL does not smuggle it past the sanitizer", async () => {
      const logged = await argsLoggedFor({
        url: " \thttps://cdn.loja.com.br/fotos/x.png?token=segredo-escondido",
      });
      expect(logged?.url).toMatch(/^string\(\d+\)$/);
      expect(JSON.stringify(logged)).not.toContain("segredo-escondido");
    });

    // A string that announces itself as http(s) and then does not parse is exactly the case where we
    // cannot tell which part of it is host and which is payload, so none of it is kept.
    test("a URL that does not parse is replaced, not passed through", async () => {
      const logged = await argsLoggedFor({
        url: "https://cdn.loja.com.br:99999/x.png?token=segredo-em-voo",
      });
      expect(logged?.url).toMatch(/^string\(\d+\)$/);
      expect(JSON.stringify(logged)).not.toContain("segredo-em-voo");
    });

    // A key the model invented (a free-form record parameter, or any provider-authored result) has no
    // declaration behind it, so it is counted rather than logged. The identifier-looking shortcut this
    // replaced would have logged `Maria` verbatim.
    test("a key that no schema declared is counted, not named", async () => {
      const logged = await argsLoggedFor({
        url: "https://cdn.loja.com.br/x.png",
        Maria: "cliente vip",
      });
      expect(logged).not.toHaveProperty("Maria");
      expect(JSON.stringify(logged)).not.toContain("Maria");
      expect(logged?.["[unnamed keys]"]).toBe(1);
    });

    // The escape hatch (agent.settings.observability.logToolValues). An operator who owns the data
    // governance of their instance can trade the column's promise for the answer to "which record did
    // it look up"; the default is the promise.
    test("with the switch on, the values are stored as sent", async () => {
      const logged = await argsLoggedFor(
        { url: "https://cdn.loja.com.br/x.png", caption: "Oi Maria" },
        { logValues: true },
      );
      expect(logged?.url).toBe("https://cdn.loja.com.br/x.png");
      expect(logged?.caption).toBe("Oi Maria");
    });

    test("a caption never reaches storage at all", async () => {
      const logged = await argsLoggedFor({
        url: "https://cdn.loja.com.br/x.png",
        caption: "Oi Maria, aqui está o modelo que você pediu",
      });
      // The caption used to be dropped by NAME; now it is described like anything else, and the
      // text is gone either way — without a list of key names to keep adding to.
      expect(logged?.caption).toMatch(/^string\(\d+\)$/);
      expect(JSON.stringify(logged)).not.toContain("Maria");
    });
  });
});
