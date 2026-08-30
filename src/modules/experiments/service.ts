import { z } from "zod";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { markUndisclosed, undisclosedMoved } from "@/modules/audit/projection";
import { auditMutation, projectionMoved } from "@/modules/audit/service";

// Prompt A/B experiments. A thread is bucketed to a variant DETERMINISTICALLY (so re-resolution is
// stable), and the assignment is persisted race-safely via createMany({skipDuplicates}) — an
// atomic ON CONFLICT DO NOTHING that does NOT abort the surrounding tx — then re-read so concurrent
// resolvers converge on the one persisted variant. Conversions are the generic ConversionEvent
// (keyed by thread+source); experiment analysis joins assignments↔conversions by threadId.

export const variantSchema = z.object({
  key: z.string().min(1),
  weight: z.number().nonnegative().optional(),
  // NO length bound here, deliberately, and the asymmetry with the controller is the point. This
  // schema is a READER: `parseVariants` runs it over a stored row, and it parses the ARRAY, so one
  // oversized prompt written under the old contract would fail the whole parse and silently disable
  // the entire experiment for every turn. The ceiling belongs where a caller can still be told about
  // it — `variantSchemaT` in the controller — which is what keeps a NEW variant inside the same
  // ceiling the agent's own prompt is held to (#58) without breaking an upgrade.
  systemPrompt: z.string().optional(),
});
export type Variant = z.infer<typeof variantSchema>;

// THE SAME SHAPE, BOUNDED, FOR WRITES ONLY.
//
// `systemPrompt` REPLACES the agent's own prompt when the variant is assigned (`loadAgentConfig`),
// so a variant that skipped the agent's ceiling would ship a prompt the agent itself would have been
// refused — and it breaks a derivation downstream, since the log debug mode sizes its ceiling from
// the largest operator-authored prompt this API accepts (#58).
//
// It is a SECOND schema rather than a bound on the reader because the reader parses the whole ARRAY
// off a stored row: one prompt written under the older, unbounded contract would fail that parse and
// silently disable the entire experiment for every turn. Bounding a write refuses the caller, who
// can act on it; bounding a read refuses the tenant, who cannot.
//
// And it goes on the two functions both write paths converge on, not on either surface: the REST
// controller publishes the same ceiling in its own schema so a client can see it, and the MCP tool
// maps its arguments straight into these calls without a schema of its own.
export const variantWriteSchema = variantSchema.extend({
  systemPrompt: z.string().max(config.agent.promptMaxChars).optional(),
});

export function parseVariants(raw: unknown): Variant[] {
  const parsed = z.array(variantSchema).safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return h >>> 0;
}

// Deterministic weighted bucket of a thread into a variant.
export function chooseVariant(threadId: string, variants: Variant[]): string {
  const weights = variants.map((v) => Math.max(0, v.weight ?? 1));
  const total = weights.reduce((a, b) => a + b, 0) || variants.length;
  const point = ((djb2(threadId) % 10_000) / 10_000) * total;
  let acc = 0;
  for (let i = 0; i < variants.length; i++) {
    acc += weights[i] === 0 ? 0 : (weights[i] ?? 1);
    if (point < acc) return variants[i]?.key as string;
  }
  return variants[variants.length - 1]?.key as string;
}

// Resolves the active experiment for an agent (if any), assigns/loads this thread's variant, and
// returns the variant's systemPrompt OVERRIDE (or null). Runs inside the caller's scoped tx
// (DB-only). Used by loadAgentConfig to A/B the prompt.
export async function resolveVariantOverride(
  db: ScopedDb,
  args: { tenantId: bigint; agentId: bigint; threadId: string },
): Promise<string | null> {
  const exp = await db.experiment.findFirst({
    where: { agentId: args.agentId, enabled: true },
    orderBy: { createdAt: "desc" },
    select: { id: true, variants: true },
  });
  if (!exp) return null;
  const variants = parseVariants(exp.variants);
  if (variants.length === 0) return null;
  const chosen = chooseVariant(args.threadId, variants);
  await db.promptVariantAssignment.createMany({
    data: [
      {
        tenantId: args.tenantId,
        threadId: args.threadId,
        experimentId: exp.id,
        variantKey: chosen,
      },
    ],
    skipDuplicates: true,
  });
  const row = await db.promptVariantAssignment.findUnique({
    where: {
      tenantId_threadId_experimentId: {
        tenantId: args.tenantId,
        threadId: args.threadId,
        experimentId: exp.id,
      },
    },
    select: { variantKey: true },
  });
  const key = row?.variantKey ?? chosen;
  return variants.find((v) => v.key === key)?.systemPrompt ?? null;
}

