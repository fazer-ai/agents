import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";

// `{{conversation_ref}}`: the handle an operator's HTTP tool gives the operator's own system, so
// that system can later send an event about THIS conversation to a GENERIC webhook. An
// IntegrationExternalRef like the Asaas and Resend ones, but STABLE per (instance, conversation),
// not per call (two concurrent first uses may each mint one; both stay valid and the older wins
// every later read), and it correlates ONLY on the GENERIC instance that minted it, as this kind.
// The token is opaque (192 bits) and authenticates nothing: a delivery still passes the instance's
// own inbound authentication.
export const CONVERSATION_REF_KIND = "conversation_ref";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export type EnsureConversationRefResult =
  | { ok: true; ref: string }
  // The tool names an instance that no longer exists, or is not GENERIC. The tool refuses to run
  // rather than send an empty handle the receiver would store and never be able to use.
  | { ok: false; reason: "instance_missing" | "instance_not_generic" };

export async function ensureConversationRef(params: {
  tenantId: bigint;
  integrationInstanceId: bigint;
  threadId: string;
  base?: PrismaClient;
}): Promise<EnsureConversationRefResult> {
  const base = params.base ?? basePrisma;
  return await runScopedOn(base, sysCtx(params.tenantId), async (db) => {
    const instance = await db.integrationInstance.findUnique({
      where: { id: params.integrationInstanceId },
      select: { catalogType: true },
    });
    if (!instance) return { ok: false, reason: "instance_missing" };
    if (instance.catalogType !== "GENERIC") {
      return { ok: false, reason: "instance_not_generic" };
    }
    const existing = await db.integrationExternalRef.findFirst({
      where: {
        integrationInstanceId: params.integrationInstanceId,
        threadId: params.threadId,
        kind: CONVERSATION_REF_KIND,
      },
      orderBy: { id: "asc" },
      select: { externalId: true },
    });
    if (existing) return { ok: true, ref: existing.externalId };
    const ref = `cr_${randomBytes(24).toString("base64url")}`;
    await db.integrationExternalRef.create({
      data: {
        tenantId: params.tenantId,
        integrationInstanceId: params.integrationInstanceId,
        externalId: ref,
        threadId: params.threadId,
        kind: CONVERSATION_REF_KIND,
      },
    });
    return { ok: true, ref };
  });
}

// The thread a GENERIC delivery is about, or null when the ref does not correlate HERE: unknown,
// minted by another instance, or a ref of another kind (a payment's correlation id is not a handle
// to the conversation).
export async function correlateConversationRef(
  db: ScopedDb,
  params: { tenantId: bigint; integrationInstanceId: bigint; ref: string },
): Promise<string | null> {
  const row = await db.integrationExternalRef.findUnique({
    where: {
      tenantId_externalId: {
        tenantId: params.tenantId,
        externalId: params.ref,
      },
    },
    select: { threadId: true, integrationInstanceId: true, kind: true },
  });
  if (!row) return null;
  if (row.kind !== CONVERSATION_REF_KIND) return null;
  if (row.integrationInstanceId !== params.integrationInstanceId) return null;
  return row.threadId;
}
