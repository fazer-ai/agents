import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type OccurrencesConfig, readMonitorConfig } from "./settings";

export function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// A monitor as the runtime reads it: lenient, so a damaged block is OFF, and null once it is deleted.
export async function readMonitorOccurrences(
  tenantId: bigint,
  monitorId: bigint,
  base: PrismaClient = basePrisma,
): Promise<OccurrencesConfig | null> {
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.occurrenceMonitor.findFirst({
      where: { id: monitorId, tenantId },
      select: { config: true },
    }),
  );
  return row ? readMonitorConfig(row.config) : null;
}

// Whether the monitor, as saved now, still copies these fields to Chatwoot on this inbox. Asked right
// before a copy's POST: a round reads the configuration once, at its start, and a save since (the
// field's copy switched off, the inbox taken off) may have let another monitor take the attribute on
// that inbox. A deleted monitor, or one that cannot be read, copies nothing.
export async function copyStillSaved(
  base: PrismaClient,
  m: { tenantId: bigint; monitorId: bigint },
  inboxId: bigint | null,
  keys: string[],
): Promise<boolean> {
  const saved = await readMonitorOccurrences(
    m.tenantId,
    m.monitorId,
    base,
  ).catch(() => null);
  if (!saved || inboxId === null) return false;
  if (!saved.inboxIds.includes(String(inboxId))) return false;
  return keys.every((k) =>
    saved.fields.some((f) => f.key === k && f.attribute),
  );
}