// What the audit row carries.
//
// Same two halves as the other four families: identity, policy and shape are PROJECTED, everything
// else is listed in `UNDISCLOSED` below and compared without being carried.
//
// The variants contribute their KEYS and WEIGHTS and never their `systemPrompt`. A prompt is the
// largest field an experiment holds, and what a reader needs from a variant change is that the
// split moved and which arm it moved for; the prompt is readable on the experiment for as long as
// the experiment exists, and this row outlives it. But editing one arm's prompt while leaving its
// key and weight alone is a substantive change to the experiment and moves nothing above, so the
// whole variant array is compared.
//
// `tests/modules/audit-config-families.test.ts` holds the fence over this model's columns.
function auditProjection(r: {
  name: string;
  agentId: bigint | null;
  variants: unknown;
  enabled: boolean;
}) {
  const variants = Array.isArray(r.variants) ? r.variants : [];
  return {
    name: r.name,
    agentId: r.agentId === null ? null : String(r.agentId),
    enabled: r.enabled,
    variants: variants.map((v) => {
      const o = (v ?? {}) as Record<string, unknown>;
      return { key: o.key ?? null, weight: o.weight ?? null };
    }),
  };
}

// The column the projection above may not publish, compared and never carried
// (`@/modules/audit/projection`). A variant carries its own prompt overrides, which is exactly the
// free text a row may not keep; what the row shows is which keys exist and how the traffic splits.
const UNDISCLOSED = ["variants"] as const;

// ── CRUD ──

export async function listExperiments(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
) {
  return runScopedOn(base, ctx, (db) =>
    db.experiment.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        agentId: true,
        variants: true,
        enabled: true,
        createdAt: true,
      },
    }),
  );
}

export async function createExperiment(params: {
  ctx: TenantContext;
  name: string;
  agentId?: bigint;
  variants: Variant[];
  enabled?: boolean;
  base?: PrismaClient;
}): Promise<{ id: bigint }> {
  const base = params.base ?? basePrisma;
  const variants = parseInput(
    z.array(variantWriteSchema),
    params.variants,
    "variants",
  );
  return runScopedOn(base, params.ctx, async (db) => {
    const exp = await db.experiment.create({
      data: {
        tenantId: params.ctx.tenantId as bigint,
        name: params.name,
        agentId: params.agentId,
        variants: variants as unknown as object,
        enabled: params.enabled ?? true,
      },
      select: EXPERIMENT_SELECT,
    });
    await auditMutation(db, params.ctx, {
      action: "experiment.create",
      target: `experiment:${exp.id}`,
      after: auditProjection(exp),
    });
    return { id: exp.id };
  });
}

