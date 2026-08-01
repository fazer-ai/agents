import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type DebounceConfig, readDebounceConfig } from "./settings";

// Debounce arming + config resolution. Arming re-uses the durable scheduler row (one live row per
// thread): each new inbound message pushes runAt forward (the coalescing window), capped at the
// anti-starvation ceiling measured from the burst's start. The DEBOUNCE job is drained by the
// dedicated fast worker; the flush (handler.ts) re-fetches and answers only the new burst.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function debounceDedupeKey(threadId: string): string {
  return `debounce:${threadId}`;
}

// Resolves the debounce config for the inbox's agent. Returns null when the agent is unbound,
// disabled, or has debounce turned off — the caller then takes the direct (no-coalesce) path.
export async function resolveDebounceConfig(
  tenantId: bigint,
  instanceId: bigint,
  chatwootInboxId: number,
  base: PrismaClient = basePrisma,
): Promise<DebounceConfig | null> {
  const cfg = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const inbox = await db.inbox.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId,
        },
      },
      select: { agentId: true },
    });
    if (!inbox?.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { enabled: true, settings: true },
    });
    if (!agent?.enabled) return null;
    return readDebounceConfig(agent.settings);
  });
  if (!cfg?.enabled) return null;
  return cfg;
}

function readBurstStart(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>).burstStartedAt;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// The burst's newest known Chatwoot message id, kept in the job payload so a flush abandoned by the
// human-takeover gate can still advance the handled watermark without a network fetch (issue #8).
export function readLastMessageId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>).lastMessageId;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface ArmDebounceParams {
  tenantId: bigint;
  threadId: string;
  agentBotId: number | null;
  cfg: DebounceConfig;
  // Chatwoot id of the inbound message arming this flush (see readLastMessageId). Optional: an arm
  // without it keeps the burst's previous high-water mark.
  lastMessageId?: number;
  base?: PrismaClient;
  now?: Date;
}

// Re-arms the per-thread DEBOUNCE job: runAt = min(now + window, burstStart + maxWindow). The first
// message of a burst stamps burstStartedAt; subsequent ones keep it (so the anti-starvation cap is
// measured from the start). Serialized per thread by an advisory lock so concurrent deliveries for
// the same conversation cannot lose the burst-start stamp. instanceId/conversationId are recoverable
// from threadId, so the payload stays JSON-safe (no bigint). Returns the computed flush time so the
// caller can surface a live countdown on the realtime "waiting for more messages" indicator.
export async function armDebounce(params: ArmDebounceParams): Promise<Date> {
  const { tenantId, threadId, agentBotId, cfg } = params;
  const base = params.base ?? basePrisma;
  const nowMs = (params.now ?? new Date()).getTime();
  const dedupeKey = debounceDedupeKey(threadId);
  return runScopedOn(base, sysCtx(tenantId), (db) =>
    withEntityLock(db, `debounce-arm:${threadId}`, async () => {
      const existing = await db.schedulerJob.findFirst({
        where: { kind: "DEBOUNCE", dedupeKey },
        select: { status: true, payload: true },
      });
      const prevBurst =
        existing?.status === "PENDING"
          ? readBurstStart(existing.payload)
          : null;
      const burstStartedAt = prevBurst ?? nowMs;
      // High-water message id across the burst's arms (a fresh burst starts over, like burstStartedAt).
      const prevLast =
        existing?.status === "PENDING"
          ? readLastMessageId(existing.payload)
          : null;
      const lastMessageId =
        Math.max(prevLast ?? 0, params.lastMessageId ?? 0) || null;
      const runAtMs = Math.min(
        nowMs + cfg.windowSeconds * 1000,
        burstStartedAt + cfg.maxWindowSeconds * 1000,
      );
      const payload = {
        threadId,
        agentBotId,
        burstStartedAt,
        ...(lastMessageId !== null ? { lastMessageId } : {}),
      } satisfies Prisma.InputJsonObject;
      await db.schedulerJob.upsert({
        where: {
          tenantId_kind_dedupeKey: { tenantId, kind: "DEBOUNCE", dedupeKey },
        },
        create: {
          tenantId,
          kind: "DEBOUNCE",
          dedupeKey,
          runAt: new Date(runAtMs),
          status: "PENDING",
          payload,
        },
        update: {
          runAt: new Date(runAtMs),
          status: "PENDING",
          lastError: null,
          payload,
        },
      });
      return new Date(runAtMs);
    }),
  );
}
