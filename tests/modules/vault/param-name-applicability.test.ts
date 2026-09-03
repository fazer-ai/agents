import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { credentialCreate } from "@/modules/mcp/write";
import {
  getSecretType,
  getSecretTypeFields,
  PARAM_NAME_KIND_IDS,
  SECRET_TYPE_IDS,
  secretTypeIsManagedBlob,
  secretTypeNeedsParamName,
  secretTypeRefusesParamName,
  secretTypeRequiresBaseUrl,
} from "@/modules/vault/secret-types";
import {
  createPendingVaultEntry,
  createVaultEntry,
  updateVaultEntry,
} from "@/modules/vault/service";

// A `paramName` is only ever read for the kinds whose catalog entry declares `needsParamName`
// (`resolveSecretInjection` takes the name from there, and from nowhere else). Every other kind
// used to STORE the field and then discard it: the write said 200, the console read the name back,
// and the outbound request carried no credential at all. That is issue #488 — an operator wired a
// `generic` credential with `paramName: Authorization`, expecting the bare JWT the API wanted, and
// got a 401 with nothing anywhere saying the field was dead.
//
// The rule is the CATALOG, not a list written here: a kind that declares no use for the field
// refuses it, and a kind this build does not know keeps passing (the same carve-out
// `secretTypeFits` makes, so a row written by an older build stays editable).

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

// OUTSIDE the skipIf, for the same reason value-whitespace.test.ts keeps it there: a superuser probe
// that connects while the app one does not leaves an open pool nothing else closes.
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

// A value and a baseUrl this kind accepts, so the paramName decision is the ONLY thing under test.
// `createVaultEntry` validates value, then baseUrl, then paramName: a kind whose value shape is
// wrong never reaches the rule, and the test would pass on the wrong refusal.
const validValue = (kind: string): string | Record<string, string> => {
  if (secretTypeIsManagedBlob(kind)) return {};
  const fields = getSecretTypeFields(kind);
  if (fields) return Object.fromEntries(fields.map((f) => [f.key, "abc123"]));
  return "abc123TOKEN";
};
const validBaseUrl = (kind: string): string | null =>
  secretTypeRequiresBaseUrl(kind) ? "https://example.invalid" : null;

describe("the catalog is the rule", () => {
  test("exactly the kinds that declare needsParamName take one", () => {
    const takes = SECRET_TYPE_IDS.filter(secretTypeNeedsParamName);
    expect(takes).toEqual(["header", "query", "mcp_env"]);
    expect(PARAM_NAME_KIND_IDS).toEqual(takes);
    // NOTE: The other side of the same count, spelled out so a kind added to the catalog without a
    // decision about this field shows up here instead of silently joining the refusing majority.
    expect(SECRET_TYPE_IDS.filter(secretTypeRefusesParamName).length).toBe(
      SECRET_TYPE_IDS.length - takes.length,
    );
  });

  test("every known kind either takes the field or refuses it, never neither nor both", () => {
    for (const id of SECRET_TYPE_IDS) {
      expect(secretTypeRefusesParamName(id)).toBe(
        !secretTypeNeedsParamName(id),
      );
    }
  });

  test("a kind this build does not know refuses nothing", () => {
    // NOTE: The legacy escape hatch: an entry written by a build whose catalog had a kind this one
    // dropped must stay editable, so the refusal is scoped to kinds the catalog KNOWS.
    expect(getSecretType("kind_from_a_future_build")).toBeNull();
    expect(secretTypeRefusesParamName("kind_from_a_future_build")).toBe(false);
    expect(secretTypeRefusesParamName(null)).toBe(false);
    expect(secretTypeRefusesParamName(undefined)).toBe(false);
  });
});

