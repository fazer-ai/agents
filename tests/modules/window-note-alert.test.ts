import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { causeKeyOf } from "@/modules/flowlog/alerts";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";
import {
  emitWindowNote,
  windowNoteMessage,
} from "@/modules/service-window/note-alert";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { outboundUrl } from "../utils/outbound";

// A proactive send outside the 24h window that became a note for lack of a usable template: a warn
// line per note, and one alert per agent per day on the tenant's channels, counting the rest.

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

describe("the window note's alert key and sentence", () => {
  test("one key per agent, whatever the kind", () => {
    const ev = (detail: Record<string, unknown>) =>
      causeKeyOf({ stage: "service_window", level: "warn", detail });
    expect(ev({ agent: "7", kind: "followup", reason: "no_template" })).toBe(
      "service_window:7",
    );
    expect(
      ev({ agent: "7", kind: "inbound_event", reason: "blank_value" }),
    ).toBe("service_window:7");
    expect(ev({ agent: "x; drop", reason: "no_template" })).toBe(
      "service_window",
    );
  });

  test("the sentence names the kind and what to fix, and never the note", () => {
    expect(windowNoteMessage("appointment_reminder", "no_template")).toContain(
      "appointment_reminder",
    );
    expect(windowNoteMessage("followup", "no_template")).toContain(
      "no template is configured",
    );
    expect(windowNoteMessage("followup", "blank_value")).toContain("fallback");
  });
});

describe.skipIf(!dbUp)("window notes on the tenant's alert channels", () => {
  let tenantId = 0n;
  let agentA = 0n;
  let agentB = 0n;
  let channelId = 0n;
  let quietChannelId = 0n;

  const note = async (agentId: bigint) => {
    emitWindowNote(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        agentId,
        base: appDb,
      },
      { agentId, kind: "followup", reason: "no_template" },
    );
    await settleFlowEvents();
  };
  const alerts = (channel: bigint) =>
    suDb.alertDelivery.findMany({
      where: { channelId: channel },
      orderBy: { id: "asc" },
      select: { id: true, causeKey: true, count: true, level: true },
    });

  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "Janela", slug: `window-note-${process.pid}` },
      })
    ).id;
    const agent = (name: string) =>
      suDb.agent.create({
        data: {
          tenantId,
          name,
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
          settings: {},
        },
        select: { id: true },
      });
    agentA = (await agent("Lembretes")).id;
    agentB = (await agent("Vendas")).id;
    const channel = (name: string, excludeAgentIds: bigint[]) =>
      suDb.alertChannel.create({
        data: {
          tenantId,
          name,
          type: "discord",
          url: encryptJson(outboundUrl(`/api/webhooks/window-note-${name}`)),
          minLevel: "warn",
          stages: [],
          excludeAgentIds,
        },
      });
    channelId = (await channel("alertas", [])).id;
    quietChannelId = (await channel("sem-lembretes", [agentA])).id;
  });

  afterAll(async () => {
    if (!tenantId) return;
    await clearFlowLog(suDb, { tenantId });
    await suDb.alertDelivery.deleteMany({
      where: { channelId: { in: [channelId, quietChannelId] } },
    });
    await suDb.tenant.delete({ where: { id: tenantId } });
  });

  test("a run of notes is one alert per agent, counted, and every note keeps its warn line", async () => {
    await note(agentA);
    await note(agentA);
    await note(agentB);
    const lines = await flowLogRows(suDb, {
      // flowlog-scope: tenant-wide. The subject is HOW MANY lines the notes wrote, on this file's own
      // tenant, so a turn-scoped read would pass with one missing.
      where: { tenantId, stage: "service_window" },
      select: { level: true, agentId: true },
    });
    expect(lines.map((l) => l.level)).toEqual(["warn", "warn", "warn"]);
    expect(
      (await alerts(channelId)).map(({ causeKey, count, level }) => ({
        causeKey,
        count,
        level,
      })),
    ).toEqual([
      { causeKey: `service_window:${agentA}`, count: 2, level: "warn" },
      { causeKey: `service_window:${agentB}`, count: 1, level: "warn" },
    ]);
    // A channel that leaves the agent out gets nothing of it; the line is written all the same.
    expect((await alerts(quietChannelId)).map((a) => a.causeKey)).toEqual([
      `service_window:${agentB}`,
    ]);
  });

  test("the alert lasts a day, not the three hours of other causes", async () => {
    const [first] = await alerts(channelId);
    const at = (hoursAgo: number) =>
      suDb.alertDelivery.update({
        where: { id: first?.id },
        data: { createdAt: new Date(Date.now() - hoursAgo * 3_600_000) },
      });
    await at(5);
    await note(agentA);
    expect((await alerts(channelId))[0]?.count).toBe(3);
    await at(25);
    await note(agentA);
    expect(
      (await alerts(channelId)).filter(
        (a) => a.causeKey === `service_window:${agentA}`,
      ),
    ).toHaveLength(2);
  });
});
