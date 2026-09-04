import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Glob } from "bun";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { AppError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { credentialCreate } from "@/modules/mcp/write";
import {
  BASE_URL_KIND_IDS,
  getSecretType,
  getSecretTypeFields,
  SECRET_TYPE_IDS,
  secretTypeIsManagedBlob,
  secretTypeNeedsParamName,
  secretTypeRefusesBaseUrl,
  secretTypeRequiresBaseUrl,
  secretTypeSupportsBaseUrl,
} from "@/modules/vault/secret-types";
import {
  createPendingVaultEntry,
  createVaultEntry,
  listVaultInfos,
  tryResolveApiKeyEntry,
  tryResolveVaultEntry,
  updateVaultEntry,
} from "@/modules/vault/service";
import { codeOnly } from "@/tests/utils/source-text";

// A `baseUrl` is only meaningful for the kinds whose catalog entry declares one. Every other kind
// STORED it anyway and the runtime then USED it: the model path reads `credentialBaseUrl ?? mc.baseURL`
// straight off the resolved entry, and so do vision, STT, TTS, the HTTP-tool base and the MCP
// connection URL — none of them asking the kind. So an `openai` credential could carry a base URL
// the console never renders, never shows and cannot edit, and the operator's provider key went to
// that host on the next turn with nothing anywhere saying so. That is issue #504, and the count is
// not a sample: all NINE kinds whose form hides the input accepted one.
//
// The rule is the CATALOG, not a list written here, and a kind this build does not know keeps
// passing — the same carve-out `secretTypeRefusesParamName` makes (#488), so a row written by an
// older build stays editable.

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

// OUTSIDE the skipIf: a superuser probe that connects while the app one does not leaves an open
// pool nothing else closes.
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

// A value and a param name this kind accepts, so the baseUrl decision is the ONLY thing under test.
// `createVaultEntry` validates value, then baseUrl, then paramName — a kind whose value shape is
// wrong never reaches the rule, and the test would pass on the wrong refusal.
const validValue = (kind: string): string | Record<string, string> => {
  if (secretTypeIsManagedBlob(kind)) return {};
  const fields = getSecretTypeFields(kind);
  if (fields) return Object.fromEntries(fields.map((f) => [f.key, "abc123"]));
  return "abc123TOKEN";
};
const validParamName = (kind: string): string | undefined =>
  secretTypeNeedsParamName(kind) ? "X-Probe" : undefined;

const ELSEWHERE = "https://elsewhere.invalid";

describe("nothing writes a base URL past the rule", () => {
  // NOTE: the rule is a helper, and a helper only holds the sites that call it. This counts the
  // vault-entry WRITES in `src/` and pins them to the one file the helper lives in: a fourth write
  // path — an OAuth callback storing a discovered endpoint, an import restoring an export — would
  // set `baseUrl` without ever passing the kind, and no test of the three current boundaries would
  // notice. `codeOnly` because a comment naming `vaultEntry.update` is prose, not a write (#424).
  const WRITE = /\bvaultEntry\.(create|update|updateMany|upsert|createMany)\b/g;

  test("every vaultEntry write lives in the vault service", async () => {
    const files = new Glob("src/**/*.ts").scanSync(".");
    const sites: string[] = [];
    for (const file of files) {
      const code = codeOnly(await Bun.file(file).text());
      for (const _ of code.matchAll(WRITE)) sites.push(file);
    }
    // NOTE: a FLOOR, not an equality: a sweep that silently stops matching (a rename, a Prisma
    // extension, a moved file) reports zero sites and passes as "nothing bypasses the rule".
    expect(sites.length).toBeGreaterThan(3);
    expect([...new Set(sites)]).toEqual(["src/modules/vault/service.ts"]);
  });
});

describe("nothing reads a base URL past the gate", () => {
  // NOTE: the write-side sweep above has a read-side twin, and it exists because the first version of
  // the gate missed two readers: `assemble.ts` and `test-run.ts` build their OWN vault query and copy
  // `baseUrl` straight into `credentialBaseUrl`, so a relative HTTP tool kept dialling the stray host
  // after the resolvers had stopped. A ledger rather than a rule, because two of these files are
  // supposed to read the row raw — the audit projection and the console listing — and the point is
  // that a NEW reader has to be looked at rather than silently join either side.
  const SELECTS = /baseUrl:\s*true/g;
  const LEDGER: Record<string, "gated" | "raw by design"> = {
    "src/api/v1/oauth-mcp.controller.ts": "gated",
    "src/graph/tools/assemble.ts": "gated",
    "src/modules/tool-definitions/test-run.ts": "gated",
    // The four resolvers, the audit projection (the row as it was), `listVaultInfos` (the row as the
    // console shows it) and `readVaultRefFacts` (which hands the tool writer the stored value on
    // purpose — the wiring warning judges what the ROW says, and its own gate is the resolve).
    "src/modules/vault/service.ts": "gated",
  };

  test("every file that selects a vault base URL is in the ledger", async () => {
    const files = new Glob("src/**/*.ts").scanSync(".");
    const found = new Set<string>();
    for (const file of files) {
      const code = codeOnly(await Bun.file(file).text());
      // NOTE: the Chatwoot deployment has a `baseUrl` of its own and is not this column.
      if (!/vaultEntry\./.test(code)) continue;
      for (const _ of code.matchAll(SELECTS)) found.add(file);
    }
    expect([...found].sort()).toEqual(Object.keys(LEDGER).sort());
    // NOTE: a FLOOR, so a sweep that stops matching cannot pass as "nothing reads it".
    expect(found.size).toBeGreaterThan(3);
  });

  // NOTE: the CLIENT half, and it exists because the gate reached the console one reader at a time —
  // the tool editor in one round, the MCP editor in the next. A page that DECIDES with this value
  // (locking a field, enabling Save, accepting a relative template) has to use the dialable one; a
  // page that DISPLAYS the row, or edits the row itself, keeps the raw value on purpose.
  const CLIENT_LEDGER: Record<
    string,
    "gated" | "via the hook" | "raw by design"
  > = {
    // Displays what the picker holds, and hands the raw value to the credential form, which edits
    // the row itself.
    "src/client/components/CredentialPicker.tsx": "raw by design",
    "src/client/lib/vaultCache.ts": "gated",
    "src/client/pages/resources/McpEditModal.tsx": "gated",
    "src/client/pages/resources/ToolEditModal.tsx": "gated",
    // The credential listing: the row as it is, which is the one surface that must keep showing a
    // base URL sitting on a kind whose form never rendered the field.
    "src/client/pages/resources/VaultPanel.tsx": "raw by design",
    // Asks `useVaultBaseUrls`, which is gated above — it never touches an entry itself.
    "src/client/pages/agents/AgentEditorPage.tsx": "via the hook",
  };

  test("every client reader of a vault base URL is in the ledger", async () => {
    const files = new Glob("src/client/**/*.{ts,tsx}").scanSync(".");
    const found = new Set<string>();
    for (const file of files) {
      if (file.endsWith("secretTypes.ts")) continue;
      const code = codeOnly(await Bun.file(file).text());
      if (!/\bVaultEntry\b|loadVault|vault\.get/.test(code)) continue;
      if (/\.baseUrl\b|baseUrl:/.test(code)) found.add(file);
    }
    expect([...found].sort()).toEqual(Object.keys(CLIENT_LEDGER).sort());
    expect(found.size).toBeGreaterThan(4);
  });

  test("every gated client file CALLS the gate", async () => {
    for (const [file, how] of Object.entries(CLIENT_LEDGER)) {
      if (how !== "gated") continue;
      const code = codeOnly(await Bun.file(file).text());
      const calls = [...code.matchAll(/dialableBaseUrl\(/g)].length;
      expect([file, calls > 0]).toEqual([file, true]);
    }
  });

  test("every gated file CALLS the gate, not merely imports it", async () => {
    // NOTE: the call and not the name. Both mutations that put a raw `entry.baseUrl` back left the
    // import untouched, so a file-contains-the-word check passed while the read was ungated again.
    //
    // What this fences is that the gate is present in the file, not that it wraps the right read —
    // the placement is what the resolve-level tests above measure, and these two readers build their
    // own query, so a behavioural test of them means an agent, a tool and a grant apiece.
    for (const [file, how] of Object.entries(LEDGER)) {
      if (how !== "gated") continue;
      const code = codeOnly(await Bun.file(file).text());
      const calls = [...code.matchAll(/dialableBaseUrl\(/g)].length;
      expect([file, calls > 0]).toEqual([file, true]);
    }
  });
});

describe("the catalog is the rule", () => {
  test("exactly the kinds that declare a base URL take one", () => {
    const takes = SECRET_TYPE_IDS.filter(secretTypeSupportsBaseUrl);
    expect(takes).toEqual([
      "generic",
      "bearer_token",
      "header",
      "basic_auth",
      "query",
      "openai_compatible",
      "chatwoot_api_token",
      "mcp_oauth",
      "langfuse",
    ]);
    expect(BASE_URL_KIND_IDS).toEqual(takes);
    // NOTE: The other side of the same count, spelled out so a kind added to the catalog without a
    // decision about this field shows up here instead of silently joining the refusing majority.
    expect(SECRET_TYPE_IDS.filter(secretTypeRefusesBaseUrl).length).toBe(
      SECRET_TYPE_IDS.length - takes.length,
    );
  });

  test("required implies supported, for every kind, by construction", () => {
    // NOTE: The state a supports/requires PAIR would let someone write — required and not
    // supported — which the write boundary would read as "must have one" and "must not have one" at
    // the same time, refusing every create of that kind. One field cannot express it.
    for (const id of SECRET_TYPE_IDS) {
      if (secretTypeRequiresBaseUrl(id))
        expect(secretTypeSupportsBaseUrl(id)).toBe(true);
      expect(secretTypeRefusesBaseUrl(id)).toBe(!secretTypeSupportsBaseUrl(id));
    }
  });

  test("a kind this build does not know refuses nothing", () => {
    expect(getSecretType("kind_from_a_future_build")).toBeNull();
    expect(secretTypeRefusesBaseUrl("kind_from_a_future_build")).toBe(false);
    expect(secretTypeRefusesBaseUrl(null)).toBe(false);
    expect(secretTypeRefusesBaseUrl(undefined)).toBe(false);
  });
});

describe.skipIf(!dbUp)("vault: a base URL the kind cannot use", () => {
  const ctx = (): TenantContext => ({
    tenantId,
    userId: null,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "VaultBaseUrl", slug: `vaultbu-${process.pid}` },
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

  // NOTE: The matrix: every kind in the catalog, against the same base URL. Enumerating it instead
  // of sampling is what makes the rule the catalog's — a kind added later is covered the day it is
  // added, on whichever side its own entry puts it.
  for (const kind of SECRET_TYPE_IDS) {
    const takes = secretTypeSupportsBaseUrl(kind);
    test(`createVaultEntry ${takes ? "stores" : "refuses"} a base URL on ${kind}`, async () => {
      const input = {
        name: `bu-create-${kind}`,
        value: validValue(kind),
        kind,
        baseUrl: ELSEWHERE,
        paramName: validParamName(kind),
      };
      if (!takes) {
        const e = await refusal(() =>
          createVaultEntry(ctx(), input, undefined, undefined, appDb),
        );
        expect(e.statusCode).toBe(400);
        expect(e.translationKey).toBe("errors.vaultBaseUrlNotApplicable");
        // NOTE: The refusal is ABOUT the field, by the name the server uses for it, so the console
        // and the MCP caller key on the same string.
        expect(e.field).toBe("baseUrl");
        // NOTE: The door: the sentence has to say which kinds do take one, or the operator learns
        // only that this one does not.
        for (const id of BASE_URL_KIND_IDS) expect(e.message).toContain(id);
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
        select: { baseUrl: true },
      });
      expect(row?.baseUrl).toBe(ELSEWHERE);
    });
  }

  test("the redirect the issue describes is refused, and the kind that exists for it is not", async () => {
    // NOTE: Issue #504 verbatim, on the sharpest of the nine: an `openai` credential carrying a base
    // URL the console never shows. `prepare.ts` hands `credentialBaseUrl ?? mc.baseURL` to the model
    // client, so every turn's API key went to that host. The kind that legitimately does this is
    // `openai_compatible`, which is why the refusal names it.
    const e = await refusal(() =>
      createVaultEntry(
        ctx(),
        {
          name: "bu-openai-redirect",
          value: "sk-abc123",
          kind: "openai",
          baseUrl: ELSEWHERE,
        },
        undefined,
        undefined,
        appDb,
      ),
    );
    expect(e.translationKey).toBe("errors.vaultBaseUrlNotApplicable");
    expect(e.message).toContain("openai_compatible");

    const { id } = await createVaultEntry(
      ctx(),
      {
        name: "bu-openai-compatible",
        value: "sk-abc123",
        kind: "openai_compatible",
        baseUrl: ELSEWHERE,
      },
      undefined,
      undefined,
      appDb,
    );
    const row = await suDb.vaultEntry.findUnique({
      where: { id },
      select: { kind: true, baseUrl: true },
    });
    expect(row).toEqual({ kind: "openai_compatible", baseUrl: ELSEWHERE });
  });

  test("an empty base URL still means none, on a kind that cannot use one", async () => {
    // NOTE: A client that always sends the field must not be refused for sending nothing in it: the
    // console submits `baseUrl: null` on every kind whose form has no input, and "" reaches
    // `validateBaseUrl` as the empty string it already returned before this rule existed.
    for (const baseUrl of [null, "", "   "]) {
      const { id } = await createVaultEntry(
        ctx(),
        {
          name: `bu-empty-${String(baseUrl).length}`,
          value: "sk-abc123",
          kind: "openai",
          baseUrl,
        },
        undefined,
        undefined,
        appDb,
      );
      const row = await suDb.vaultEntry.findUnique({
        where: { id },
        select: { baseUrl: true },
      });
      expect(row?.baseUrl).toBeNull();
    }
  });

  test("the MCP dry run refuses it too, so the preview cannot promise what apply rejects", async () => {
    // NOTE: `credential_create` defaults to dry_run and answers BEFORE reaching the core, so a rule
    // the core learns later is a rule the preview promises away. Both halves have to refuse, and the
    // apply half must not create a row.
    const p = {
      tenantId,
      userId: null,
      role: "TENANT_ADMIN",
      scopes: ["mcp:write"],
    } as unknown as Parameters<typeof credentialCreate>[0];
    for (const dry_run of [undefined, false]) {
      const r = await credentialCreate(
        p,
        { name: "bu-mcp", kind: "gemini", base_url: ELSEWHERE, dry_run },
        { base: appDb },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("does not use a base URL");
        for (const id of BASE_URL_KIND_IDS) expect(r.error).toContain(id);
      }
    }
    expect(
      await suDb.vaultEntry.count({ where: { tenantId, name: "bu-mcp" } }),
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
      { name: "bu-mcp-ok", kind: "openai_compatible", base_url: ELSEWHERE },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.dryRun).toBe(true);
  });

  test("createPendingVaultEntry refuses it too — the surface the MCP tool writes through", async () => {
    const e = await refusal(() =>
      createPendingVaultEntry(
        ctx(),
        { name: "bu-pending", kind: "anthropic", baseUrl: ELSEWHERE },
        appDb,
      ),
    );
    expect(e.statusCode).toBe(400);
    expect(e.translationKey).toBe("errors.vaultBaseUrlNotApplicable");
    expect(
      await suDb.vaultEntry.count({ where: { tenantId, name: "bu-pending" } }),
    ).toBe(0);
  });

  test("updateVaultEntry refuses it against the STORED kind, which is immutable", async () => {
    const { id } = await createVaultEntry(
      ctx(),
      { name: "bu-update", value: "sk-abc123", kind: "openai" },
      undefined,
      undefined,
      appDb,
    );
    const e = await refusal(() =>
      updateVaultEntry(ctx(), id, { baseUrl: ELSEWHERE }, appDb),
    );
    expect(e.translationKey).toBe("errors.vaultBaseUrlNotApplicable");
    const row = await suDb.vaultEntry.findUnique({
      where: { id },
      select: { baseUrl: true },
    });
    expect(row?.baseUrl).toBeNull();
  });

  test("a row that already carries a dead base URL is KEPT and never dialled", async () => {
    // NOTE: the refusal covers what a write introduces, and covering only that would leave every
    // install the rule was written for still redirecting — the model path, vision, STT, TTS, the
    // HTTP-tool base and the MCP connection URL read this field off the RESOLVED entry without
    // asking the kind. So the resolve is gated too.
    //
    // The row is not touched, and that half is the point: `listVaultInfos` still reports the stored
    // value, so the console can show an operator what is sitting in a field its own form never
    // rendered. What the runtime dials is `null`.
    const row = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "bu-dialled",
        secret: encryptJson("sk-legacy"),
        kind: "openai",
        baseUrl: ELSEWHERE,
      },
      select: { id: true },
    });
    const ref = `vault:${row.id}`;
    const resolved = await runScopedOn(appDb, ctx(), (db) =>
      tryResolveApiKeyEntry(db, ref),
    );
    expect(resolved.state).toBe("ok");
    if (resolved.state === "ok") expect(resolved.baseUrl).toBeNull();
    const entry = await runScopedOn(appDb, ctx(), (db) =>
      tryResolveVaultEntry(db, ref),
    );
    expect(entry?.baseUrl).toBeNull();
    // NOTE: and the listing — the surface an operator reads — still shows it.
    const listed = await runScopedOn(appDb, ctx(), (db) => listVaultInfos(db));
    expect(listed.find((e) => e.name === "bu-dialled")?.baseUrl).toBe(
      ELSEWHERE,
    );
    expect(
      (
        await suDb.vaultEntry.findUnique({
          where: { id: row.id },
          select: { baseUrl: true },
        })
      )?.baseUrl,
    ).toBe(ELSEWHERE);
  });

  test("a kind that DOES take one keeps dialling it", async () => {
    // NOTE: the control for the gate above. It has to cut the dead field and nothing else.
    const { id } = await createVaultEntry(
      ctx(),
      {
        name: "bu-dialled-ok",
        value: "sk-abc123",
        kind: "openai_compatible",
        baseUrl: ELSEWHERE,
      },
      undefined,
      undefined,
      appDb,
    );
    const resolved = await runScopedOn(appDb, ctx(), (db) =>
      tryResolveApiKeyEntry(db, `vault:${id}`),
    );
    expect(resolved.state).toBe("ok");
    if (resolved.state === "ok") expect(resolved.baseUrl).toBe(ELSEWHERE);
  });

  test("a row that already carries a dead base URL stays editable, and can be cleared", async () => {
    // NOTE: The refusal covers what a write INTRODUCES. Rows written before it exists keep their
    // stray value, and a save that does not touch the field must still go through, or the rule
    // strands exactly the entries it was written for. Clearing it has to work for the same reason:
    // it is the only repair a caller has.
    const row = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "bu-legacy",
        secret: "x",
        kind: "gemini",
        baseUrl: ELSEWHERE,
      },
      select: { id: true },
    });
    await updateVaultEntry(ctx(), row.id, { name: "bu-legacy-renamed" }, appDb);
    const kept = await suDb.vaultEntry.findUnique({
      where: { id: row.id },
      select: { name: true, baseUrl: true },
    });
    expect(kept).toEqual({ name: "bu-legacy-renamed", baseUrl: ELSEWHERE });

    await updateVaultEntry(ctx(), row.id, { baseUrl: null }, appDb);
    const cleared = await suDb.vaultEntry.findUnique({
      where: { id: row.id },
      select: { baseUrl: true },
    });
    expect(cleared?.baseUrl).toBeNull();
  });
});
