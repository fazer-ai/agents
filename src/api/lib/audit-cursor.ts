import type { PrismaClient } from "@/../generated/prisma/client";
import type { AuditScope } from "@/lib/audit/scope";
import { badQueryParam } from "@/lib/query-param";
import type { TenantContext } from "@/lib/tenancy";
import {
  type AuditCursor,
  parseAuditCursor,
  resolveLegacyAuditCursor,
} from "@/modules/audit/service";

// The audit keyset became two columns in #530, so a cursor is `<ISO instant>|<id>` and no longer a
// bare id -- which `parseQueryId` would have parsed happily into the wrong thing.
//
// A cursor in the OLD shape is resolved against the table rather than refused, for the length of one
// rolling deploy: the previous release is still handing them out, and an operator paging the trail
// should not get a 400 mid-walk because their two clicks landed on two containers. Resolving asks
// which instant that row carries, so the walk continues from the same place the old one would have;
// reinterpreting the number as the new key would not, and that is what round 1 of the review was
// about. Anything that is neither shape, or an id naming no row this reader can see, is the same 400
// every other malformed parameter gets.
//
// TEMPORARY, with the fleet index kept for the same reason (docs/roadmap.md).
export async function auditCursorFrom(
  raw: string | undefined,
  ctx: TenantContext,
  scope: AuditScope,
  base?: PrismaClient,
): Promise<AuditCursor | undefined> {
  if (raw === undefined) return undefined;
  const parsed = parseAuditCursor(raw);
  if (parsed !== null) return parsed;
  const legacy = await resolveLegacyAuditCursor(ctx, raw, scope, base);
  if (legacy === null) badQueryParam("cursor");
  return legacy;
}
