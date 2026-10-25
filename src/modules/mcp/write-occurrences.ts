import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { AppError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { parseIsoInstant } from "@/modules/flowlog/settings";
import {
  assertAttributesFree,
  assertOccurrencesInboxes,
  canonicalOccurrenceModel,
  createMonitor,
  deleteMonitor,
  duplicateMonitor,
  listMonitors,
  MONITORS_MAX,
  type Monitor,
  proposedConfig,
  renameMonitor,
  resolveMonitor,
  updateMonitorConfig,
} from "@/modules/occurrences/monitors";
import { occurrenceCost, pageOccurrenceRuns } from "@/modules/occurrences/runs";
import {
  OCCURRENCES_DEFAULTS,
  type OccurrencesPatch,
} from "@/modules/occurrences/settings";
import {
  countFlagEpisodes,
  countThemes,
  getTheme,
  listFlagEpisodes,
  listThemes,
} from "@/modules/occurrences/views";
import type { VerifiedToken } from "./oauth/tokens";
import { previewBase } from "./preview-base";
import {
  err,
  gate,
  ok,
  readGate,
  type WriteDeps,
  type WriteResult,
} from "./write";

// MCP for the account's occurrence monitors (docs/occurrences.md): the same rows the console and
// `/v1/occurrences/monitors` write, through the same service, so a value one refuses the others refuse
// too. A tool that takes `monitor_id` answers for the account's first monitor without it.

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

// The monitor `monitor_id` names, or the first; an id of no monitor of this account is refused.
async function monitorOf(
  ctx: TenantContext,
  raw: string | undefined,
  base: Parameters<typeof resolveMonitor>[2],
): Promise<Monitor | null> {
  if (raw === undefined) return resolveMonitor(ctx, undefined, base);
  const id = parseDbId(raw);
  if (id === null) throw new AppError("monitor not found", 404);
  return resolveMonitor(ctx, id, base);
}

export async function occurrenceMonitorsList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    return ok({ monitors: await listMonitors(ctx, base), max: MONITORS_MAX });
  } catch (e) {
    return failOf(e);
  }
}

// The three monitor writes preview by running the write itself in a transaction rolled back at the
// end (`previewBase`), so the preview refuses what the apply refuses (a taken name, the cap on
// monitors) and shows what it would leave.
async function monitorWrite(
  principal: VerifiedToken,
  dryRun: boolean | undefined,
  deps: WriteDeps,
  run: (ctx: TenantContext, base: PrismaClient) => Promise<unknown>,
): Promise<WriteResult> {
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const base = deps.base ?? basePrisma;
  const preview = dryRun !== false;
  try {
    const result = await run(ctx, preview ? previewBase(base) : base);
    return ok(
      preview
        ? { dryRun: true, target: "occurrence_monitor", preview: result }
        : {
            dryRun: false,
            applied: true,
            target: "occurrence_monitor",
            result,
          },
    );
  } catch (e) {
    return failOf(e);
  }
}

