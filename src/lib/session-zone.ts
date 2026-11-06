// The time zone every database session of this app runs in, pinned at connection time. The schema
// keeps instants in `timestamp without time zone` columns holding UTC, while `now()` and the column
// defaults are `timestamptz`, and Postgres converts between the two in the SESSION's zone: only a UTC
// session makes `col = now()`, `now() - col` and `col <= now()` right (docs/deploy.md, "Session time
// zone"). Imports nothing, so prisma.config.ts can load it before the app's config exists.

export const SESSION_TIME_ZONE = "UTC";

const SESSION_ZONE_OPTION = `-c TimeZone=${SESSION_TIME_ZONE}`;

// The URL's own `options` query parameter, read and rewritten in the query alone. A WHATWG parse of
// the whole URL refuses forms `pg` and the Prisma CLI accept (a socket URL with no host,
// `postgres://u@/db?host=/run/postgresql`), and the query is all either of them reads `options` from.
function urlOptions(connectionString: string): {
  own: string | null;
  withOptions: (options: string) => string;
} {
  const hashAt = connectionString.indexOf("#");
  const beforeHash =
    hashAt < 0 ? connectionString : connectionString.slice(0, hashAt);
  const fragment = hashAt < 0 ? "" : connectionString.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  const base = queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt);
  const params = new URLSearchParams(
    queryAt < 0 ? "" : beforeHash.slice(queryAt + 1),
  );
  return {
    own: params.get("options"),
    withOptions: (options) => {
      params.set("options", options);
      return `${base}?${params.toString()}${fragment}`;
    },
  };
}

// `pg` and the Prisma CLI both read an `options` query parameter of the URL, and in `pg` it replaces
// the config's `options` field, even an empty one. So when the URL carries one, the extra settings
// are appended to it there (a later `-c` wins over an earlier one for the same name); otherwise they
// go in the field. Pass the result's two keys to the pool together.
export function withSessionOptions(
  connectionString: string | undefined,
  extra: readonly string[] = [],
): { connectionString: string | undefined; options: string } {
  const added = [SESSION_ZONE_OPTION, ...extra].join(" ");
  if (!connectionString) return { connectionString, options: added };
  const { own, withOptions } = urlOptions(connectionString);
  if (own === null) return { connectionString, options: added };
  const options = own ? `${own} ${added}` : added;
  return { connectionString: withOptions(options), options };
}

// The same pin for a tool that takes only a URL (the Prisma CLI through prisma.config.ts).
export function withSessionZoneInUrl(connectionString: string): string {
  const { own, withOptions } = urlOptions(connectionString);
  if (own?.endsWith(SESSION_ZONE_OPTION)) return connectionString;
  return withOptions(
    own ? `${own} ${SESSION_ZONE_OPTION}` : SESSION_ZONE_OPTION,
  );
}
