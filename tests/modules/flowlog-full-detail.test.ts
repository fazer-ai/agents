import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Serialized } from "@langchain/core/load/serializable";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { ToolFlowLogger } from "@/graph/tool-flowlog";
import { MAX_STRING } from "@/lib/redact";
import type { TenantContext } from "@/lib/tenancy";
import { assertSettingsClosedValues } from "@/modules/agents/service";
import {
  getConversationDetail,
  getConversationToolResult,
} from "@/modules/conversations/service";
import {
  FULL_DETAIL_MAX_CHARS,
  fullDetailExpiry,
  KEPT_UNTIL_KEY,
  readAgentFullDetailUsage,
} from "@/modules/flowlog/full-detail";
import {
  forgetSweepBatchSizesForTest,
  sweepFlowlog,
} from "@/modules/flowlog/retention";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";
import { type FlowContext, withFlowStage } from "@/modules/flowlog/service";
import { readObservabilityConfig } from "@/modules/flowlog/settings";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// An agent that keeps its full turn detail for N days lets an operator read, days later,
// the whole tool result the model received, where the log line keeps only its first 2,000
// characters. Asked at the effect: a tool call goes through the real logger and the real write, and
// the answer is read back through the conversation page's own reader and the retention sweep.

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

// A result past the cut, with a marker at the start, one far past the cut and one at the end, so a
// reader that returns the cut copy, or a prefix of the whole one, is told apart from the whole text.
function bigResult(tag: string, chars = 19_000): string {
  const head = `INICIO-${tag} `;
  const mid = ` MEIO-${tag} `;
  const tail = ` FIM-${tag}`;
  const filler = "lote 2 esgotado, setor pista disponível. ";
  let body = head;
  while (body.length < 15_000) body += filler;
  body += mid;
  while (body.length < chars - tail.length) body += filler;
  return (body.slice(0, chars - tail.length) + tail).slice(0, chars);
}

let tenantId = 0n;
let convId = 0n;
let agentA = 0n;
let agentB = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

function flow(agentId: bigint, days: number | null): FlowContext {
  return {
    tenantId,
    turnId: crypto.randomUUID(),
    source: "inbox",
    conversationId: convId,
    agentId,
    base: appDb,
    fullDetailRetentionDays: days,
  };
}

let run = 0;
async function toolCall(
  f: FlowContext,
  result: unknown,
  opts: { logValues: boolean; args?: string } = { logValues: true },
): Promise<void> {
  const logger = new ToolFlowLogger(f, { logValues: opts.logValues });
  const runId = `run-${++run}`;
  logger.handleToolStart(
    {} as Serialized,
    opts.args ?? '{"evento":"show"}',
    runId,
    undefined,
    undefined,
    undefined,
    "consultar_evento",
  );
  logger.handleToolEnd({ content: result }, runId);
  await settleFlowEvents();
}

// The tool entries of the conversation's trail, each with the whole result its own route serves
// (the trail carries only the length, so the page fetches the text when it is asked for).
async function toolTrail() {
  const d = await getConversationDetail(ctx(), convId, appDb);
  const tools = d.trail.filter((e) => e.kind === "tool");
  return Promise.all(
    tools.map(async (e) => {
      const r = await getConversationToolResult(
        ctx(),
        convId,
        BigInt(e.id),
        appDb,
      );
      expect<string | null>(r.status).toBe(e.fullOutputStatus);
      expect(e.fullOutputChars).toBe(r.text === null ? null : r.text.length);
      return { ...e, fullOutput: r.text };
    }),
  );
}