// A new monitor, off and with the default configuration; with `duplicate_of`, that monitor's
// configuration, off and with no inboxes.
export async function occurrenceMonitorCreate(
  principal: VerifiedToken,
  args: {
    name?: string;
    duplicate_of?: string;
    dry_run?: boolean;
    tenant?: string;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  if (args.name === undefined && args.duplicate_of === undefined)
    return err("pass name, or duplicate_of to copy a monitor");
  return monitorWrite(principal, args.dry_run, deps, async (ctx, base) => {
    if (args.duplicate_of === undefined)
      return createMonitor(ctx, { name: args.name }, base);
    const source = await monitorOf(ctx, args.duplicate_of, base);
    if (!source) throw new AppError("monitor not found", 404);
    return duplicateMonitor(
      ctx,
      source.id,
      args.name === undefined ? {} : { name: args.name },
      base,
    );
  });
}

export async function occurrenceMonitorUpdate(
  principal: VerifiedToken,
  args: {
    monitor_id: string;
    name: string;
    dry_run?: boolean;
    tenant?: string;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  return monitorWrite(principal, args.dry_run, deps, async (ctx, base) => {
    const m = await monitorOf(ctx, args.monitor_id, base);
    if (!m) throw new AppError("monitor not found", 404);
    return renameMonitor(ctx, m.id, { name: args.name }, base);
  });
}

// What goes with it: its open themes and rounds, which the preview counts.
export async function occurrenceMonitorDelete(
  principal: VerifiedToken,
  args: { monitor_id: string; dry_run?: boolean; tenant?: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  return monitorWrite(principal, args.dry_run, deps, async (ctx, base) => {
    const m = await monitorOf(ctx, args.monitor_id, base);
    if (!m) throw new AppError("monitor not found", 404);
    return { name: m.name, ...(await deleteMonitor(ctx, m.id, base)) };
  });
}

export async function occurrencesGet(
  principal: VerifiedToken,
  args: { monitor_id?: string } = {},
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    const m = await monitorOf(ctx, args.monitor_id, base);
    return ok({
      monitor: m ? { id: String(m.id), name: m.name } : null,
      occurrences: m ? m.config : OCCURRENCES_DEFAULTS,
    });
  } catch (e) {
    return failOf(e);
  }
}

// The rounds a page at a time, as the console reads them, with what the monitor cost over the last 7
// and 30 days.
export async function occurrenceRunsList(
  principal: VerifiedToken,
  args: { monitor_id?: string; limit?: number; before?: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    // No monitor yet has neither rounds nor cost: an id no round carries.
    const id = (await monitorOf(ctx, args.monitor_id, base))?.id ?? 0n;
    const [page, cost] = await Promise.all([
      pageOccurrenceRuns(
        ctx,
        id,
        { limit: args.limit ?? 20, before: args.before ?? null },
        base,
      ),
      occurrenceCost(ctx, id, new Date(), base),
    ]);
    return ok({ ...page, cost });
  } catch (e) {
    return failOf(e);
  }
}

export async function occurrenceThemesList(
  principal: VerifiedToken,
  args: {
    monitor_id?: string;
    theme_id?: string;
    flagged?: boolean;
    limit?: number;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    const m = await monitorOf(ctx, args.monitor_id, base);
    if (args.theme_id !== undefined) {
      const id = parseDbId(args.theme_id);
      if (id === null) return err("theme_id is not a theme id");
      if (!m) return err("theme not found");
      return ok({ theme: await getTheme(ctx, m.id, id, base) });
    }
    if (!m) return ok({ themes: [], total: 0 });
    const flagged = args.flagged ? { flaggedOnly: true } : {};
    return ok({
      themes: await listThemes(
        ctx,
        m.id,
        {
          ...flagged,
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        },
        base,
      ),
      total: await countThemes(ctx, m.id, flagged, base),
    });
  } catch (e) {
    return failOf(e);
  }
}

// The flag episodes overlapping [since, until), the same list the REST read returns.
export async function occurrenceFlagEpisodesList(
  principal: VerifiedToken,
  args: { monitor_id?: string; since: string; until: string; limit?: number },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  const since = parseIsoInstant(args.since);
  const until = parseIsoInstant(args.until);
  if (since === null) return err("since is not an ISO instant");
  if (until === null) return err("until is not an ISO instant");
  if (until.getTime() <= since.getTime())
    return err("until must be after since");
  try {
    const m = await monitorOf(ctx, args.monitor_id, base);
    if (!m) return ok({ episodes: [], total: 0 });
    return ok({
      episodes: await listFlagEpisodes(
        ctx,
        m.id,
        { since, until },
        args.limit === undefined ? {} : { limit: args.limit },
        base,
      ),
      total: await countFlagEpisodes(ctx, m.id, { since, until }, base),
    });
  } catch (e) {
    return failOf(e);
  }
}

export type OccurrencesSetArgs = OccurrencesPatch & {
  monitor_id?: string;
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
  const { dry_run, tenant: _tenant, monitor_id, ...rest } = args;
  const patch = Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== undefined),
  ) as OccurrencesPatch;
  if (Object.keys(patch).length === 0)
    return err("nothing to change: pass at least one field of the block");
  try {
    const m = await monitorOf(ctx, monitor_id, base);
    if (dry_run !== false) {
      const current = m ? m.config : OCCURRENCES_DEFAULTS;
      const proposed = proposedConfig(
        current,
        await canonicalOccurrenceModel(ctx, patch, base),
      );
      await runScopedOn(base, ctx, async (db) => {
        await assertOccurrencesInboxes(
          db,
          ctx.tenantId as bigint,
          current,
          proposed,
        );
        await assertAttributesFree(
          db,
          ctx.tenantId as bigint,
          m?.id ?? null,
          proposed,
        );
      });
      return ok({
        dryRun: true,
        target: "occurrences",
        monitor: m ? { id: String(m.id), name: m.name } : null,
        current,
        proposed,
      });
    }
    return ok({
      dryRun: false,
      applied: true,
      target: "occurrences",
      occurrences: await updateMonitorConfig(
        ctx,
        m ? m.id : "first",
        patch,
        base,
      ),
    });
  } catch (e) {
    return failOf(e);
  }
}