const EXPERIMENT_SELECT = {
  id: true,
  name: true,
  agentId: true,
  variants: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function getExperiment(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
) {
  const row = await runScopedOn(base, ctx, (db) =>
    db.experiment.findUnique({ where: { id }, select: EXPERIMENT_SELECT }),
  );
  if (!row) {
    throw new NotFoundError(
      "experiment not found",
      "errors.experimentNotFound",
    );
  }
  return row;
}

export async function updateExperiment(params: {
  ctx: TenantContext;
  id: bigint;
  name?: string;
  agentId?: bigint | null;
  variants?: Variant[];
  enabled?: boolean;
  base?: PrismaClient;
}) {
  const base = params.base ?? basePrisma;
  const variants =
    params.variants !== undefined
      ? parseInput(z.array(variantWriteSchema), params.variants, "variants")
      : undefined;
  return runScopedOn(base, params.ctx, async (db) => {
    // LOCKED before the snapshot the trail compares against: at READ COMMITTED two concurrent
    // updates both read state A, the first commits B, and the second files a row saying A became C.
    await db.$queryRaw`SELECT 1 FROM "experiments" WHERE "id" = ${params.id} FOR UPDATE`;
    const current = await db.experiment.findUnique({
      where: { id: params.id },
      select: EXPERIMENT_SELECT,
    });
    if (!current) {
      throw new NotFoundError(
        "experiment not found",
        "errors.experimentNotFound",
      );
    }
    await db.experiment.update({
      where: { id: params.id },
      data: {
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.agentId !== undefined ? { agentId: params.agentId } : {}),
        ...(variants !== undefined
          ? { variants: variants as unknown as Prisma.InputJsonValue }
          : {}),
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      },
    });
    const row = await db.experiment.findUniqueOrThrow({
      where: { id: params.id },
      select: EXPERIMENT_SELECT,
    });
    const beforeProj = auditProjection(current);
    const afterProj = auditProjection(row);
    const undisclosed = undisclosedMoved(current, row, UNDISCLOSED);
    if (undisclosed || projectionMoved(beforeProj, afterProj)) {
      await auditMutation(db, params.ctx, {
        action: "experiment.update",
        target: `experiment:${params.id}`,
        before: undisclosed ? markUndisclosed(beforeProj) : beforeProj,
        after: undisclosed ? markUndisclosed(afterProj) : afterProj,
      });
    }
    return row;
  });
}

export async function deleteExperiment(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    // Locked, then read before the delete: after `deleteMany` there is nothing left to name what
    // was removed.
    await db.$queryRaw`SELECT 1 FROM "experiments" WHERE "id" = ${id} FOR UPDATE`;
    const current = await db.experiment.findUnique({
      where: { id },
      select: EXPERIMENT_SELECT,
    });
    const res = await db.experiment.deleteMany({ where: { id } });
    if (res.count === 0 || !current) {
      throw new NotFoundError(
        "experiment not found",
        "errors.experimentNotFound",
      );
    }
    await auditMutation(db, ctx, {
      action: "experiment.delete",
      target: `experiment:${id}`,
      before: auditProjection(current),
    });
  });
}

export interface VariantResult {
  key: string;
  assigned: number;
  converted: number;
  conversionRate: number;
}

// A/B analysis: assignments per variant + how many of those threads produced a ConversionEvent
// (any source). conversionRate is converted/assigned (0 when no assignments).
export async function experimentResults(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<{ variants: VariantResult[]; totalAssigned: number }> {
  return runScopedOn(base, ctx, async (db) => {
    const exp = await db.experiment.findUnique({
      where: { id },
      select: { id: true, variants: true },
    });
    if (!exp) {
      throw new NotFoundError(
        "experiment not found",
        "errors.experimentNotFound",
      );
    }
    const declared = parseVariants(exp.variants).map((v) => v.key);
    const assignments = await db.promptVariantAssignment.findMany({
      where: { experimentId: id },
      select: { threadId: true, variantKey: true },
    });
    const threadIds = assignments.map((a) => a.threadId);
    const convertedThreads = new Set<string>();
    if (threadIds.length > 0) {
      const conversions = await db.conversionEvent.findMany({
        where: { threadId: { in: threadIds } },
        select: { threadId: true },
      });
      for (const c of conversions) convertedThreads.add(c.threadId);
    }
    // Tally per variant (include declared variants with zero assignments).
    const tally = new Map<string, { assigned: number; converted: number }>();
    for (const key of declared) tally.set(key, { assigned: 0, converted: 0 });
    for (const a of assignments) {
      const t = tally.get(a.variantKey) ?? { assigned: 0, converted: 0 };
      t.assigned += 1;
      if (convertedThreads.has(a.threadId)) t.converted += 1;
      tally.set(a.variantKey, t);
    }
    const variants: VariantResult[] = [...tally.entries()].map(([key, t]) => ({
      key,
      assigned: t.assigned,
      converted: t.converted,
      conversionRate: t.assigned > 0 ? t.converted / t.assigned : 0,
    }));
    return { variants, totalAssigned: assignments.length };
  });
}
