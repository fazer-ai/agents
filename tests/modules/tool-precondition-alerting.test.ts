import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { FlowContext } from "@/modules/flowlog/service";
import { writeFlowEvent } from "@/modules/flowlog/service";

// PR #378 states, in its body and in the seam's own header, that a precondition refusing a call does
// NOT page an alert channel — the rule doing its job is the system working, not an incident. That
// sentence had no number behind it, and reading the CHANNEL's minLevel gate alone
// (`LEVEL_RANK[ch.minLevel] > rank`) suggests the opposite: `info` ranks 0, so a channel at minLevel
// `info` would pass it. The gate that actually decides is one level up, at the EMITTER
// (`level === "warn" || level === "error"`), so an info event never reaches the dispatcher at all.
//
// Measured here against a real database, with a channel deliberately configured BELOW what the
// console can produce (it offers warn|error, default error) — the strongest case, and one the MCP
// schema (`z.enum(FLOW_LEVELS)`) can actually create.
const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;

describe.skipIf(!dbUp)("a precondition refusal does not page anyone", () => {
  let tenantId = 0n;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "PRECOND-ALERT", slug: `precond-alert-${process.pid}` },
    });
    tenantId = t.id;
    await suDb.alertChannel.create({
      data: {
        tenantId,
        name: "everything",
        type: "webhook",
        url: encryptJson("https://203.0.113.77:9/hook"),
        enabled: true,
        // BELOW the console's own floor on purpose: if anything could receive an info line, this
        // channel would.
        minLevel: "info",
        stages: [],
      },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await su?.$disconnect();
  });

  const flow = (): FlowContext => ({
    tenantId,
    turnId: crypto.randomUUID(),
    // `inbox`, not `playground`: real traffic is the only source that pages at all, so measuring on
    // playground would prove nothing about the claim.
    source: "inbox",
    base: suDb,
  });

  const refusalEvent = {
    stage: "tool" as const,
    level: "info" as const,
    status: "ok" as const,
    detail: {
      tool: "handoff_to_human",
      phase: "precondition",
      preconditionKind: "attribute",
      preconditionKey: "article_url",
      preconditionScope: "conversation",
    },
  };

  test("the refusal writes its log line and no alert delivery", async () => {
    const before = await suDb.alertDelivery.count({ where: { tenantId } });
    const { delivered } = await writeFlowEvent(flow(), refusalEvent);
    expect(delivered).toBe(true);

    const logs = await suDb.executionLog.count({
      where: { tenantId, stage: "tool" },
    });
    expect(logs).toBe(1);
    expect(await suDb.alertDelivery.count({ where: { tenantId } })).toBe(
      before,
    );
  });

  test("positive control: the SAME line at warn does page, so the check is not vacuous", async () => {
    // Without this, a test asserting "no alert" passes just as well against a channel that never
    // matches, a stage allowlist that excludes `tool`, or a dispatcher that is not wired at all.
    const before = await suDb.alertDelivery.count({ where: { tenantId } });
    await writeFlowEvent(flow(), { ...refusalEvent, level: "warn" });
    expect(await suDb.alertDelivery.count({ where: { tenantId } })).toBe(
      before + 1,
    );
  });
});
