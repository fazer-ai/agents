import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Which test database belongs to which checkout. Every checkout copies the same `.env`, and `prisma
// migrate deploy` only adds, so a shared database keeps one tree's migrations under the next. The
// name is derived here rather than edited per checkout because a new checkout is created without
// that obligation. It carries the base name, the directory AND a hash of the absolute path: the
// readable half is neither unique nor safe to truncate, and Postgres silently cuts identifiers at 63
// bytes, which would hand two long paths the same database.

// A `file://` URL PERCENT-ENCODES the path and no filesystem call decodes it, so a checkout under a
// directory with a space would get ENOENT on every read. `fileURLToPath` decodes; `resolve` makes the
// string the same with or without a trailing separator, since the hash below is over it.
export function checkoutRootFrom(importMetaUrl: string, up: string): string {
  return resolve(fileURLToPath(importMetaUrl), "..", up);
}

const MAX_IDENTIFIER_BYTES = 63;
const HASH_CHARS = 6;
const SUFFIX = "_test";

function identifierSafe(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_CHARS);
}

export function testDbNameFor(base: string, checkoutRoot: string): string {
  const root = checkoutRoot.replace(/\/+$/, "");
  const hash = shortHash(root);
  // NOTE: IDEMPOTENT, because a second suite started from a running suite's derived URL would
  // otherwise derive AGAIN onto a name no database has. The match is on the whole tail
  // (`_<6 hex base><6 hex root>_test`, a shape only this function produces), so a hand-written name
  // ending in the right six characters is still derived rather than shared between checkouts.
  if (new RegExp(`_[0-9a-f]{${HASH_CHARS}}${hash}${SUFFIX}$`).test(base)) {
    return base;
  }
  // The derived name always ends in `_test`: tests/setup.ts and scripts/test-db-setup.ts refuse
  // any target that does not. BOTH halves are hashed (hashing only the checkout merged every base of
  // a long-named checkout into one database), over the ORIGINAL base, since `identifierSafe` maps
  // `foo-bar_test` and `foo_bar_test` to the same text. The checkout's hash stays SEPARATE and last:
  // it is recomputable from the root alone, which the idempotence check above relies on.
  const rawStem = base.replace(/_test$/, "");
  const stemText = identifierSafe(rawStem);
  const tail = `_${shortHash(rawStem)}${hash}${SUFFIX}`;
  const room = MAX_IDENTIFIER_BYTES - tail.length;
  // The base first: it is what tells two databases of the SAME checkout apart, so it is the half
  // whose truncation costs the most to a reader.
  const stem = stemText.slice(0, Math.max(0, room - 1));
  const slug = identifierSafe(basename(root)).slice(
    0,
    Math.max(0, room - stem.length - (stem.length > 0 ? 1 : 0)),
  );
  return `${stem}_${slug}${tail}`.replace(/__+/g, "_").replace(/^_+/, "");
}

// Swaps the database out of a connection URL and leaves everything else (host, port, role,
// password, query parameters) exactly as the `.env` wrote it.
export function withDbName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}
