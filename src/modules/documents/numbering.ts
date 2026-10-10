import { AppError } from "@/lib/errors";
import { formatDocumentNumber } from "./format";

// A printed number (the prefix and the counter, within a tenant) names one document, and is never
// issued twice (docs/documents.md, Numbering). The counter lives on the template, but a prefix is not
// the template's alone: two templates can share one, and a prefix can move to one another template
// already used. So the sequence a number belongs to is the tenant's prefix, and the next number is
// one above the larger of the template's own counter and the highest number already issued under that
// prefix by any template, deleted or revoked ones included (a number once printed stays taken).
//
// No prefix and an empty prefix print the same ("0007"), so they are one sequence.

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

// Held for the transaction, by everything that takes a number or moves where the next one starts:
// issuance, and setting a template's next number. Taken AFTER the template row lock on both paths, so
// the order is the same everywhere and two writers on templates sharing a prefix queue here instead of
// each reading the same highest number.
export async function lockNumberSequence(
  db: Db,
  tenantId: bigint,
  prefix: string | null,
): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`doc-number:${tenantId}:${prefix ?? ""}`})::bigint)`;
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

// The same, for every prefix the given templates carry, in one read: the template list shows each
// one's next number.
export async function highestIssuedByPrefix(
  db: Db,
  tenantId: bigint,
): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<{ prefix: string; highest: number }[]>`
    SELECT COALESCE("number_prefix", '') AS "prefix", MAX("number")::int AS "highest"
    FROM "issued_documents"
    WHERE "tenant_id" = ${tenantId} AND "number" IS NOT NULL
    GROUP BY 1
  `;
  return new Map(rows.map((r) => [r.prefix, r.highest]));
}

export function nextNumberOf(lastNumber: number, highest: number): number {
  return Math.max(lastNumber, highest) + 1;
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

// Refused, never clamped: a number at or below one already printed would print it again. The way out
// of a sequence is a new prefix, which starts its own.
export function usedNumberRefusal(
  next: number,
  highest: number,
  prefix: string | null,
): AppError {
  const used = formatDocumentNumber(highest, prefix);
  const asked = formatDocumentNumber(next, prefix);
  const reason = `nextNumber: ${asked} cannot be the next number, because ${used} was already issued under this prefix. Choose a number above ${highest}, or change the prefix to start a new sequence.`;
  return new AppError(reason, 409, "errors.documentNumberAlreadyUsed", {
    asked,
    used,
    min: String(highest + 1),
  });
}
