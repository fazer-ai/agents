// The time zone every database session of this app runs in, pinned at connection time. The schema
// keeps instants in `timestamp without time zone` columns holding UTC, while `now()` and the column
// defaults are `timestamptz`, and Postgres converts between the two in the SESSION's zone: only a UTC
// session makes `col = now()`, `now() - col` and `col <= now()` right (docs/deploy.md, "Session time
// zone"). Imports nothing, so prisma.config.ts can load it before the app's config exists.

export const SESSION_TIME_ZONE = "UTC";

const SESSION_ZONE_OPTION = `-c TimeZone=${SESSION_TIME_ZONE}`;

// `pg` and the Prisma CLI both read an `options` query parameter of the URL, and in `pg` it replaces
// the config's `options` field, even an empty one. So when the URL carries one, the extra settings
// are appended to it there (a later `-c` wins over an earlier one for the same name); otherwise they
// go in the field. Pass the result's two keys to the pool together.
export function withSessionOptions(
  connectionString: string | undefined,
  extra: readonly string[] = [],
): { connectionString: string | undefined; options: string } {
  const added = [SESSION_ZONE_OPTION, ...extra].join(" ");
  const url = connectionString ? URL.parse(connectionString) : null;
  const own = url?.searchParams.get("options");
  const options = own ? `${own} ${added}` : added;
  if (!url || own === null || own === undefined)
    return { connectionString, options };
  url.searchParams.set("options", options);
  return { connectionString: url.toString(), options };
}

// The same pin for a tool that takes only a URL (the Prisma CLI through prisma.config.ts).
export function withSessionZoneInUrl(connectionString: string): string {
  const url = URL.parse(connectionString);
  if (!url) return connectionString;
  if (url.searchParams.get("options")?.endsWith(SESSION_ZONE_OPTION))
    return connectionString;
  url.searchParams.set("options", withSessionOptions(connectionString).options);
  return url.toString();
}
