// Keyset pagination over `key DESC NULLS LAST, id DESC`, written as a `where`. Prisma's own `cursor`
// option is never used for this: on a multi-column order it sends the query with no LIMIT, so the
// database returns every row after the cursor and the page is cut in the process, which on a list of
// a hundred thousand rows holds the event loop for about a second per page (docs/api-and-fleet.md,
// "Paging"). With the bound in the `where`, `take` reaches the database as a LIMIT.

export type KeysetAnchor = { at: Date | null; id: bigint };

/** The rows that come after `anchor` in the order `key DESC NULLS LAST, id DESC`, as a `where` of W. */
export function afterDescNullsLast<W extends { id?: unknown }>(
  key: keyof W & string,
  anchor: KeysetAnchor,
): W {
  const field = (value: unknown) => ({ [key]: value });
  const before = { id: { lt: anchor.id } };
  const where =
    anchor.at === null
      ? { AND: [field(null), before] }
      : {
          OR: [
            field({ lt: anchor.at }),
            { AND: [field(anchor.at), before] },
            field(null),
          ],
        };
  return where as unknown as W;
}
