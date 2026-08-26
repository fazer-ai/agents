import { parseDbId } from "@/lib/db-id";
import { badQueryParam } from "@/lib/query-param";
import { parseIsoInstant } from "@/modules/flowlog/settings";

// NOTE: the refusal is raised from `src/lib/query-param.ts`, which the API extractor's input glob
// (`src/api/**/*.ts`) does not reach, so the key is declared HERE — beside the parsers that are the
// reason it exists, rather than in whichever controller happened to introduce it first. A key the
// extractor cannot see is pruned from the catalogue and then missing at runtime, silently.
// translate('errors.invalidQueryParam', 'Invalid value for {{param}}')
export { badQueryParam };

// Query-string filters, parsed the way the delivery ledger settled it in issue #305 / #361 and now
// shared by every read surface (issue #372).
//
// A filter is something the CALLER TYPED, and the three ways a lenient parse can answer are all
// wrong answers to it: dropping it widens the result to everything the tenant has, normalising it
// asks a question nobody asked, and handing `NaN` or an out-of-range id to Prisma answers a caller
// error with a 500. None of the three is distinguishable by the client from a genuinely empty
// result, which is what makes refusing the only answer it can act on.

// PRESENT means the caller asked for this filter, and only ABSENT means they did not. `""` is
// refused exactly like `abc`: it is what a form submits when its input is blank, and reading it as
// "no filter" answers a narrowed request with the whole table.
export function parseQueryInstant(
  s: string | undefined,
  param: string,
): Date | undefined {
  if (s === undefined) return undefined;
  const d = parseIsoInstant(s);
  if (d === null) badQueryParam(param);
  return d;
}

// `parseDbId`, never `BigInt(s)`: BigInt is arbitrary precision, so an id past 2^63-1 parses here
// and is refused by POSTGRES when the query binds it — a 500 for a value that is plainly malformed.
export function parseQueryId(
  s: string | undefined,
  param: string,
): bigint | undefined {
  if (s === undefined) return undefined;
  const id = parseDbId(s);
  if (id === null) badQueryParam(param);
  return id;
}

// Syntax only; the RANGE belongs to whichever service owns the parameter, so a caller that never
// sees a query string (MCP, the console's own service calls) is held to the same bound.
//
// DIGITS, not `Number`, for the same reason `parseDbId` uses a regex: `Number` reads spellings a
// count parameter does not have, and reads two of them as a DIFFERENT NUMBER. Measured on Bun
// 1.4.0 — `1e3` → 1000, `0x10` → 16, `0b11` → 3, `0o17` → 15, `+7` → 7, ` 12 ` → 12, `12.0` → 12,
// and every one of those passes `Number.isInteger`. The one that bites hardest is precision:
// `9007199254740993` comes back as `...992`, so `?before=9007199254740993` would page from a
// message the caller never named. `Number.isSafeInteger` closes that, and the regex closes the
// rest — a sign included, because a count has none and the refusal names the same parameter either
// way.
const DECIMAL = /^\d+$/;

// A free-text or closed-vocabulary filter, where the only unusable spelling is the EMPTY one.
//
// The value itself is not judged here — an unknown `level` reaches the query and answers zero rows,
// which is a correct answer to a filter nothing matches. `""` is the one that is not: every service
// on this surface writes `opts.x ? { x: opts.x } : {}`, so a present-but-empty filter is DROPPED
// and the caller who narrowed the request gets the tenant's whole table back. Whitespace counts as
// empty because `listAgentsPaged` already trims before the same truthiness check.
export function parseQueryText(
  s: string | undefined,
  param: string,
): string | undefined {
  if (s === undefined) return undefined;
  if (s.trim() === "") badQueryParam(param);
  return s;
}

export function parseQueryCount(
  s: string | undefined,
  param: string,
): number | undefined {
  if (s === undefined) return undefined;
  if (!DECIMAL.test(s)) badQueryParam(param);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) badQueryParam(param);
  return n;
}
