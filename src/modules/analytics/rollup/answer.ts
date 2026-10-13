import type { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import type { DashboardFilter } from "../filter";
import { alignedDays, BLOCK_SECTIONS, type Block, WindowLoad } from "./engine";
import { costsLink, type DashboardFigures, figuresOf } from "./figures";

// A block for a caller that answers once (a REST route, an MCP tool): from the kept days when the
// window starts and ends on local midnights of its zone, which is every window the console asks for,
// and from the live reader otherwise, so both transports return the console's figures.
export async function fromKeptDays<T>(
  ctx: TenantContext,
  filter: DashboardFilter,
  block: Block,
  pick: (f: DashboardFigures) => T,
  live: () => Promise<T>,
  base?: PrismaClient,
): Promise<T> {
  const w = alignedDays(filter);
  if (!w || ctx.tenantId === null) return live();
  const load = await new WindowLoad(
    ctx,
    filter,
    BLOCK_SECTIONS[block],
    w,
    base,
  ).complete();
  const langfuse = block === "costs" ? await costsLink(ctx, base) : null;
  return pick(await figuresOf(ctx, load, [block], langfuse, base));
}
