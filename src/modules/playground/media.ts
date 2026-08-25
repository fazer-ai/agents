import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// Binary playground media (recorded voice notes, generated TTS replies, uploaded files) for replay
// when a session is reopened. Tenant-scoped + RLS. Linked to a turn by the LangChain message id it
// belongs to. A per-tenant retention cap bounds storage (the playground is a test surface, not an
// archive). All best-effort: a media-write hiccup must never break a turn.

export type PlaygroundMediaKind = "user_audio" | "tts_audio" | "user_file";

// Keep at most this many media rows per tenant; older ones are pruned on each save.
const MEDIA_RETENTION_PER_TENANT = 200;

export interface SaveMediaParams {
  ctx: TenantContext;
  agentId: bigint;
  threadId: string;
  messageId: string;
  kind: PlaygroundMediaKind;
  mime: string;
  fileName?: string | null;
  bytes: ArrayBuffer;
}

// Persists one media blob and prunes the tenant's oldest rows past the cap. Returns the new row id
// (string) or null on failure — best-effort, never throws into the turn.
export async function savePlaygroundMedia(
  base: PrismaClient,
  params: SaveMediaParams,
): Promise<string | null> {
  try {
    return await runScopedOn(base, params.ctx, async (db) => {
      const row = await db.playgroundMedia.create({
        data: {
          tenantId: params.ctx.tenantId as bigint,
          agentId: params.agentId,
          threadId: params.threadId,
          messageId: params.messageId,
          kind: params.kind,
          mime: params.mime,
          fileName: params.fileName ?? null,
          bytes: Buffer.from(params.bytes),
        },
        select: { id: true },
      });
      // Prune: find the (CAP+1)-th newest id and delete everything at or below it.
      const cutoff = await db.playgroundMedia.findMany({
        orderBy: { id: "desc" },
        skip: MEDIA_RETENTION_PER_TENANT,
        take: 1,
        select: { id: true },
      });
      const cutoffId = cutoff[0]?.id;
      if (cutoffId != null) {
        const pruned = await db.playgroundMedia.deleteMany({
          where: { id: { lte: cutoffId } },
        });
        if (pruned.count > 0) {
          logger.info(
            "playground: pruned %d media rows past the retention cap (tenant=%s)",
            pruned.count,
            String(params.ctx.tenantId),
          );
        }
      }
      return String(row.id);
    });
  } catch (e) {
    logger.warn(
      "playground: media save failed (kind=%s): %s",
      params.kind,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

export interface MediaMeta {
  id: string;
  messageId: string;
  kind: string;
  mime: string;
  fileName: string | null;
}

// Lists a thread's media (NO bytes) for joining onto reconstructed turns.
export async function listThreadMedia(
  ctx: TenantContext,
  threadId: string,
  base: PrismaClient = basePrisma,
): Promise<MediaMeta[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.playgroundMedia.findMany({
      where: { threadId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        messageId: true,
        kind: true,
        mime: true,
        fileName: true,
      },
    }),
  );
  return rows.map((r) => ({
    id: String(r.id),
    messageId: r.messageId,
    kind: r.kind,
    mime: r.mime,
    fileName: r.fileName,
  }));
}

export interface MediaBlob {
  mime: string;
  fileName: string | null;
  bytes: ArrayBuffer;
}

// Fetches one media blob by id (tenant-scoped). Null when absent / not this tenant's.
export async function getPlaygroundMedia(
  ctx: TenantContext,
  mediaId: bigint,
  base: PrismaClient = basePrisma,
): Promise<MediaBlob | null> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.playgroundMedia.findUnique({
      where: { id: mediaId },
      select: { mime: true, fileName: true, bytes: true },
    }),
  );
  if (!row) return null;
  // Copy into a fresh ArrayBuffer (Prisma's Bytes is Uint8Array<ArrayBufferLike>, not assignable to
  // BodyInit under strict lib types).
  const u8 = row.bytes as Uint8Array;
  const ab = u8.buffer.slice(
    u8.byteOffset,
    u8.byteOffset + u8.byteLength,
  ) as ArrayBuffer;
  return { mime: row.mime, fileName: row.fileName, bytes: ab };
}
