import { AppError } from "@/lib/errors";
import { formatDocumentNumber } from "./format";

// A printed number (prefix and counter as `formatDocumentNumber` prints them, in a tenant) names one
// document and is never issued twice (docs/documents.md, Numbering). Templates can share a prefix,
// and two prefixes can print the same text ("INV-" 10001 and "INV-1" 0001), so the next number is the
// first one, from one above the larger of the template's counter and its prefix's highest, whose
// printed text no document of the tenant carries; a number once printed stays taken. No prefix and
// an empty one print the same, so they are one sequence.

type Db = {
  $executeRaw: (
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<number>;
  $queryRaw: <T>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;
};

// Held for the transaction by everything that takes a number or moves where the next one starts:
// issuance, and setting a template's next number. Per TENANT, not per prefix, because two prefixes
// can print the same text. Taken after the template row lock on both paths, so the order is the same
// everywhere. Numbering is its own short transaction (the render is outside it), so holding the
// tenant's numbering for it costs little.
export async function lockNumbering(db: Db, tenantId: bigint): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`doc-number:${tenantId}`})::bigint)`;
}

// The highest number issued in the tenant under this prefix, 0 when none was.
export async function highestIssuedNumber(
  db: Db,
  tenantId: bigint,
  prefix: string | null,
): Promise<number> {
  const rows = await db.$queryRaw<{ highest: number | null }[]>`
    SELECT MAX("number")::int AS "highest" FROM "issued_documents"
    WHERE "tenant_id" = ${tenantId} AND COALESCE("number_prefix", '') = ${prefix ?? ""}
  `;
  return rows[0]?.highest ?? 0;
}

// The numbers that would print, under `prefix`, a text some document of the tenant already carries,
// whatever prefix it was issued under. Read as printed text, the way the customer sees it.
async function takenUnder(
  db: Db,
  tenantId: bigint,
  prefix: string | null,
): Promise<Set<number>> {
  const p = prefix ?? "";
  const rows = await db.$queryRaw<{ label: string }[]>`
    SELECT "label" FROM (
      SELECT COALESCE("number_prefix", '') || lpad("number"::text, GREATEST(4, length("number"::text)), '0') AS "label"
      FROM "issued_documents"
      WHERE "tenant_id" = ${tenantId} AND "number" IS NOT NULL
    ) printed
    WHERE left("label", ${p.length}) = ${p}
  `;
  const taken = new Set<number>();
  for (const { label } of rows) {
    const rest = label.slice(p.length);
    if (!/^[0-9]+$/.test(rest)) continue;
    const n = Number(rest);
    if (formatDocumentNumber(n, prefix) === label) taken.add(n);
  }
  return taken;
}

// Where a template's numbering continues under `prefix`: past its own counter, past the prefix's
// highest number, and past any number whose printed text is already taken.
export async function nextNumberFor(
  db: Db,
  tenantId: bigint,
  prefix: string | null,
  lastNumber: number,
): Promise<number> {
  const highest = await highestIssuedNumber(db, tenantId, prefix);
  return firstFree(
    Math.max(lastNumber, highest) + 1,
    await takenUnder(db, tenantId, prefix),
  );
}

function firstFree(from: number, taken: Set<number>): number {
  let n = from;
  while (taken.has(n)) n += 1;
  return n;
}

// The counter is an Int column and stores the number before the next one.
export const NEXT_NUMBER_MAX = 2_147_483_647;

export function nextNumberProblem(value: unknown): string | null {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > NEXT_NUMBER_MAX
  ) {
    return `nextNumber: must be a whole number from 1 to ${NEXT_NUMBER_MAX}.`;
  }
  return null;
}

// Why `next` cannot be the next number under `prefix`, or null when it can: refused at or below the
// prefix's highest issued number, and when the text it would print is already a document's. Refused,
// never clamped: the way out of a sequence is a new prefix, which starts its own.
export async function usedNumberProblem(
  db: Db,
  tenantId: bigint,
  prefix: string | null,
  next: number,
): Promise<AppError | null> {
  const asked = formatDocumentNumber(next, prefix);
  const highest = await highestIssuedNumber(db, tenantId, prefix);
  const taken = await takenUnder(db, tenantId, prefix);
  if (next > highest && !taken.has(next)) return null;
  const used = next <= highest ? formatDocumentNumber(highest, prefix) : asked;
  const min = firstFree(Math.max(next, highest + 1), taken);
  const reason = `nextNumber: ${asked} cannot be the next number, because ${used} was already issued. Choose ${min} or above, or change the prefix to start a new sequence.`;
  return new AppError(reason, 409, "errors.documentNumberAlreadyUsed", {
    asked,
    used,
    min: String(min),
  });
}
