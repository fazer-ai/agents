import { createHash } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type MirrorResult, mirrorChatwootEvent } from "./mirror";
import type { NormalizedChatwootEvent } from "./types";
import { trackConversationMirror } from "./unchanged-update";

// ONE MIRROR PER EVENT, NOT PER ROUTE. Chatwoot delivers an event once per bot route, so an inbox with
// an observer beside its responder gets every event twice. While one delivery of a payload runs the
// mirror, another delivery of the same payload waits for it and reads the conversation as it stands,
// which is what its own run, serialized right behind, would have returned. Full reasoning:
// docs/chatwoot.md, "Mirror sync".

// Only while the run is in flight. A delivery that arrives after the run finished is ordered after
// whatever committed since, so it runs its own mirror: reusing a finished run over rows that moved
// can skip a write the same payload now owes. The mirror writes the inbox and contact rows only on a
// change, so that second run adds no write to the rows every delivery of an inbox shares.

// "The same event" is the same normalized payload, the conversation's version included, under the
// same options, compared whole. In-process: across processes each runs its own mirror, correct for
// the same reason.

type MirrorOptions = Parameters<typeof mirrorChatwootEvent>[4];
type MirrorFn = typeof mirrorChatwootEvent;

const inFlight = new Map<string, Promise<MirrorResult>>();

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function mirrorEventKey(
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
  opts: MirrorOptions,
): string {
  const body = JSON.stringify(
    { tenantId, instanceId, n, opts: opts ?? {} },
    (_k, v) => (typeof v === "bigint" ? `${v}n` : v),
  );
  return createHash("sha256").update(body).digest("hex");
}

// A follower reports `applied: false` and no transition (`prevStatus` is the current status), so
// exactly one delivery of an event acts on a transition.
async function asFollower(
  tenantId: bigint,
  lead: MirrorResult,
  base: PrismaClient,
): Promise<MirrorResult> {
  if (lead.conversationRowId === null) return { ...lead, applied: false };
  const rowId = lead.conversationRowId;
  const current = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.findUnique({
      where: { id: rowId },
      select: {
        status: true,
        assigneeId: true,
        assigneeType: true,
        lastEventAt: true,
      },
    }),
  );
  if (current === null) return { ...lead, applied: false };
  return {
    conversationRowId: rowId,
    inboxRowId: lead.inboxRowId,
    prevAssigneeId: current.assigneeId,
    prevStatus: current.status,
    applied: false,
    status: current.status,
    assigneeId: current.assigneeId,
    assigneeType: current.assigneeType,
    lastEventAt: current.lastEventAt,
  };
}

// Every run, so the receipt drop knows what the row holds (./unchanged-update.ts): a run that held
// a write back, or threw, applied this snapshot partially or not at all.
async function tracked(
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
  run: () => Promise<MirrorResult>,
): Promise<MirrorResult> {
  const flight = trackConversationMirror(tenantId, instanceId, n);
  try {
    const result = await run();
    flight.done(result.heldBack !== true);
    return result;
  } catch (err) {
    flight.done(false);
    throw err;
  }
}

export async function mirrorOncePerEvent(
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
  base: PrismaClient = basePrisma,
  opts: MirrorOptions = {},
  mirror: MirrorFn = mirrorChatwootEvent,
): Promise<MirrorResult> {
  // NOTE: A payload without the conversation's `updated_at` (Chatwoot before 4.0.2) does not name
  // one version of the conversation: open, resolved and open again serialize alike, so two equal
  // payloads can be two transitions, and each runs.
  if (n.conversationUpdatedAt == null) {
    return tracked(tenantId, instanceId, n, () =>
      mirror(tenantId, instanceId, n, base, opts),
    );
  }
  const key = mirrorEventKey(tenantId, instanceId, n, opts);
  const running = inFlight.get(key);
  if (running) {
    // A leader that failed, or that held a write back, did not mirror the event whole, so this
    // delivery runs its own, as the new leader.
    const lead = await running.catch(() => null);
    if (lead !== null && !lead.heldBack) {
      return asFollower(tenantId, lead, base);
    }
    return mirrorOncePerEvent(tenantId, instanceId, n, base, opts, mirror);
  }
  const run = tracked(tenantId, instanceId, n, () =>
    mirror(tenantId, instanceId, n, base, opts),
  );
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}