async function count(table: "full_detail_refs" | "full_detail_contents") {
  const r = await suDb.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = ${tenantId}`,
  );
  return r[0]?.n ?? -1;
}

describe.skipIf(!dbUp)("full turn detail kept per agent", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "FULL1761", slug: `full1761-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      adminToken: "enc",
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootInboxId: 10,
        name: "Support",
      },
    });
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: inst.id,
        tenantId,
        chatwootContactId: 5,
        name: "Alice",
      },
    });
    convId = (
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: inst.id,
          chatwootConversationId: 100,
          inboxId: inbox.id,
          contactId: contact.id,
          status: "pending",
          assigneeType: "AgentBot",
          threadId: `${tenantId}:${inst.id}:100`,
          lastEventAt: new Date(),
        },
      })
    ).id;
    const mk = async (name: string, days: number | null) =>
      (
        await suDb.agent.create({
          data: {
            tenantId,
            name,
            systemPrompt: "x",
            modelConfig: { provider: "openai", model: "gpt-4o-mini" },
            settings: {
              observability: {
                logToolValues: true,
                fullDetailRetentionDays: days,
              },
            },
          },
        })
      ).id;
    agentA = await mk("A", 3);
    agentB = await mk("B", 10);
  });

  beforeEach(async () => {
    await clearFlowLog(suDb, { tenantId });
    await suDb.$executeRaw`DELETE FROM full_detail_refs WHERE tenant_id = ${tenantId}`;
    await suDb.$executeRaw`DELETE FROM full_detail_contents WHERE tenant_id = ${tenantId}`;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      await suDb.$executeRaw`DELETE FROM full_detail_refs WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM full_detail_contents WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM conversations WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM contacts WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM inboxes WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM agents WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM chatwoot_instances WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a kept result is served whole by the conversation's trail, and the log line stays cut", async () => {
    const text = bigResult("A");
    await toolCall(flow(agentA, 7), text);

    const [entry] = await toolTrail();
    expect(entry?.fullOutputStatus).toBe("kept");
    expect(entry?.outputComplete).toBe(false);
    expect(entry?.fullOutput).toBe(text);
    expect(entry?.fullOutputCut).toBe(false);
    // The summary row the Logs page lists is unchanged by the setting.
    // flowlog-scope: tenant-wide — each case starts from an emptied tenant and writes one tool line.
    const [line] = await flowLogRows(suDb, {
      orderBy: { id: "asc" },
      where: { tenantId, stage: "tool" },
      select: { detail: true },
    });
    const detail = line?.detail as Record<string, unknown>;
    const output = String(detail.output);
    expect(output.length).toBeLessThanOrEqual(MAX_STRING + 20);
    expect(output).toContain("INICIO-A");
    expect(output).not.toContain("FIM-A");
    expect(typeof detail[KEPT_UNTIL_KEY]).toBe("string");
  });

  test("the trail carries no kept text, and one call's result is not served under another conversation", async () => {
    await toolCall(flow(agentA, 7), bigResult("T"));
    const d = await getConversationDetail(ctx(), convId, appDb);
    expect(JSON.stringify(d.trail)).not.toContain("FIM-T");
    const [entry] = d.trail.filter((e) => e.kind === "tool");
    await expect(
      getConversationToolResult(
        ctx(),
        convId + 999_999n,
        BigInt(entry?.id ?? "0"),
        appDb,
      ),
    ).rejects.toThrow();
  });

  test("a structured result keeps its credential-named keys masked in the kept copy", async () => {
    // Assembled here so the file carries no credential-shaped literal of its own.
    const secret = ["senha", "comum", "123"].join("-");
    const value = { lote: "x".repeat(3_000), ["pass" + "word"]: secret };
    await toolCall(flow(agentA, 7), value);
    const [entry] = await toolTrail();
    expect(entry?.fullOutput).toContain("x".repeat(3_000));
    expect(entry?.fullOutput).not.toContain(secret);
  });

  test("a token behind a tab inside a structured result is masked before it is serialized", async () => {
    // JSON escapes the tab, and an escaped separator no longer matches the header pattern.
    const token = "Q".repeat(32);
    const value = { lote: "x".repeat(3_000), nota: `Bearer\t${token}` };
    await toolCall(flow(agentA, 7), value);
    const [entry] = await toolTrail();
    expect(entry?.fullOutput).toContain("x".repeat(3_000));
    expect(entry?.fullOutput).not.toContain(token);
  });

  test("a token in its own text block is masked before the blocks are joined", async () => {
    // Joined, the block before glues its last word to the token and the boundary the pattern needs is
    // gone. Assembled here so the file carries no key-shaped literal of its own.
    const token = ["sk", "proj", "B".repeat(24)].join("-");
    const blocks = [
      { type: "text", text: `${"lote ".repeat(600)}prefixo` },
      { type: "text", text: token },
    ];
    await toolCall(flow(agentA, 7), blocks);
    const [entry] = await toolTrail();
    expect(entry?.fullOutput).toContain("prefixo");
    expect(entry?.fullOutput).not.toContain(token);
  });

  test("a result with an image block keeps the block instead of an empty text that reads as whole", async () => {
    const blocks = [
      { type: "text", text: "foto do mapa de assentos" },
      { type: "image", data: "iVBOR".repeat(1_000), mimeType: "image/png" },
    ];
    await toolCall(flow(agentA, 7), blocks);
    const [entry] = await toolTrail();
    expect(entry?.outputComplete).toBe(false);
    expect(entry?.fullOutput).toContain("iVBOR".repeat(1_000));
    expect(entry?.fullOutput).toContain("foto do mapa de assentos");
  });

  test("an output logged before the write-time flag is read as cut by its shape", async () => {
    // Lines written before `outputCut` existed: fifty content blocks (the log's list cap) and a
    // block whose text carries the cut marker are cut; three short blocks are whole.
    const block = (text: string) => ({ type: "text", text });
    const legacy = async (
      output: Prisma.InputJsonValue,
      extra: Record<string, Prisma.InputJsonValue> = {},
    ) =>
      suDb.executionLog.create({
        data: {
          tenantId,
          turnId: crypto.randomUUID(),
          conversationId: convId,
          agentId: agentA,
          stage: "tool",
          level: "info",
          status: "ok",
          source: "inbox",
          detail: { tool: "mcp__loja__estoque", output, ...extra },
        },
      });
    await legacy(Array.from({ length: 50 }, (_, i) => block(`b${i}`)));
    await legacy([block("a"), block("lote…[truncated]")]);
    await legacy([block("a"), block("b"), block("c")]);
    // A string the tool cut itself (an HTTP tool's `resultMaxChars`) is as long as its result; one the
    // log cut is shorter than the result it came from.
    const own = "lote 2 esgotado…[truncated]";
    await legacy(own, { resultSize: { chars: own.length } });
    const logCut = `${"a".repeat(2_000)}…[truncated]`;
    await legacy(logCut, { resultSize: { chars: 9_000 } });
    const entries = await toolTrail();
    expect(entries.map((e) => e.outputComplete)).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
  });

  test("a short result that ends in the log's own marker is whole, and long arguments do not make it cut", async () => {
    // A tool that cut its own response (an HTTP tool's `resultMaxChars`) hands the model exactly this.
    const text = "lote 2 esgotado…[truncated]";
    await toolCall(flow(agentA, 7), text, {
      logValues: true,
      args: JSON.stringify({ evento: "x".repeat(5_000) }),
    });
    const [entry] = await toolTrail();
    expect(entry?.output).toBe(text);
    expect(entry?.outputComplete).toBe(true);
  });

  test("a result cut right before an emoji still reads as cut", async () => {
    // The overflow probe must not end inside the surrogate pair, or the cut copy reads as whole.
    const text = `${"a".repeat(MAX_STRING)}😀 resto do resultado`;
    await toolCall(flow(agentA, 7), text);
    const [entry] = await toolTrail();
    expect(entry?.outputComplete).toBe(false);
    expect(entry?.fullOutput).toBe(text);
  });

  test("a result made of many content blocks, cut block by block, is offered whole", async () => {
    // The shape an MCP tool returns: a list of text blocks, each short. The log keeps the first fifty.
    const blocks = Array.from({ length: 60 }, (_, i) => ({
      type: "text",
      text: `bloco-${i} setor pista disponível`,
    }));
    await toolCall(flow(agentA, 7), blocks);
    const [entry] = await toolTrail();
    expect(entry?.outputComplete).toBe(false);
    expect(entry?.fullOutputStatus).toBe("kept");
    expect(entry?.fullOutput).toContain("bloco-59");
    expect(entry?.output).not.toContain("bloco-59");
  });

  test("a result past the kept-text ceiling says the kept copy is not the whole either", async () => {
    const text = bigResult("C", FULL_DETAIL_MAX_CHARS + 50_000);
    await toolCall(flow(agentA, 7), text);
    const [entry] = await toolTrail();
    expect(entry?.fullOutputStatus).toBe("kept");
    expect(entry?.fullOutputCut).toBe(true);
    expect(entry?.fullOutput).toContain("INICIO-C");
    expect(entry?.fullOutput).not.toContain("FIM-C");
  });

  test("an agent that keeps nothing writes nothing, and the trail says the cut copy is not the whole", async () => {
    await toolCall(flow(agentA, null), bigResult("N"));
    expect(await count("full_detail_refs")).toBe(0);
    expect(await count("full_detail_contents")).toBe(0);
    const [entry] = await toolTrail();
    expect(entry?.fullOutput).toBeNull();
    expect(entry?.outputComplete).toBe(false);
    expect(entry?.fullOutputStatus).toBe("not_kept");
  });

  test("with tool values off the size axis keeps no text at all", async () => {
    await toolCall(flow(agentA, 7), bigResult("V"), { logValues: false });
    expect(await count("full_detail_contents")).toBe(0);
    const [entry] = await toolTrail();
    expect(entry?.fullOutput).toBeNull();
    expect(entry?.output ?? "").not.toContain("INICIO-V");
  });

  test("the same result fetched twice is stored once and served to both calls", async () => {
    const text = bigResult("D");
    const f = flow(agentB, 10);
    await toolCall(f, text);
    await toolCall(f, text);
    expect(await count("full_detail_contents")).toBe(1);
    expect(await count("full_detail_refs")).toBe(2);
    const entries = await toolTrail();
    expect(entries.map((e) => e.fullOutput === text)).toEqual([true, true]);
  });

  test("a secret inside a kept result is redacted like on every log line", async () => {
    // Assembled here so the file carries no key-shaped literal of its own.
    const token = ["sk", "proj", "A".repeat(24)].join("-");
    const text = `${"a".repeat(8_000)} ${token} ${"b".repeat(2_000)}`;
    await toolCall(flow(agentA, 7), text);
    const [entry] = await toolTrail();
    expect(entry?.fullOutput).not.toContain(token);
    expect(entry?.fullOutput).toContain("b".repeat(2_000));
  });

  test("the audited system prompt of a turn is kept whole beside its cut copy", async () => {
    const prompt = `${"regra. ".repeat(900)}FIM_DO_PROMPT_1761`;
    await withFlowStage(
      flow(agentA, 7),
      "generate",
      {
        detail: { systemPrompt: prompt },
        full: { kind: "system_prompt", text: prompt },
      },
      async () => "ok",
    );
    await settleFlowEvents();
    const rows = await suDb.$queryRaw<{ kind: string; body: string }[]>`
      SELECT r.kind, c.body FROM full_detail_refs r
        JOIN full_detail_contents c ON c.tenant_id = r.tenant_id AND c.hash = r.content_hash
       WHERE r.tenant_id = ${tenantId}`;
    expect(rows).toEqual([{ kind: "system_prompt", body: prompt }]);
  });

  test("the sweep deletes by each agent's own days, not by FLOWLOG_RETENTION_DAYS, and an expired result reads as gone", async () => {
    const shared = bigResult("S");
    // Two lines written five days ago (A keeps 3 days, B keeps 10) and one written now by B, which
    // shares A's text: the text must outlive A's pointer.
    await toolCall(flow(agentA, 3), shared);
    await toolCall(flow(agentA, 3), bigResult("A5"));
    await toolCall(flow(agentB, 10), bigResult("B5"));
    await suDb.$executeRaw`
      UPDATE full_detail_refs SET expires_at = expires_at - interval '5 days',
                                  created_at = created_at - interval '5 days'
       WHERE tenant_id = ${tenantId}`;
    await suDb.$executeRaw`
      UPDATE full_detail_contents SET expires_at = expires_at - interval '5 days',
                                      created_at = created_at - interval '5 days'
       WHERE tenant_id = ${tenantId}`;
    await toolCall(flow(agentB, 10), shared);
    const linesBefore = (
      await flowLogRows(suDb, {
        // flowlog-scope: tenant-wide — the sweep must leave EVERY line of the tenant in place.
        orderBy: { id: "asc" },
        where: { tenantId },
        select: { id: true },
      })
    ).length;

    forgetSweepBatchSizesForTest();
    for (let i = 0; i < 20; i++) {
      if ((await sweepFlowlog(appDb, tenantId, { pauseMs: 0 })).done) break;
    }

    // A's pointers are gone and so is the text only A had; B's old and new pointers stay, and the
    // text A shared with B stays for B.
    expect(await count("full_detail_refs")).toBe(2);
    expect(await count("full_detail_contents")).toBe(2);
    const entries = await toolTrail();
    expect(entries.map((e) => e.fullOutputStatus)).toEqual([
      "gone",
      "gone",
      "kept",
      "kept",
    ]);
    expect(entries[0]?.fullOutput).toBeNull();
    expect(entries[3]?.fullOutput).toBe(shared);
    // The log lines themselves are governed by FLOWLOG_RETENTION_DAYS and untouched.
    const linesAfter = (
      await flowLogRows(suDb, {
        // flowlog-scope: tenant-wide — the sweep must leave EVERY line of the tenant in place.
        orderBy: { id: "asc" },
        where: { tenantId },
        select: { id: true },
      })
    ).length;
    expect(linesAfter).toBe(linesBefore);
  });

  test("a kept result past its expiry reads as gone before the sweep has run", async () => {
    await toolCall(flow(agentA, 3), bigResult("E"));
    await suDb.$executeRaw`
      UPDATE full_detail_refs SET expires_at = now() - interval '1 minute'
       WHERE tenant_id = ${tenantId}`;
    const [entry] = await toolTrail();
    expect(entry?.fullOutputStatus).toBe("gone");
    expect(entry?.fullOutput).toBeNull();
  });

  test("the usage read counts the agent's kept lines and their distinct bytes, and refuses an unknown id", async () => {
    const text = bigResult("U");
    await toolCall(flow(agentB, 10), text);
    await toolCall(flow(agentB, 10), text);
    const usage = await readAgentFullDetailUsage(ctx(), agentB, appDb);
    expect(usage.retentionDays).toBe(10);
    expect(usage.lines).toBe(2);
    expect(usage.bytes).toBeGreaterThan(0);
    // One text, measured once: well under twice its raw size.
    expect(usage.bytes).toBeLessThan(text.length * 2);
    await expect(
      readAgentFullDetailUsage(ctx(), 999_999_999n, appDb),
    ).rejects.toThrow("agent not found");
  });
});

describe("observability.fullDetailRetentionDays, the setting", () => {
  test("off unless a whole number of days inside the range", () => {
    const read = (v: unknown) =>
      readObservabilityConfig({ observability: { fullDetailRetentionDays: v } })
        .fullDetailRetentionDays;
    expect(readObservabilityConfig({}).fullDetailRetentionDays).toBeNull();
    expect(read(7)).toBe(7);
    expect(read(90)).toBe(90);
    for (const bad of [0, -5, 91, 1.5, "7", "trinta", null]) {
      expect(read(bad)).toBeNull();
    }
  });

  test("the write boundary refuses a value outside the range or not a number", () => {
    const write = (v: unknown) => () =>
      assertSettingsClosedValues(
        { observability: { fullDetailRetentionDays: v } },
        { observability: { fullDetailRetentionDays: 7 } },
      );
    expect(write(-5)).toThrow();
    expect(write("trinta")).toThrow();
    expect(write(91)).toThrow();
    expect(write(14)).not.toThrow();
    expect(write(null)).not.toThrow();
  });
});

describe("when a kept line expires", () => {
  test("the agent's days, never past the log line's own retention", () => {
    const now = new Date("2026-11-14T10:20:00Z");
    const day = 86_400_000;
    const short = fullDetailExpiry(3, now).getTime() - now.getTime();
    expect(short).toBeGreaterThanOrEqual(3 * day);
    expect(short).toBeLessThan(3 * day + 3_600_000);
    const long = fullDetailExpiry(config.flowlog.retentionDays + 30, now);
    expect(long.getTime() - now.getTime()).toBeLessThan(
      (config.flowlog.retentionDays + 1) * day,
    );
  });
});
