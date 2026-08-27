import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { dispatchAlertsForEvent } from "@/modules/flowlog/alerts";
import {
  createAlertChannel,
  deleteAlertChannel,
  listAlertChannels,
  updateAlertChannel,
} from "@/modules/flowlog/channels";
import { listExecutionLogs } from "@/modules/flowlog/read";
import type { FlowContext } from "@/modules/flowlog/service";
import { withFlowStage } from "@/modules/flowlog/service";
import { flowLogRow } from "../utils/flowlog";
import { outboundUrl } from "../utils/outbound";

// withFlowStage control flow is pure when no flow context is wired (zero overhead, just runs fn).
describe("withFlowStage (no context)", () => {
  test("returns the fn result", async () => {
    expect(await withFlowStage(undefined, "generate", {}, async () => 42)).toBe(
      42,
    );
  });
  test("rethrows the fn error", async () => {
    await expect(
      withFlowStage(undefined, "generate", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

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

let tenantA = 0n;
let tenantB = 0n;
function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}
function flow(t: bigint): FlowContext {
  return { tenantId: t, turnId: "t1", source: "inbox", base: appDb };
}

describe.skipIf(!dbUp)("flowlog", () => {
  beforeAll(async () => {
    tenantA = (
      await suDb.tenant.create({
        data: { name: "FlowA", slug: `flow-a-${process.pid}` },
      })
    ).id;
    tenantB = (
      await suDb.tenant.create({
        data: { name: "FlowB", slug: `flow-b-${process.pid}` },
      })
    ).id;
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      for (const tbl of [
        "alert_deliveries",
        "alert_channels",
        "execution_logs",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("createAlertChannel encrypts the URL and never returns it in the clear", async () => {
    const dto = await createAlertChannel(
      ctx(tenantA),
      {
        name: "Ops",
        type: "discord",
        url: outboundUrl("/api/webhooks/123/secret-token"),
      },
      appDb,
    );
    expect(dto.urlMasked).toContain("203.0.113");
    expect(dto.urlMasked).not.toContain("secret-token");
    // Stored value is an encrypted blob, not the URL.
    const raw = await suDb.alertChannel.findUnique({
      where: { id: BigInt(dto.id) },
      select: { url: true },
    });
    expect(raw?.url).not.toContain("203.0.113");
    expect(decryptJson<string>(raw?.url ?? "")).toBe(
      outboundUrl("/api/webhooks/123/secret-token"),
    );
  });

  test("update + delete + RLS isolation for channels", async () => {
    const a = await createAlertChannel(
      ctx(tenantA),
      { name: "A", type: "webhook", url: outboundUrl("/hook") },
      appDb,
    );
    // Tenant B cannot see or update tenant A's channel (RLS → NotFound).
    expect(
      (await listAlertChannels(ctx(tenantB), appDb)).map((c) => c.id),
    ).not.toContain(a.id);
    await expect(
      updateAlertChannel(ctx(tenantB), BigInt(a.id), { enabled: false }, appDb),
    ).rejects.toThrow();
    const updated = await updateAlertChannel(
      ctx(tenantA),
      BigInt(a.id),
      { minLevel: "warn", stages: ["stt", "generate"] },
      appDb,
    );
    expect(updated.minLevel).toBe("warn");
    expect(updated.stages.sort()).toEqual(["generate", "stt"]);
    await deleteAlertChannel(ctx(tenantA), BigInt(a.id), appDb);
    expect(
      (await listAlertChannels(ctx(tenantA), appDb)).map((c) => c.id),
    ).not.toContain(a.id);
  });

  test("dispatchAlertsForEvent matches by minLevel + stages and coalesces a burst", async () => {
    const all = await createAlertChannel(
      ctx(tenantA),
      {
        name: "all",
        type: "discord",
        url: outboundUrl("/api/webhooks/x"),
      },
      appDb,
    );
    const sttOnly = await createAlertChannel(
      ctx(tenantA),
      {
        name: "stt",
        type: "discord",
        url: outboundUrl("/api/webhooks/y"),
        stages: ["stt"],
      },
      appDb,
    );
    const ev = {
      stage: "generate" as const,
      level: "error" as const,
      errorMessage: "model exploded",
    };
    await dispatchAlertsForEvent(flow(tenantA), ev, appDb);
    // 'all' matches (no stage filter); 'sttOnly' does not (stage generate ∉ [stt]).
    const after1 = await suDb.alertDelivery.findMany({
      where: { tenantId: tenantA, channelId: BigInt(all.id) },
    });
    expect(after1).toHaveLength(1);
    expect(after1[0]?.count).toBe(1);
    expect(
      await suDb.alertDelivery.count({
        where: { tenantId: tenantA, channelId: BigInt(sttOnly.id) },
      }),
    ).toBe(0);
    // A second identical event coalesces into the same pending row (count++ not a new row).
    await dispatchAlertsForEvent(flow(tenantA), ev, appDb);
    const after2 = await suDb.alertDelivery.findMany({
      where: { tenantId: tenantA, channelId: BigInt(all.id) },
    });
    expect(after2).toHaveLength(1);
    expect(after2[0]?.count).toBe(2);
  });

  test("listExecutionLogs: source default, filters and keyset pagination", async () => {
    await suDb.executionLog.createMany({
      data: [
        {
          tenantId: tenantA,
          turnId: "r1",
          stage: "generate",
          level: "info",
          source: "inbox",
        },
        {
          tenantId: tenantA,
          turnId: "r1",
          stage: "tts",
          level: "error",
          source: "inbox",
          errorMessage: "tts failed",
        },
        {
          tenantId: tenantA,
          turnId: "p1",
          stage: "generate",
          level: "info",
          source: "playground",
        },
      ],
    });
    // Default source = inbox → playground excluded.
    const inbox = await listExecutionLogs(ctx(tenantA), {}, appDb);
    expect(inbox.items.every((i) => i.source === "inbox")).toBe(true);
    expect(inbox.items.some((i) => i.turnId === "p1")).toBe(false);
    // Playground segment is reachable explicitly.
    const pg = await listExecutionLogs(
      ctx(tenantA),
      { source: "playground" },
      appDb,
    );
    expect(pg.items.some((i) => i.turnId === "p1")).toBe(true);
    // Level filter.
    const errs = await listExecutionLogs(
      ctx(tenantA),
      { level: "error" },
      appDb,
    );
    expect(errs.items.every((i) => i.level === "error")).toBe(true);
    // Keyset: limit 1 → a cursor, and the next page does not overlap.
    const page1 = await listExecutionLogs(ctx(tenantA), { limit: 1 }, appDb);
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listExecutionLogs(
      ctx(tenantA),
      { limit: 1, cursor: BigInt(page1.nextCursor as string) },
      appDb,
    );
    expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
  });

  test("withFlowStage errorLevel downgrades the throw line to warn (status stays error)", async () => {
    const f: FlowContext = {
      tenantId: tenantA,
      turnId: "b8-warn",
      source: "inbox",
      base: appDb,
    };
    await expect(
      withFlowStage(f, "tts", { errorLevel: "warn" }, async () => {
        throw new Error("synth boom");
      }),
    ).rejects.toThrow("synth boom");
    // emit is fire-and-forget → poll until the row lands.
    let row: { level: string; status: string | null } | null = null;
    for (let i = 0; i < 100 && !row; i++) {
      row = await flowLogRow(suDb, {
        where: { tenantId: tenantA, turnId: "b8-warn", stage: "tts" },
        select: { level: true, status: true },
      });
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    expect(row).not.toBeNull();
    // Severity downgraded to warn, but the stage still records that it FAILED.
    expect(row?.level).toBe("warn");
    expect(row?.status).toBe("error");
  });

  test("RLS: tenant A cannot read tenant B's execution logs", async () => {
    await suDb.executionLog.create({
      data: {
        tenantId: tenantB,
        turnId: "b1",
        stage: "generate",
        level: "info",
        source: "inbox",
      },
    });
    const a = await listExecutionLogs(ctx(tenantA), { source: "all" }, appDb);
    expect(a.items.some((i) => i.turnId === "b1")).toBe(false);
    const b = await listExecutionLogs(ctx(tenantB), { source: "all" }, appDb);
    expect(b.items.some((i) => i.turnId === "b1")).toBe(true);
  });
});
