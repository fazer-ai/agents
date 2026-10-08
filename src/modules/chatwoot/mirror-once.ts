import { createHash } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  type MirrorResult,
  mirrorChatwootEvent,
  mirrorRowVersions,
} from "./mirror";
import type { NormalizedChatwootEvent } from "./types";

// ONE MIRROR PER EVENT, NOT PER ROUTE. Chatwoot delivers an event once per bot route, so an inbox with
// an observer beside its responder gets every event twice. The first delivery of a payload runs the
// mirror; another delivery of the same payload takes its rows and reads the conversation as it
// stands, which is what a second run would return from a conversation the first one already moved.
// Full reasoning: docs/chatwoot.md, "Mirror sync".

// "The same event" is the same normalized payload under the same options, compared whole: a payload
// that differs in any field runs its own mirror, and the options change what the mirror writes.

// In-process: across processes (a rolling deploy's overlap, replicas) each runs its own mirror, which
// stays correct because every write in it is conditional on a change.

const REMEMBER_MS = 10 * 60_000;
const MAX_REMEMBERED = 20_000;

type MirrorOptions = Parameters<typeof mirrorChatwootEvent>[4];
type MirrorFn = typeof mirrorChatwootEvent;

interface Remembered {
  at: number;
  result: MirrorResult;
}

const inFlight = new Map<string, Promise<MirrorResult>>();
const remembered = new Map<string, Remembered>();

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

function remember(key: string, result: MirrorResult, now: number): void {
  remembered.delete(key);
  remembered.set(key, { at: now, result });
  // NOTE: Insertion order is age order, so the oldest entries are the first ones out.
  for (const [k, v] of remembered) {
    if (remembered.size <= MAX_REMEMBERED && now - v.at <= REMEMBER_MS) break;
    remembered.delete(k);
  }
}

// A follower reports `applied: false` and no transition (`prevStatus` is the current status), so
// exactly one delivery of an event acts on a transition. Null when the rows moved since the leader
// left them: the same payload over different rows can decide differently, so it has to run.
async function asFollower(
  tenantId: bigint,
  lead: MirrorResult,
  base: PrismaClient,
): Promise<MirrorResult | null> {
  if (lead.conversationRowId === null) return { ...lead, applied: false };
  const rowId = lead.conversationRowId;
  const read = await runScopedOn(base, sysCtx(tenantId), async (db) => ({
    versions: await mirrorRowVersions(db, rowId),
    current: await db.conversation.findUnique({
      where: { id: rowId },
      select: {
        status: true,
        assigneeId: true,
        assigneeType: true,
        lastEventAt: true,
      },
    }),
  }));
  if (read.current === null || read.versions !== lead.rowVersions) return null;
  const current = read.current;
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
    rowVersions: read.versions,
  };
}

export async function mirrorOncePerEvent(
  tenantId: bigint,
  instanceId: bigint,
  n: NormalizedChatwootEvent,
  base: PrismaClient = basePrisma,
  opts: MirrorOptions = {},
  mirror: MirrorFn = mirrorChatwootEvent,
): Promise<MirrorResult> {
  const key = mirrorEventKey(tenantId, instanceId, n, opts);
  const known = remembered.get(key);
  if (known && Date.now() - known.at <= REMEMBER_MS) {
    const reused = await asFollower(tenantId, known.result, base);
    if (reused !== null) return reused;
    remembered.delete(key);
  }
  const running = inFlight.get(key);
  if (running) {
    // A leader that failed, that held a write back, or whose rows moved since does not stand for
    // this delivery, so it runs its own, as the new leader.
    const lead = await running.catch(() => null);
    if (lead !== null && !lead.heldBack) {
      const reused = await asFollower(tenantId, lead, base);
      if (reused !== null) return reused;
    }
    return mirrorOncePerEvent(tenantId, instanceId, n, base, opts, mirror);
  }
  const run = mirror(tenantId, instanceId, n, base, opts);
  inFlight.set(key, run);
  try {
    const result = await run;
    if (!result.heldBack) remember(key, result, Date.now());
    return result;
  } finally {
    inFlight.delete(key);
  }
}

// Forget every remembered event. For tests that reuse one payload across a reset database.
export function forgetMirroredEvents(): void {
  remembered.clear();
}
