import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  type AgentConfig,
  buildToolset,
  type ToolsetCtx,
} from "@/graph/prepare";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// Issue #638: the list reaches the tool through the toolset the runtime builds, not only through a
// ctx a unit test hands to `buildNativeTools` itself. Asked of `buildToolset` with the native
// builder injected, so what is checked is exactly the object the runtime passes on.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let app: PrismaClient | undefined;
let su: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
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
    codeToolDefs: [],
    httpToolDefs: [],
    integrationSelections: [],
    mcpSelections: [],
    nativeToolsAllow: undefined,
    ragConfig: undefined,
    timezone: "America/Sao_Paulo",
    toolGuidance: {},
    toolPreconditions: {},
    transferWithSummary: true,
    protectedLabels: ["agente-off"],
    allowedLabels: ["vip", "suporte"],
    outsideAllowedLabels: "accept",
  } as unknown as AgentConfig;
}

describe.skipIf(!dbUp)("the allowed list reaches set_labels", () => {
  let tenantId = 0n;
  beforeAll(async () => {
    tenantId = (
      await (su as PrismaClient).tenant.create({
        data: { name: "Taxonomia", slug: `taxonomia-638-${process.pid}` },
      })
    ).id;
  });
  afterAll(async () => {
    await clearFlowLog(su as PrismaClient, { tenantId });
    await su?.tenant.delete({ where: { id: tenantId } });
    await su?.$disconnect();
    await app?.$disconnect();
  });

  // Review round 2: a responder turn passes no reporter of its own, and a write under `accept` was
  // counted nowhere. The toolset now writes it as its own `tool` line.
  test("a turn without its own reporter gets the write as a tool line", async () => {
    let seen: Record<string, unknown> | undefined;
    const turnId = `labels-638-${process.pid}`;
    await buildToolset(
      config(),
      {
        tenantId,
        instanceId: 1n,
        base: app as PrismaClient,
        client: {} as unknown as ChatwootClient,
        conversationId: 77,
        threadId: `t-${process.pid}`,
      },
      {
        flow: { tenantId, turnId, source: "inbox", base: app as PrismaClient },
        buildNativeTools: (native) => {
          seen = native as unknown as Record<string, unknown>;
          return [];
        },
      },
    );
    const report = seen?.onLabelsWritten as (w: unknown) => void;
    report({
      scope: "conversation",
      added: 2,
      removed: 0,
      after: 2,
      addedTitles: ["vip"],
      removedTitles: [],
      outsideAllowed: 1,
    });
    const rows = await flowLogRows(su as PrismaClient, {
      where: { tenantId, turnId },
    });
    expect(rows.map((r) => r.detail)).toEqual([
      {
        scope: "conversation",
        added: 2,
        removed: 0,
        after: 2,
        addedTitles: ["vip"],
        removedTitles: [],
        outsideAllowed: 1,
        tool: "set_labels",
        phase: "labels",
      },
    ]);
  });

  test("buildToolset hands the list and its mode to the native tools", async () => {
    let seen: Record<string, unknown> | undefined;
    const ctx: ToolsetCtx = {
      tenantId: 1n,
      instanceId: 1n,
      base: app as PrismaClient,
      client: {} as unknown as ChatwootClient,
      conversationId: 77,
      threadId: `t-${process.pid}`,
    };
    await buildToolset(config(), ctx, {
      buildNativeTools: (native) => {
        seen = native as unknown as Record<string, unknown>;
        return [];
      },
    });
    expect(seen?.allowedLabels).toEqual(["vip", "suporte"]);
    expect(seen?.outsideAllowedLabels).toBe("accept");
    expect(seen?.protectedLabels).toEqual(["agente-off"]);
  });
});
