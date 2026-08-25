import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import {
  createVaultEntry,
  normalizeVaultValue,
  updateVaultEntry,
} from "@/modules/vault/service";

// A credential is PASTED, and a paste out of a provider's panel routinely carries a newline or a
// space. Nothing downstream can recover from it: an HTTP field value has its surrounding whitespace
// stripped before any handler sees it, so the whitespace can be stored on our side and can never
// arrive from the other one. The refusal that follows is byte-identical to a wrong token, so the
// operator retypes the value on the provider's side forever (issue #338).

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;

let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;

if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const appDb = app as PrismaClient;
const suDb = su as PrismaClient;
let tenantId = 0n;

const storedValue = async <T>(id: bigint): Promise<T> => {
  const row = await suDb.vaultEntry.findUnique({
    where: { id },
    select: { secret: true },
  });
  if (!row) throw new Error(`vault entry ${id} not found`);
  return decryptJson<T>(row.secret);
};

// The rule itself, away from the database: what is stored for a value the operator typed. Proving
// the function is not proving the call sites use it — the DB-backed tests below are that half.
describe("normalizeVaultValue", () => {
  const table: Array<[string, string, unknown, unknown]> = [
    ["single value, trailing newline", "generic", "tok\n", "tok"],
    ["single value, trailing space", "asaas", "tok ", "tok"],
    ["single value, leading space", "openai", " tok", "tok"],
    ["single value, both ends", "generic", "\t tok \r\n", "tok"],
    ["single value, already clean", "generic", "tok", "tok"],
    ["single value, inner space kept", "generic", " a b ", "a b"],
    [
      "whitespace only, left empty for validation to refuse",
      "generic",
      " \n",
      "",
    ],
    [
      "named fields, each end trimmed",
      "langfuse",
      { publicKey: "pk \n", secretKey: " sk" },
      { publicKey: "pk", secretKey: "sk" },
    ],
    ["managed blob, untouched", "mcp_oauth", {}, {}],
    ["non-string, untouched for validation to refuse", "generic", 7, 7],
  ];

  for (const [label, kind, input, expected] of table) {
    test(label, () => {
      expect(normalizeVaultValue(kind, input)).toEqual(expected);
    });
  }
});

describe.skipIf(!dbUp)(
  "vault: a stored value carries no surrounding whitespace",
  () => {
    const ctx = (): TenantContext => ({
      tenantId,
      userId: null,
      role: "TENANT_ADMIN",
    });

    beforeAll(async () => {
      if (!su) return;
      const t = await su.tenant.create({
        data: { name: "VaultWhitespace", slug: `vaultws-${process.pid}` },
      });
      tenantId = t.id;
    });

    afterAll(async () => {
      if (su && tenantId) {
        await su.$executeRawUnsafe(
          `DELETE FROM vault_entries WHERE tenant_id = ${tenantId}`,
        );
        await su.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
      await su?.$disconnect();
      await app?.$disconnect();
    });

    test("createVaultEntry stores a single value without the whitespace around it", async () => {
      const { id } = await createVaultEntry(
        ctx(),
        { name: "ws-create", value: "abc123TOKEN\n", kind: "asaas" },
        undefined,
        undefined,
        appDb,
      );
      expect(await storedValue<string>(id)).toBe("abc123TOKEN");
    });

    test("updateVaultEntry stores it trimmed too — the path an operator re-saves through", async () => {
      const { id } = await createVaultEntry(
        ctx(),
        { name: "ws-update", value: "first", kind: "generic" },
        undefined,
        undefined,
        appDb,
      );
      await updateVaultEntry(ctx(), id, { value: "  abc123TOKEN  " }, appDb);
      expect(await storedValue<string>(id)).toBe("abc123TOKEN");
    });

    test("a named-field credential is trimmed per field, on the surface that has no form", async () => {
      const { id } = await createVaultEntry(
        ctx(),
        {
          name: "ws-fields",
          value: { publicKey: "pk-123\n", secretKey: " sk-456 " },
          kind: "langfuse",
          baseUrl: "https://cloud.langfuse.com",
        },
        undefined,
        undefined,
        appDb,
      );
      expect(await storedValue<Record<string, string>>(id)).toEqual({
        publicKey: "pk-123",
        secretKey: "sk-456",
      });
    });

    test("a value that is only whitespace is refused as empty, never stored as one", async () => {
      await expect(
        createVaultEntry(
          ctx(),
          { name: "ws-blank", value: "   \n", kind: "generic" },
          undefined,
          undefined,
          appDb,
        ),
      ).rejects.toThrow(/empty/i);
    });

    test("a named field that is only whitespace is refused, not stored blank", async () => {
      await expect(
        createVaultEntry(
          ctx(),
          {
            name: "ws-blank-field",
            value: { publicKey: "  ", secretKey: "sk" },
            kind: "langfuse",
            baseUrl: "https://cloud.langfuse.com",
          },
          undefined,
          undefined,
          appDb,
        ),
      ).rejects.toThrow(/non-empty/i);
    });
  },
);
