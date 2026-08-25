import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  createVaultEntry,
  testVaultValue,
  updateVaultEntry,
} from "@/modules/vault/service";

// A credential is stored as its exact bytes, and a paste out of a provider's panel routinely carries
// a newline or a space. An HTTP field value has its surrounding whitespace stripped before any
// handler sees it, so a token stored padded can never be matched by the one that arrives, and the
// refusal is byte-identical to a wrong token: the operator retypes the value on the provider's side
// forever (issue #338). The write refuses instead of repairing, so no secret is ever rewritten.

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

// OUTSIDE the skipIf: when the superuser probe connects and the app one does not, `dbUp` is false
// and the suite below never runs its own afterAll, leaving an open pool for the rest of the process.
afterAll(async () => {
  await su?.$disconnect();
  await app?.$disconnect();
});

const appDb = app as PrismaClient;
const suDb = su as PrismaClient;
let tenantId = 0n;

const refusal = async (run: () => Promise<unknown>): Promise<AppError> => {
  try {
    await run();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("expected the write to be refused, and it was not");
};

// Test-on-save answers about the same value the save would store, so the two have to agree. A header
// kind is the trap: fetch strips the padding on the way out, so probing the raw value would report a
// working connection for bytes the write refuses.
describe("test-on-save agrees with the write", () => {
  const neverCalled = (async () => {
    throw new Error(
      "the probe reached the network for a value the write refuses",
    );
  }) as unknown as typeof fetch;

  test("a padded value answers with its own code, without probing", async () => {
    expect(
      await testVaultValue("asaas", "abc123TOKEN\n", null, {
        fetchImpl: neverCalled,
        assertSafe: async (u: string) => new URL(u),
      }),
    ).toEqual({ testable: true, ok: false, code: "surrounding_whitespace" });
  });

  test("a clean value still reaches the probe", async () => {
    let reached = false;
    const fetchImpl = (async () => {
      reached = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await testVaultValue("openai", "sk-secret", null, {
      fetchImpl,
      assertSafe: async (u: string) => new URL(u),
    });
    expect(reached).toBe(true);
    expect(r).toEqual({ testable: true, ok: true });
  });
});

describe.skipIf(!dbUp)(
  "vault: a value that begins or ends in whitespace",
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
    });

    for (const [label, value] of [
      ["a trailing newline", "abc123TOKEN\n"],
      ["a trailing space", "abc123TOKEN "],
      ["a leading space", " abc123TOKEN"],
      ["a tab on both ends", "\tabc123TOKEN\t"],
    ] as const) {
      test(`createVaultEntry refuses ${label}, by name`, async () => {
        const e = await refusal(() =>
          createVaultEntry(
            ctx(),
            { name: `ws-${label.replace(/\s/g, "-")}`, value, kind: "asaas" },
            undefined,
            undefined,
            appDb,
          ),
        );
        expect(e.statusCode).toBe(400);
        expect(e.translationKey).toBe("errors.vaultSecretWhitespace");
      });
    }

    test("a clean value is stored, so the rule refuses the padding and nothing else", async () => {
      const { id } = await createVaultEntry(
        ctx(),
        { name: "ws-clean", value: "abc123TOKEN", kind: "asaas" },
        undefined,
        undefined,
        appDb,
      );
      const row = await suDb.vaultEntry.findUnique({
        where: { id },
        select: { status: true },
      });
      expect(row?.status).toBe("active");
    });

    test("an inner space is kept: the rule is about the ends, not about spaces", async () => {
      const { id } = await createVaultEntry(
        ctx(),
        { name: "ws-inner", value: "two words", kind: "generic" },
        undefined,
        undefined,
        appDb,
      );
      const { decryptJson } = await import("@/api/lib/crypto");
      const row = await suDb.vaultEntry.findUnique({
        where: { id },
        select: { secret: true },
      });
      if (!row) throw new Error("created row not found");
      expect(decryptJson<string>(row.secret)).toBe("two words");
    });

    test("updateVaultEntry refuses it too — the path an operator re-saves through", async () => {
      const { id } = await createVaultEntry(
        ctx(),
        { name: "ws-update", value: "first", kind: "generic" },
        undefined,
        undefined,
        appDb,
      );
      const e = await refusal(() =>
        updateVaultEntry(ctx(), id, { value: "  abc123TOKEN  " }, appDb),
      );
      expect(e.translationKey).toBe("errors.vaultSecretWhitespace");
      const { decryptJson } = await import("@/api/lib/crypto");
      const row = await suDb.vaultEntry.findUnique({
        where: { id },
        select: { secret: true },
      });
      if (!row) throw new Error("row not found");
      expect(decryptJson<string>(row.secret)).toBe("first");
    });

    test("a named field is refused by ITS name, on the surface that has no form", async () => {
      const e = await refusal(() =>
        createVaultEntry(
          ctx(),
          {
            name: "ws-fields",
            value: { publicKey: "pk-123\n", secretKey: "sk-456" },
            kind: "langfuse",
            baseUrl: "https://cloud.langfuse.com",
          },
          undefined,
          undefined,
          appDb,
        ),
      );
      // The SENTENCE has to name it, not only `AppError.field`: the MCP writer sends `e.message` and
      // the console's save path drops the field, so a generic sentence leaves the operator hunting
      // invisible whitespace across two inputs.
      expect(e.translationKey).toBe("errors.vaultFieldWhitespace");
      expect(e.translationParams).toEqual({ field: "publicKey" });
      expect(e.message).toContain("publicKey");
      expect(e.field).toBe("publicKey");
    });
  },
);
