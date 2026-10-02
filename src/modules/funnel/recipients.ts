import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import {
  type BroadcastDto,
  broadcastToDto,
  getBroadcastRowOn,
} from "@/modules/funnel/broadcasts";

// Per-recipient bookkeeping for the human rail: the operator sends by hand and
// marks each row, so a broadcast can complete without a send-all. While the
// broadcast is open a row moves PENDING <-> SENT/FAILED; once it is SENT the
// record is frozen (a correction belongs on a new broadcast).

const RECIPIENT_STATUSES = ["PENDING", "SENT", "FAILED"] as const;
export const recipientPatchSchema = z
  .object({
    status: z.enum(RECIPIENT_STATUSES),
    // Operator note on a FAILED mark (why the copy-out failed).
    error: z.string().max(500).optional(),
  })
  .strict();
export type RecipientPatch = z.infer<typeof recipientPatchSchema>;

export async function setRecipientStatus(
  ctx: TenantContext,
  broadcastId: bigint,
  recipientId: bigint,
  input: RecipientPatch,
  base: PrismaClient = basePrisma,
): Promise<BroadcastDto> {
  const data = parseInput(recipientPatchSchema, input);
  return runScopedOn(base, ctx, async (db) => {
    const current = await getBroadcastRowOn(db, broadcastId);
    if (current.status === "SENT") {
      throw new AppError(
        "a sent broadcast can no longer be edited",
        409,
        "errors.merchantBroadcastNotEditable",
      );
    }
    const recipient = (current.recipients ?? []).find(
      (r) => r.id === recipientId,
    );
    if (!recipient) {
      throw new NotFoundError(
        "broadcast recipient not found",
        "errors.merchantBroadcastNotFound",
      );
    }
    const now = new Date();
    await db.broadcastRecipient.update({
      where: { id: recipientId },
      data: {
        status: data.status,
        error: data.error ?? null,
        sentAt: data.status === "SENT" ? now : null,
      },
    });
    // sentCount mirrors the recipients, and a broadcast whose list is fully
    // worked through reads as done.
    const next = (current.recipients ?? []).map((r) =>
      r.id === recipientId ? { ...r, status: data.status } : r,
    );
    const sentCount = next.filter((r) => r.status === "SENT").length;
    const pendingLeft = next.filter((r) => r.status === "PENDING").length;
    const closeOut = pendingLeft === 0 && next.length > 0;
    await db.broadcast.update({
      where: { id: broadcastId },
      data: {
        sentCount,
        ...(closeOut ? { status: "SENT" as const, sentAt: now } : {}),
      },
    });
    const row = await getBroadcastRowOn(db, broadcastId);
    const dto = broadcastToDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_broadcast.recipient_set",
      target: `broadcast:${broadcastId}/recipient:${recipientId}`,
      before: { status: recipient.status },
      after: {
        status: data.status,
        ...(data.error !== undefined ? { error: data.error } : {}),
      },
    });
    return dto;
  });
}
