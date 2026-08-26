import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  preconditionFlowEvent,
  unmatchedPreconditionEvent,
} from "@/graph/tools/precondition";
import type { ToolPrecondition } from "@/modules/agents/tool-preconditions";
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

  // NOTE: Built by the PRODUCTION constructor, not written out here. A hand-written literal would keep
  // passing after the mapping it is supposed to measure was changed — the level is exactly the field
  // under test, so a second copy of it is the one thing this file must not contain.
  const cond: ToolPrecondition = {
    kind: "attribute",
    scope: "conversation",
    key: "article_url",
  };
  const tool = "handoff_to_human";

  test("an unmet condition writes its log line and pages nobody", async () => {
    const before = await suDb.alertDelivery.count({ where: { tenantId } });
    // The turn is captured rather than generated inside the call: this file's other tests write
    // `tool`-stage lines of their own, so a count fenced only by the tenant would answer with
    // whichever of them happened to run first (tests/modules/flowlog-reader-scope.test.ts).
    const ctx = flow();
    const { delivered } = await writeFlowEvent(
      ctx,
      preconditionFlowEvent({ tool, cond, reason: "unmet" }),
    );
    expect(delivered).toBe(true);

    const logs = await suDb.executionLog.count({
      where: { tenantId, stage: "tool", turnId: ctx.turnId },
    });
    expect(logs).toBe(1);
    expect(await suDb.alertDelivery.count({ where: { tenantId } })).toBe(
      before,
    );
  });

  // Round 5 of PR #378: this refusal used to be indistinguishable from the one above. A pool timeout
  // refuses EVERY guarded call for as long as it lasts, and the only trace was an `info`/`ok` line
  // saying the rule had fired — an agent whose tools all went quiet, with nothing to alert on.
  //
  // It doubles as the positive control the previous test needs: without a line that DOES page,
  // "no alert" passes just as well against a channel that never matches, a stage allowlist that
  // excludes `tool`, or a dispatcher that is not wired at all.
  test("a state read that FAILED does page, and that is what makes the check above non-vacuous", async () => {
    const before = await suDb.alertDelivery.count({ where: { tenantId } });
    await writeFlowEvent(
      flow(),
      preconditionFlowEvent({
        tool,
        cond,
        reason: "unreadable",
        err: new Error("connection terminated"),
      }),
    );
    expect(await suDb.alertDelivery.count({ where: { tenantId } })).toBe(
      before + 1,
    );
  });

  test("a rule matching no tool is reported without paging: it is config, not an incident", async () => {
    const before = await suDb.alertDelivery.count({ where: { tenantId } });
    const { delivered } = await writeFlowEvent(
      flow(),
      unmatchedPreconditionEvent([tool]),
    );
    expect(delivered).toBe(true);
    expect(await suDb.alertDelivery.count({ where: { tenantId } })).toBe(
      before,
    );
  });
});
