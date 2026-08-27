import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// A `file://` URL PERCENT-ENCODES what a path may hold, and no filesystem call decodes it back: a
// checkout under a directory with a space reads its own root as `.../my%20tree`, and every
// `readdirSync` under it is ENOENT. Measured before this existed, against a fixture directory whose
// name held a space: `ENOENT: no such file or directory, scandir
// '/private/tmp/tree%20with%20space/sub/prisma/migrations'` — which would abort every
// database-backed run, not degrade one. `fileURLToPath` is the decode; `resolve` is what makes the
// result the same string whether the caller's URL ended in a separator or not, which matters
// because the hash below is over this exact string.
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
  // IDEMPOTENT, and that is not tidiness. Anything that reads the derived URL out of a running
  // suite and starts a second one from it would otherwise derive AGAIN, landing on a name that
  // names no database — measured the first time this shipped, when the gate's own subprocess test
  // went looking for `..._flaky_tests_febbf7_flaky_tests_febbf7_test`. The hash is over the
  // absolute checkout root, so a name already ending in THIS root's hash was produced here and is
  // already the answer.
  // The whole tail, not just this root's hash: `_<6 hex base><6 hex root>_test` is the shape only
  // this function produces, so a hand-written name that happens to end in the right six characters
  // is not mistaken for one of ours — and being mistaken would mean NOT deriving, which is two
  // checkouts sharing a database.
  if (new RegExp(`_[0-9a-f]{${HASH_CHARS}}${hash}${SUFFIX}$`).test(base)) {
    return base;
  }
  // The base may or may not already carry the suffix; the derived name always does, because
  // tests/setup.ts refuses to run the destructive suite against a target that does not end in
  // `_test` and scripts/test-db-setup.ts refuses to provision one.
  //
  // BOTH halves are hashed, and the readable text is readability alone. The first version hashed
  // only the checkout and let the two readable halves fight over the remaining room, which merged
  // every base of a long-named checkout into ONE database: measured with a 52-character checkout,
  // `secretaria_v4_test`, `fzgate417_test` and `fzsetup417_test` all derived to
  // `wwww…_79bdb0_test`. Truncation may cost a name its readability; it may never cost it its
  // identity.
  //
  // The checkout's hash stays SEPARATE and last, because it is the one part recomputable from the
  // root alone, which is what lets the idempotence check above tell a name derived HERE from one
  // derived somewhere else without knowing the base it came from.
  // The hash is over the ORIGINAL base, and the normalized text is for reading only. Hashing the
  // normalized form makes the identity as lossy as the display: `identifierSafe` folds every run of
  // non-alphanumerics to one underscore, so `foo-bar_test` and `foo_bar_test` are two legal, distinct
  // databases that both derived to `foo_bar_x_4928ca5cf696_test` — measured — and a destructive
  // command aimed at one would reach the other.
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

// Swaps the database out of a connection URL and leaves everything else — host, port, role,
// password, query parameters — exactly as the `.env` wrote it.
export function withDbName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}