describe.skipIf(!dbUp)("vault: a param name the kind cannot use", () => {
  const ctx = (): TenantContext => ({
    tenantId,
    userId: null,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "VaultParamName", slug: `vaultpn-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (su && tenantId) {
      await su.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
  });

  // NOTE: The matrix: every kind in the catalog, against the same non-empty param name. Enumerating it
  // instead of sampling is what makes the rule the catalog's — a kind added later is covered the
  // day it is added, on whichever side its own entry puts it.
  for (const kind of SECRET_TYPE_IDS) {
    const takes = secretTypeNeedsParamName(kind);
    test(`createVaultEntry ${takes ? "stores" : "refuses"} a param name on ${kind}`, async () => {
      const input = {
        name: `pn-create-${kind}`,
        value: validValue(kind),
        kind,
        baseUrl: validBaseUrl(kind),
        paramName: "Authorization",
      };
      if (!takes) {
        const e = await refusal(() =>
          createVaultEntry(ctx(), input, undefined, undefined, appDb),
        );
        expect(e.statusCode).toBe(400);
        expect(e.translationKey).toBe("errors.vaultParamNameNotApplicable");
        // NOTE: The refusal is ABOUT the field, by the name the server uses for it, so the console and
        // the MCP caller key on the same string.
        expect(e.field).toBe("paramName");
        // NOTE: The door: the sentence has to say which kinds do take one, or the operator learns only
        // that this one does not.
        for (const id of PARAM_NAME_KIND_IDS) expect(e.message).toContain(id);
        const rows = await suDb.vaultEntry.count({
          where: { tenantId, name: input.name },
        });
        expect(rows).toBe(0);
        return;
      }
      const { id } = await createVaultEntry(
        ctx(),
        input,
        undefined,
        undefined,
        appDb,
      );
      const row = await suDb.vaultEntry.findUnique({
        where: { id },
        select: { paramName: true },
      });
      expect(row?.paramName).toBe("Authorization");
    });
  }

  test("the reporter's config is refused, and the one that works is not", async () => {
    // NOTE: Issue #488 verbatim: a bare JWT that the API wants in `Authorization`, with no Bearer. The
    // kind that does that is `header`; `generic` never injects anything.
    const e = await refusal(() =>
      createVaultEntry(
        ctx(),
        {
          name: "pn-avec-generic",
          value: "eyJhbGciOiJIUzI1NiJ9.e30.sig",
          kind: "generic",
          paramName: "Authorization",
        },
        undefined,
        undefined,
        appDb,
      ),
    );
    expect(e.translationKey).toBe("errors.vaultParamNameNotApplicable");
    expect(e.message).toContain("generic");

    const { id } = await createVaultEntry(
      ctx(),
      {
        name: "pn-avec-header",
        value: "eyJhbGciOiJIUzI1NiJ9.e30.sig",
        kind: "header",
        paramName: "Authorization",
      },
      undefined,
      undefined,
      appDb,
    );
    const row = await suDb.vaultEntry.findUnique({
      where: { id },
      select: { kind: true, paramName: true },
    });
    expect(row).toEqual({ kind: "header", paramName: "Authorization" });
  });

  test("an empty param name still means none, on a kind that cannot use one", async () => {
    // NOTE: A client that always sends the field (the console sends `undefined`, an API caller may not)
    // must not be refused for sending nothing in it: "" has always meant absent here.
    for (const paramName of ["", "   "]) {
      const { id } = await createVaultEntry(
        ctx(),
        {
          name: `pn-empty-${paramName.length}`,
          value: "abc123TOKEN",
          kind: "generic",
          paramName,
        },
        undefined,
        undefined,
        appDb,
      );
      const row = await suDb.vaultEntry.findUnique({
        where: { id },
        select: { paramName: true },
      });
      expect(row?.paramName).toBeNull();
    }
  });

  test("the MCP dry run refuses it too, so the preview cannot promise what apply rejects", async () => {
    // NOTE: `credential_create` defaults to dry_run and answers BEFORE reaching the core, so a rule
    // the core learns later is a rule the preview promises away (padroes: "dry run tem que prever o
    // apply"). Both halves have to refuse, and the apply half must not create a row.
    const p = {
      tenantId,
      userId: null,
      role: "TENANT_ADMIN",
      scopes: ["mcp:write"],
    } as unknown as Parameters<typeof credentialCreate>[0];
    for (const dry_run of [undefined, false]) {
      const r = await credentialCreate(
        p,
        {
          name: "pn-mcp",
          kind: "generic",
          param_name: "Authorization",
          dry_run,
        },
        { base: appDb },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("does not use a param name");
        for (const id of PARAM_NAME_KIND_IDS) expect(r.error).toContain(id);
      }
    }
    expect(
      await suDb.vaultEntry.count({ where: { tenantId, name: "pn-mcp" } }),
    ).toBe(0);
  });

  test("the MCP dry run still previews the config that works", async () => {
    // NOTE: the control for the case above — the guard has to refuse the dead field and nothing
    // else, or it is the preview lying in the other direction.
    const p = {
      tenantId,
      userId: null,
      role: "TENANT_ADMIN",
      scopes: ["mcp:write"],
    } as unknown as Parameters<typeof credentialCreate>[0];
    const r = await credentialCreate(
      p,
      { name: "pn-mcp-ok", kind: "header", param_name: "Authorization" },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.dryRun).toBe(true);
  });

  test("createPendingVaultEntry refuses it too — the surface the MCP tool writes through", async () => {
    // NOTE: `credential_create` is reference-only and never carries a secret, so it is the one path where
    // paramName is the only thing the operator supplies besides name and kind.
    const e = await refusal(() =>
      createPendingVaultEntry(
        ctx(),
        {
          name: "pn-pending",
          kind: "bearer_token",
          paramName: "Authorization",
        },
        appDb,
      ),
    );
    expect(e.statusCode).toBe(400);
    expect(e.translationKey).toBe("errors.vaultParamNameNotApplicable");
    expect(
      await suDb.vaultEntry.count({ where: { tenantId, name: "pn-pending" } }),
    ).toBe(0);
  });

  test("updateVaultEntry refuses it against the STORED kind, which is immutable", async () => {
    const { id } = await createVaultEntry(
      ctx(),
      { name: "pn-update", value: "abc123TOKEN", kind: "generic" },
      undefined,
      undefined,
      appDb,
    );
    const e = await refusal(() =>
      updateVaultEntry(ctx(), id, { paramName: "Authorization" }, appDb),
    );
    expect(e.translationKey).toBe("errors.vaultParamNameNotApplicable");
    const row = await suDb.vaultEntry.findUnique({
      where: { id },
      select: { paramName: true },
    });
    expect(row?.paramName).toBeNull();
  });

  test("a row that already carries a dead param name stays editable", async () => {
    // NOTE: The refusal covers what a write INTRODUCES. Rows written before it exists keep their stray
    // value, and a save that does not touch the field must still go through, or the rule strands
    // exactly the operators who hit the defect.
    const { id } = await createVaultEntry(
      ctx(),
      { name: "pn-legacy", value: "abc123TOKEN", kind: "generic" },
      undefined,
      undefined,
      appDb,
    );
    await suDb.$executeRawUnsafe(
      `UPDATE vault_entries SET param_name = 'Authorization' WHERE id = ${id}`,
    );
    await updateVaultEntry(ctx(), id, { name: "pn-legacy-renamed" }, appDb);
    const row = await suDb.vaultEntry.findUnique({
      where: { id },
      select: { name: true, paramName: true },
    });
    expect(row).toEqual({
      name: "pn-legacy-renamed",
      paramName: "Authorization",
    });
  });

  test("a stored kind this build no longer knows keeps accepting one", async () => {
    // NOTE: `createVaultEntry` refuses an unknown kind up front, so this state is only reachable through
    // a row an older build wrote. Patching it must not be refused by a catalog that has moved on.
    const { id } = await createVaultEntry(
      ctx(),
      { name: "pn-unknown-kind", value: "abc123TOKEN", kind: "generic" },
      undefined,
      undefined,
      appDb,
    );
    await suDb.$executeRawUnsafe(
      `UPDATE vault_entries SET kind = 'kind_from_an_older_build' WHERE id = ${id}`,
    );
    await updateVaultEntry(ctx(), id, { paramName: "X-Legacy" }, appDb);
    const row = await suDb.vaultEntry.findUnique({
      where: { id },
      select: { paramName: true },
    });
    expect(row?.paramName).toBe("X-Legacy");
  });
});
