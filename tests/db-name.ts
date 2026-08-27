import { createHash } from "node:crypto";
import { basename } from "node:path";

// WHICH DATABASE BELONGS TO WHICH CHECKOUT (issue #417).
//
// `.env` holds ONE test database name, and every checkout on a machine copies that `.env` — the
// worktree onboarding step is literally `cp ../main/.env .env`. So they all share one database, and
// `prisma migrate deploy` only ever adds: a migration applied from one tree stays applied under the
// next. The measurement, and why an additive leftover hides this until a subtractive one arrives,
// is in tests/lib/test-db-identity.test.ts.
//
// Deriving the name here rather than asking each checkout to edit its `.env` is the whole point: an
// obligation spelled out per checkout is one a new checkout is created without, and this one has no
// symptom until it costs a day. For a single clone the derivation is a suffix and nothing else.
//
// The name is NOT the base name plus the directory. It is the base name, the directory, AND a hash
// of the absolute path, because the readable half is neither unique (two clones can both hold a
// `main`, and worktrees here are named after the issue they carry) nor safe to truncate — and it has
// to be truncatable, since Postgres cuts an identifier at 63 bytes without saying so, which would
// hand two long paths the same database through the fix for two paths sharing a database.

const MAX_IDENTIFIER_BYTES = 63;
const HASH_CHARS = 6;
const SUFFIX = "_test";

function identifierSafe(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function testDbNameFor(base: string, checkoutRoot: string): string {
  const root = checkoutRoot.replace(/\/+$/, "");
  const hash = createHash("sha256")
    .update(root)
    .digest("hex")
    .slice(0, HASH_CHARS);
  // IDEMPOTENT, and that is not tidiness. Anything that reads the derived URL out of a running
  // suite and starts a second one from it would otherwise derive AGAIN, landing on a name that
  // names no database — measured the first time this shipped, when the gate's own subprocess test
  // went looking for `..._flaky_tests_febbf7_flaky_tests_febbf7_test`. The hash is over the
  // absolute checkout root, so a name already ending in THIS root's hash was produced here and is
  // already the answer.
  if (base.endsWith(`_${hash}${SUFFIX}`)) return base;
  // The base may or may not already carry the suffix; the derived name always does, because
  // tests/setup.ts refuses to run the destructive suite against a target that does not end in
  // `_test` and scripts/test-db-setup.ts refuses to provision one.
  const stem = identifierSafe(base.replace(/_test$/, ""));
  const fixed = `${stem}__${hash}${SUFFIX}`.length;
  const room = MAX_IDENTIFIER_BYTES - fixed;
  const slug = identifierSafe(basename(root)).slice(0, Math.max(0, room));
  return `${stem}_${slug}_${hash}${SUFFIX}`.replace(/__+/g, "_");
}

// Swaps the database out of a connection URL and leaves everything else — host, port, role,
// password, query parameters — exactly as the `.env` wrote it.
export function withDbName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}
