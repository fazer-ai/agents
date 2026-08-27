import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  type AgentConfig,
  buildToolset,
  type ToolsetCtx,
} from "@/graph/prepare";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";
import type { FlowContext } from "@/modules/flowlog/service";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import { clearFlowLog } from "../utils/flowlog";

// ── A TOOL DROPPED FOR A DUPLICATE NAME HAS TO SAY SO WHERE THE OPERATOR LOOKS (#389) ──
//
// When two sources claim one name the assembly keeps the first and drops the rest, which is the right
// call — refusing to build the toolset would take the whole agent down over one name. What was
// missing is the telling: the only record was a `logger.warn` on stdout, and on a managed deploy the
// operator may have no way to read that at all. What they see is an agent that stopped doing one
// thing, with a Logs page that shows a perfectly ordinary turn.
//
// The sibling case one seam over — a precondition rule matching no assembled tool — has reported
// itself to the flow log since #101, and it is decided in the same function, at the same moment,
// about the same toolset. This asserts the line lands in `execution_logs`, which is the table the
// Logs page reads: asserting the emit call would prove the wiring and not the record.

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

// A tool that answers to `dup`, standing in for a native one. The collision is what is under test,
// so the two sides are the smallest things that can collide.
function fakeTool(name: string): StructuredToolInterface {
  return {
    name,
    description: "d",
    schema: { type: "object", properties: {} },
    invoke: async () => "",
  } as unknown as StructuredToolInterface;
}

function config(): AgentConfig {
  return {
    agentId: 1n,
    contactDbId: null,
    conversationDbId: null,
    contactVoiceReply: null,
    documentSelections: [],
    handoffConfig: HANDOFF_DEFAULTS,
    kanbanConfig: KANBAN_DEFAULTS,
    contactAuth: CONTACT_AUTH_DEFAULTS,
    sendImageConfig: SEND_IMAGE_DEFAULTS,
    httpToolContext: {},
    // The second claimant. `buildNativeTools` below is the first, and native goes first in the
    // assembly, so this is the one that loses.
    httpToolDefs: [
      {
        name: "dup",
        description: "an HTTP tool that wants a name it cannot have",
        method: "GET",
        urlTemplate: "https://example.com/v1",
        allowedHosts: ["example.com"],
        headers: {},
        inputSchema: {},
      },
    ],
    integrationSelections: [],
    mcpSelections: [],
    nativeToolsAllow: undefined,
    ragConfig: undefined,
    timezone: "America/Sao_Paulo",
    toolGuidance: {},
    toolPreconditions: {},
    transferWithSummary: true,
  } as unknown as AgentConfig;
}

function ctx(): ToolsetCtx {
  return {
    tenantId,
    instanceId: 1n,
    base: appDb,
    client: {} as ChatwootClient,
    conversationId: 1,
    threadId: `t-${process.pid}`,
  };
}

// No cast: `turnId` is required and a `as FlowContext` hid that, so the write failed on a missing
// column and the case read as "no line was written". The type is the control here.
function flow(): FlowContext {
  return {
    tenantId,
    turnId: crypto.randomUUID(),
    source: "inbox",
    agentId: 1n,
    threadId: `t-${process.pid}`,
    base: appDb,
  };
}

async function droppedLines() {
  await settleFlowEvents();
  const rows = await suDb.executionLog.findMany({
    where: { tenantId, stage: "tool" },
    orderBy: { id: "asc" },
  });
  return rows.filter(
    (r) =>
      (r.detail as { phase?: string } | null)?.phase ===
      "duplicate_name_dropped",
  );
}

describe.skipIf(!dbUp)("a tool dropped for a duplicate name", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Dup", slug: `dup-389-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      await suDb.tenant.delete({ where: { id: tenantId } });
    }
    await app?.$disconnect();
    await su?.$disconnect();
  });

  test("writes a line the Logs page can show, naming the tool that lost", async () => {
    const tools = await buildToolset(config(), ctx(), {
      buildNativeTools: () => [fakeTool("dup")],
      flow: flow(),
    });
    // The control, and it is the half that says the drop really happened: one `dup` survived.
    expect(tools.filter((t) => t.name === "dup")).toHaveLength(1);

    const lines = await droppedLines();
    expect(lines).toHaveLength(1);
    const detail = lines[0]?.detail as { tools?: string[] };
    expect(detail.tools).toEqual(["dup"]);
    // INFO: a duplicate stands until the operator renames something, so a warn would page the alert
    // channels once per turn for as long as it lasts.
    expect(lines[0]?.level).toBe("info");
  });

  test("and says nothing at all when no name is contested", async () => {
    await clearFlowLog(suDb, { tenantId });
    const tools = await buildToolset(config(), ctx(), {
      buildNativeTools: () => [fakeTool("something_else")],
      flow: flow(),
    });
    expect(tools.map((t) => t.name).sort()).toEqual(["dup", "something_else"]);
    expect(await droppedLines()).toHaveLength(0);
  });
});
