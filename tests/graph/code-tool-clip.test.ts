import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { type AgentConfig, buildToolset } from "@/graph/prepare";
import { buildCodeTool, type CodeToolDeps } from "@/graph/tools/code";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import { CROSS_INBOX_CASE_DEFAULTS } from "@/modules/cross-inbox-case/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import { MODEL_RESPONSE_CHAR_LIMIT } from "@/modules/tool-definitions/response-template";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// A code tool that clips what it hands the model says so, the way an HTTP tool does: the same
// `response_clipped` side-effect line, which reaches alert channels at `warn`.

type Note = Parameters<NonNullable<CodeToolDeps["onSideEffectError"]>>[0];

function tool(code: string, notes: Note[]) {
  return buildCodeTool(
    { name: "relatorio", description: "d", inputSchema: {}, code },
    { onSideEffectError: (n) => notes.push(n) },
  );
}

const LIMIT = MODEL_RESPONSE_CHAR_LIMIT;

describe("a code tool that clips its output", () => {
  test("a returned value past the limit is reported, and the model text does not change", async () => {
    const notes: Note[] = [];
    const out = String(
      await tool(`return "x".repeat(${LIMIT + 500})`, notes).invoke({}),
    );
    // Rendered as JSON, so the string keeps its opening quote and loses its closing one.
    expect(out).toBe(`Result: "${"x".repeat(LIMIT - 1)}…[truncated]`);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      tool: "relatorio",
      phase: "response_clipped",
      // The value as rendered: JSON, so the string's two quotes count.
      detail: {
        kind: "code",
        limit: LIMIT,
        cut: ["value"],
        chars: LIMIT + 502,
      },
    });
  });

  test("an error message past the limit is reported", async () => {
    const notes: Note[] = [];
    await tool(`throw new Error("y".repeat(${LIMIT + 500}))`, notes)
      .invoke({})
      .catch(() => {});
    expect(notes.map((n) => n.detail)).toEqual([
      // The line number the sandbox appends to a message counts: it is what the model would read.
      {
        kind: "code",
        limit: LIMIT,
        cut: ["message"],
        chars: LIMIT + 500 + " (line 1)".length,
      },
    ]);
  });

  test("console output cut to the budget the result leaves is reported apart from the value", async () => {
    const notes: Note[] = [];
    const out = String(
      await tool(
        `console.log("z".repeat(${LIMIT - 10})); return "ok"`,
        notes,
      ).invoke({}),
    );
    expect(out).toContain("…[output truncated]");
    expect(notes.map((n) => n.detail)).toEqual([
      { kind: "code", limit: LIMIT, cut: ["output"] },
    ]);
  });

  test("console output dropped whole, with no marker in what the model reads, is reported too", async () => {
    const notes: Note[] = [];
    const out = String(
      await tool(
        `console.log("hello"); return "x".repeat(${LIMIT - 30})`,
        notes,
      ).invoke({}),
    );
    expect(out).not.toContain("hello");
    expect(out).not.toContain("Output:");
    expect(notes.map((n) => n.detail)).toEqual([
      { kind: "code", limit: LIMIT, cut: ["output_dropped"] },
    ]);
  });

  test("a value and its output both cut are one line naming both", async () => {
    const notes: Note[] = [];
    await tool(
      `console.log("hello"); return "x".repeat(${LIMIT + 10})`,
      notes,
    ).invoke({});
    expect(notes.map((n) => n.detail)).toEqual([
      {
        kind: "code",
        limit: LIMIT,
        cut: ["value", "output_dropped"],
        chars: LIMIT + 10 + 2,
      },
    ]);
  });

  test("a value exactly at the limit reaches the model whole and reports nothing", async () => {
    const notes: Note[] = [];
    // Two quotes plus LIMIT - 2 characters: the rendered value is exactly LIMIT long.
    const out = String(
      await tool(`return "x".repeat(${LIMIT - 2})`, notes).invoke({}),
    );
    expect(out).toBe(`Result: "${"x".repeat(LIMIT - 2)}"`);
    expect(notes).toEqual([]);
  });

  test("output within the limit reports nothing", async () => {
    const notes: Note[] = [];
    const out = String(
      await tool(`console.log("checking"); return { ok: true }`, notes).invoke(
        {},
      ),
    );
    expect(out).toBe('Output:\nchecking\n\nResult: {"ok":true}');
    expect(notes).toEqual([]);
  });
});

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
    crossInboxCaseConfig: CROSS_INBOX_CASE_DEFAULTS,
    chatwootContactId: null,
    httpToolContext: {},
    codeToolDefs: [
      {
        name: "relatorio",
        description: "d",
        inputSchema: {},
        code: `return "x".repeat(${LIMIT + 1})`,
      },
    ],
    httpToolDefs: [],
    integrationSelections: [],
    mcpSelections: [],
    nativeToolsAllow: [],
    ragConfig: undefined,
    timezone: "America/Sao_Paulo",
    toolGuidance: {},
    toolPreconditions: {},
    transferWithSummary: true,
    protectedLabels: [],
    allowedLabels: [],
    outsideAllowedLabels: "accept",
  } as unknown as AgentConfig;
}

describe.skipIf(!dbUp)("the turn's toolset", () => {
  let tenantId = 0n;
  beforeAll(async () => {
    tenantId = (
      await (su as PrismaClient).tenant.create({
        data: { name: "Corte", slug: `corte-1042-${process.pid}` },
      })
    ).id;
  });
  afterAll(async () => {
    await clearFlowLog(su as PrismaClient, { tenantId });
    await su?.tenant.delete({ where: { id: tenantId } });
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a code tool's clip lands on the flow log as a warn the alert channels hear", async () => {
    const turnId = `clip-1042-${process.pid}`;
    const tools = await buildToolset(
      config(),
      {
        tenantId,
        instanceId: 1n,
        base: app as PrismaClient,
        client: {} as unknown as ChatwootClient,
        conversationId: 0,
        threadId: `t-${process.pid}`,
      },
      {
        flow: { tenantId, turnId, source: "inbox", base: app as PrismaClient },
        buildNativeTools: () => [],
      },
    );
    const code = tools.find((t) => t.name === "relatorio");
    await code?.invoke({});
    const rows = await flowLogRows(su as PrismaClient, {
      where: { tenantId, turnId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stage: "tool",
      level: "warn",
      detail: {
        kind: "code",
        limit: LIMIT,
        cut: ["value"],
        chars: LIMIT + 3,
        tool: "relatorio",
        phase: "response_clipped",
      },
    });
  });
});
