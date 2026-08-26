import { AppError } from "@/lib/errors";

// The refusal a caller-supplied filter gets when the server cannot use it, in one place because it
// is raised from BOTH layers a filter passes through: the query parser (REST only, see
// api/lib/query-filters.ts) and the service that owns the parameter's range (REST *and* MCP, which
// never sees a query string). Two spellings of the same refusal would let the two disagree about
// the same value.
//
// The translation key is declared for the extractor in api/v1/webhooks.controller.ts, whose input
// glob does not reach src/lib or src/modules.
export function badQueryParam(param: string): never {
  throw new AppError(
    `invalid value for ${param}`,
    400,
    "errors.invalidQueryParam",
    { param },
    param,
  );
}

// A count parameter's RANGE: a positive integer, or absent. Lives beside the refusal rather than in
// each service so the six read surfaces cannot disagree about what `limit=0` means, and lives in a
// SERVICE-reachable module rather than in the query parser because MCP and the console's own calls
// reach these services without ever passing through a query string.
//
// Zero is refused, not clamped: `limit=0` is a caller asking for nothing, and answering it with the
// default page is a different question than the one asked. So is a negative — measured before this
// branch, `?page=-5` reached Prisma as a negative `skip` and answered 500.
export function assertUsableCount(
  value: number | undefined,
  param: string,
): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value < 1) badQueryParam(param);
}
