import type { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { metricsDeadline } from "../budget";
import type { DashboardFilter } from "../filter";
import { alignedDays, BLOCK_SECTIONS, type Block, WindowLoad } from "./engine";
import { costsLink, type DashboardFigures, figuresOf } from "./figures";

// A block for a caller that answers once (a REST route, an MCP tool): from the kept days when the
// window starts and ends on local midnights of its zone, which is every window the console asks for,
// and from the live reader otherwise, so both transports return the console's figures. A cold window
// that does not fit one METRICS_TIMEOUT_MS is refused as too slow, and the next call goes on from
// the days kept; `signal` (the caller gone) stops it at the next part.
export async function fromKeptDays<T>(
  ctx: TenantContext,
  filter: DashboardFilter,
  block: Block,
  pick: (f: DashboardFigures) => T,
  live: () => Promise<T>,
  base?: PrismaClient,
  signal?: AbortSignal,
): Promise<T> {
  const w = alignedDays(filter);
  if (!w || ctx.tenantId === null) return live();
  // The link first, on the request's own budget: after the days it would have none left, and a
  // budget of its own would run past the request's.
  const langfuse =
    block === "costs" ? await costsLink(ctx, base, metricsDeadline()) : null;
  const load = await new WindowLoad(
    ctx,
    filter,
    BLOCK_SECTIONS[block],
    w,
    base,
  ).complete(signal);
  return pick(await figuresOf(ctx, load, [block], langfuse, base));
}
