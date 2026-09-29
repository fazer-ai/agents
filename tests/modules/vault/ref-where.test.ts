import { describe, expect, test } from "bun:test";
import { MAX_DB_ID } from "@/lib/db-id";
import {
  formatVaultRef,
  readVaultRefId,
  vaultRefWhere,
} from "@/modules/vault/service";

// The id a STORED ref names, and the two rules that are deliberately not the same one.
//
// `requireVaultRef` refuses all but the canonical spelling on the way IN. Reading is lenient on
// purpose (`canonicalVaultRef` in src/client/lib/credentialRef.ts: `vault:0007`, `vault: 7` and
// `vault:7` are one entry): refs predate the write rule, and a strict read would switch a working
// credential off silently. Digits past 2^63-1 still CONVERT, so a `try`/`catch` around the
// conversion never fires and Prisma answers a bind error instead of "no such entry": lenient about
// SPELLING, bounded by RANGE.
describe("readVaultRefId", () => {
  test("the canonical spelling reads back", () => {
    expect(readVaultRefId("vault:7")).toBe(7n);
    expect(readVaultRefId(formatVaultRef(MAX_DB_ID))).toBe(MAX_DB_ID);
  });

  // The compatibility half. Each of these is a ref an installation may already hold, and each names
  // the same entry as `vault:7` to `canonicalVaultRef` — so a resolver that answered null here
  // would disagree with the picker and the health panel about whether the credential exists.
  test("the lenient spellings a stored ref may carry still resolve", () => {
    for (const raw of ["0007", " 7 ", "+7", "0x7", "0b111", "0o7", "7\n"]) {
      expect(readVaultRefId(`vault:${raw}`)).toBe(7n);
    }
  });

  test("anything that is not a vault reference names no entry", () => {
    for (const ref of [
      "",
      "7",
      "my-key",
      "vault:",
      "vault:abc",
      "vaultish:7",
    ]) {
      expect(readVaultRefId(ref)).toBeNull();
    }
  });

  test("an id past what the column holds names no entry", () => {
    for (const raw of [
      (MAX_DB_ID + 1n).toString(),
      "99999999999999999999",
      "-7",
      "0x8000000000000000",
    ]) {
      expect(readVaultRefId(`vault:${raw}`)).toBeNull();
    }
  });
});

// The filter that helper turns into, and the one promise it makes to its callers: a ref naming no
// entry matches NOTHING, rather than throwing or matching something else.
describe("vaultRefWhere", () => {
  test("a ref that names an entry filters by that id, lenient spellings included", () => {
    expect(vaultRefWhere("vault:7")).toEqual({ id: 7n });
    expect(vaultRefWhere("vault: 7 ")).toEqual({ id: 7n });
  });

  test("a ref that names no entry matches nothing", () => {
    for (const ref of ["", "my-key", "vault:abc", `vault:${MAX_DB_ID + 1n}`]) {
      expect(vaultRefWhere(ref)).toEqual({ id: -1n });
    }
  });
});
