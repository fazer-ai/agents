import { describe, expect, test } from "bun:test";
import { MAX_DB_ID } from "@/lib/db-id";
import { formatVaultRef, vaultRefWhere } from "@/modules/vault/service";

// The filter a stored `vault:<id>` reference turns into, and the one promise it makes: a reference
// that is not well formed matches NOTHING. Readers lean on that — a deleted or malformed ref reads
// back null and the feature behaves as if nothing were configured (issue #124).
//
// The row this table exists for is the last one. A ref carrying digits past 2^63-1 CONVERTS, so the
// `try`/`catch` this replaced never ran and the value was handed to Prisma, which answered a bind
// error — the one input that made this function throw instead of matching nothing. Issue #407.
describe("vaultRefWhere", () => {
  test("a well-formed ref filters by that id", () => {
    expect(vaultRefWhere("vault:7")).toEqual({ id: 7n });
    expect(vaultRefWhere(formatVaultRef(MAX_DB_ID))).toEqual({ id: MAX_DB_ID });
  });

  test("anything that is not a vault reference matches nothing", () => {
    for (const ref of ["", "7", "my-key", "vault:", "vaultish:7"]) {
      expect(vaultRefWhere(ref)).toEqual({ id: -1n });
    }
  });

  test("an id BigInt would convert but a column would not matches nothing", () => {
    for (const raw of [
      (MAX_DB_ID + 1n).toString(),
      "99999999999999999999",
      "0x11",
      " 7 ",
      "+7",
      "1e3",
    ]) {
      expect(vaultRefWhere(`vault:${raw}`)).toEqual({ id: -1n });
    }
  });
});
