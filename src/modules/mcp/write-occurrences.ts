import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { AppError } from "@/lib/errors";
import { runScopedOn } from "@/lib/tenancy";
import { occurrenceCost, pageOccurrenceRuns } from "@/modules/occurrences/runs";
import {
  mergeOccurrences,
  type OccurrencesPatch,
  occurrencesSettingsSchema,
} from "@/modules/occurrences/settings";
import { countThemes, getTheme, listThemes } from "@/modules/occurrences/views";
import {
  assertOccurrencesInboxes,
  canonicalOccurrenceModel,
  getOccurrencesSettings,
  updateOccurrencesSettings,
} from "@/modules/tenant-settings/service";
import type { VerifiedToken } from "./oauth/tokens";
import {
  err,
  gate,
  ok,
  readGate,
  type WriteDeps,
  type WriteResult,
} from "./write";

// MCP for the account's occurrence monitor (docs/occurrences.md): the same block the console card
// and `PUT /v1/occurrences/config` write, through the same service, so a value one refuses the others
// refuse too.

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

export async function occurrencesGet(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ occurrences: await getOccurrencesSettings(ctx, base) });
  } catch (e) {
    return failOf(e);
  }
}

// The rounds a page at a time, as the console reads them, with what the monitor cost over the last 7
// and 30 days.
export async function occurrenceRunsList(
  principal: VerifiedToken,
  args: { limit?: number; before?: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    const [page, cost] = await Promise.all([
      pageOccurrenceRuns(
        ctx,
        { limit: args.limit ?? 20, before: args.before ?? null },
        base,
      ),
      occurrenceCost(ctx, new Date(), base),
    ]);
    return ok({ ...page, cost });
  } catch (e) {
    return failOf(e);
  }
}

export async function occurrenceThemesList(
  principal: VerifiedToken,
  args: { theme_id?: string; flagged?: boolean; limit?: number },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    if (args.theme_id !== undefined) {
      const id = parseDbId(args.theme_id);
      if (id === null) return err("theme_id is not a theme id");
      return ok({ theme: await getTheme(ctx, id, base) });
    }
    const flagged = args.flagged ? { flaggedOnly: true } : {};
    return ok({
      themes: await listThemes(
        ctx,
        {
          ...flagged,
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        },
        base,
      ),
      total: await countThemes(ctx, flagged, base),
    });
  } catch (e) {
    return failOf(e);
  }
}

export type OccurrencesSetArgs = OccurrencesPatch & {
  dry_run?: boolean;
  tenant?: string;
};

// The preview merges and validates exactly as the write will, the credential and inbox checks
// included.
export async function occurrencesSet(
  principal: VerifiedToken,
  args: OccurrencesSetArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const { dry_run, tenant: _tenant, ...rest } = args;
  const patch = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== undefined),
  ) as OccurrencesPatch;
  if (Object.keys(patch).length === 0)
    return err("nothing to change: pass at least one field of the block");
  try {
    if (dry_run !== false) {
      const current = await getOccurrencesSettings(ctx, base);
      const proposed = occurrencesSettingsSchema.safeParse(
        mergeOccurrences(
          current,
          await canonicalOccurrenceModel(ctx, patch, base),
        ),
      );
      if (!proposed.success)
        return err(
          `occurrences: ${proposed.error.issues[0]?.message ?? "invalid"}`,
        );
      await runScopedOn(base, ctx, (db) =>
        assertOccurrencesInboxes(
          db,
          ctx.tenantId as bigint,
          current,
          proposed.data,
        ),
      );
      return ok({
        dryRun: true,
        target: "occurrences",
        current,
        proposed: proposed.data,
      });
    }
    return ok({
      dryRun: false,
      applied: true,
      target: "occurrences",
      occurrences: await updateOccurrencesSettings(ctx, patch, base),
    });
  } catch (e) {
    return failOf(e);
  }
}
