import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ToolMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildHttpTool, type HttpToolDef } from "@/graph/tools/http";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { toolCreate, toolUpdate } from "@/modules/mcp/write-agents";
import {
  toolUsesSecretPlaceholder,
  unusedCredentialWarning,
} from "@/modules/tool-definitions/credential-wiring";
import type { ToolShapePatch } from "@/modules/tool-definitions/normalize";
import { SECRET_TYPE_IDS } from "@/modules/vault/secret-types";
import { createVaultEntry } from "@/modules/vault/service";

// Issue #504, second half: an HTTP tool can reference a `generic` credential while nothing in its
// templates interpolates {{secret}}. Nothing refuses it and nothing should — a tool may hold a
// reference it has not wired yet — but the request then goes out UNAUTHENTICATED and the upstream
// answers 401/403, which reads as a bad credential rather than one that was never sent.
//
// The warning is only as good as its site list, so the list is not asserted against a list written
// here: each site is placed in a REAL tool and executed, and the same placement is put to the
// scanner. A site the runtime interpolates and the scanner misses shows up as a secret in the
// captured request with `toolUsesSecretPlaceholder` saying false.

const PUBLIC = "8.8.8.8";
const SECRET = "SECRET123";

interface Captured {
  url?: string;
  init?: RequestInit;
}

const stubFetch = (captured: Captured) =>
  (async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return new Response('{"ok":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

function def(over: Partial<HttpToolDef> = {}): HttpToolDef {
  return {
    name: "thing",
    method: "GET",
    urlTemplate: `https://${PUBLIC}/v1/thing`,
    allowedHosts: [PUBLIC],
    headers: {},
    inputSchema: {},
    credentialRef: "vault:1",
    credentialKind: "generic",
    ...over,
  };
}

// What the request actually carried, as one string: the URL, every header value and the body. The
// question is only ever "did the secret leave", so where it left is not part of the assertion.
async function sent(over: Partial<HttpToolDef>): Promise<string> {
  const captured: Captured = {};
  const tool = buildHttpTool(def(over), {
    resolveCredential: async () => SECRET,
    fetchImpl: stubFetch(captured),
  });
  (await tool.invoke({})) as unknown as ToolMessage;
  const headers = captured.init?.headers as Record<string, string> | undefined;
  return [
    captured.url ?? "",
    ...Object.values(headers ?? {}),
    String(captured.init?.body ?? ""),
  ].join(" | ");
}

// Each of the five sites the runtime interpolates {{secret}} into, as a tool definition the executor
// accepts and as the shapes a write would store. The two halves are the SAME placement, which is
// what makes this a fence and not two independent lists.
const SITES: {
  site: string;
  def: Partial<HttpToolDef>;
  shapes: ToolShapePatch;
}[] = [
  {
    site: "url_template",
    def: { urlTemplate: `https://${PUBLIC}/v1/{{secret}}` },
    shapes: { urlTemplate: `https://${PUBLIC}/v1/{{secret}}` },
  },
  {
    site: "headers",
    def: { headers: { "X-Auth": "{{secret}}" } },
    shapes: { headers: { "X-Auth": "{{secret}}" } },
  },
  {
    site: "query",
    def: { query: { token: "{{secret}}" } },
    shapes: { query: { token: "{{secret}}" } },
  },
  {
    site: "body.raw",
    def: {
      method: "POST",
      body: { mode: "raw", raw: '{"t":"{{secret}}"}' },
    },
    shapes: { body: { mode: "raw", raw: '{"t":"{{secret}}"}' } },
  },
  {
    site: "body.kv",
    def: {
      method: "POST",
      body: { mode: "kv", rows: [{ key: "t", value: "{{secret}}" }] },
    },
    shapes: {
      body: { mode: "kv", rows: [{ key: "t", value: "{{secret}}" }] },
    },
  },
  {
    site: "a fixed input field",
    def: {
      urlTemplate: `https://${PUBLIC}/v1/{{tok}}`,
      inputSchema: {
        tok: { type: "string", source: "fixed", value: "{{secret}}" },
      },
    },
    shapes: {
      urlTemplate: `https://${PUBLIC}/v1/{{tok}}`,
      inputSchema: {
        tok: { type: "string", source: "fixed", value: "{{secret}}" },
      },
    },
  },
];

describe("the scanner covers exactly what the runtime interpolates", () => {
  for (const { site, def: over, shapes } of SITES) {
    test(`{{secret}} in ${site} is sent, and counts as wired`, async () => {
      expect(await sent(over)).toContain(SECRET);
      expect(toolUsesSecretPlaceholder(shapes)).toBe(true);
      expect(unusedCredentialWarning("generic", shapes)).toBeNull();
    });
  }

  test("the same tool with no placeholder sends nothing, and is warned about", async () => {
    // NOTE: the control the six above need. Without it they would all pass on a scanner that
    // answered true unconditionally, and the executor half would pass on a runtime that leaked the
    // credential everywhere.
    const shapes: ToolShapePatch = {
      urlTemplate: `https://${PUBLIC}/v1/thing`,
      headers: { "X-Other": "constant" },
      query: { page: "1" },
      inputSchema: { note: { type: "string" } },
    };
    expect(
      await sent({
        headers: { "X-Other": "constant" },
        query: { page: "1" },
        inputSchema: { note: { type: "string" } },
      }),
    ).not.toContain(SECRET);
    expect(toolUsesSecretPlaceholder(shapes)).toBe(false);
    expect(unusedCredentialWarning("generic", shapes)).toContain("never sent");
  });

  test("{{secret}} in an AI field's value is not interpolated, and does not count", async () => {
    // NOTE: `buildHttpTool` reads `source === "fixed" ? "fixed" : "ai"` and precomputes only the
    // fixed values with the secret in scope. A scanner that took any field `value` would call this
    // tool wired, and the operator would get no warning about a request that carries nothing.
    const inputSchema = {
      tok: { type: "string", value: "{{secret}}" },
    };
    const out = await sent({
      urlTemplate: `https://${PUBLIC}/v1/thing`,
      inputSchema,
    });
    expect(out).not.toContain(SECRET);
    expect(
      toolUsesSecretPlaceholder({
        urlTemplate: `https://${PUBLIC}/v1/thing`,
        inputSchema,
      }),
    ).toBe(false);
  });

  test("the spacing the runtime accepts is the spacing the scanner accepts", async () => {
    // NOTE: the runtime's PLACEHOLDER takes whitespace inside the braces. A scanner matching only
    // the tight spelling would warn about a tool that works.
    const headers = { "X-Auth": "{{ secret }}" };
    expect(await sent({ headers })).toContain(SECRET);
    expect(toolUsesSecretPlaceholder({ headers })).toBe(true);
  });
});

describe("which kinds the warning is about", () => {
  const bare: ToolShapePatch = { urlTemplate: `https://${PUBLIC}/v1/thing` };

  test("only the kinds that auto-inject nothing and may still be sent", () => {
    const warned = SECRET_TYPE_IDS.filter(
      (id) => unusedCredentialWarning(id, bare) !== null,
    );
    // NOTE: `generic` is the whole point — the escape hatch whose contract IS that the operator
    // writes {{secret}} by hand, so it is the one kind where attached and sent come apart silently.
    // `mcp_env` and `langfuse` also inject nothing, and are deliberately NOT warned about: their
    // catalog entry says the value must never travel outbound, so "write {{secret}} where the API
    // expects it" would be advice to mail an stdio token to a third party. That they can be attached
    // to an HTTP tool at all is a separate defect, and a refusal rather than a warning.
    expect(warned).toEqual(["generic"]);
  });

  test("a kind this build does not know is the legacy generic, and is warned about", () => {
    expect(unusedCredentialWarning(null, bare)).not.toBeNull();
    expect(
      unusedCredentialWarning("kind_from_a_future_build", bare),
    ).not.toBeNull();
  });

  test("the sentence names a way out, and the ways out come from the catalog", () => {
    const w = unusedCredentialWarning("generic", bare) ?? "";
    for (const id of ["bearer_token", "header", "basic_auth", "query"]) {
      expect(w).toContain(id);
    }
    // NOTE: a service kind is not an alternative for an arbitrary HTTP tool — it is a different API,
    // with a header name fixed to that vendor.
    expect(w).not.toContain("anthropic");
  });
});

// ── the write surface ──

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

afterAll(async () => {
  await su?.$disconnect();
  await app?.$disconnect();
});

const appDb = app as PrismaClient;

describe.skipIf(!dbUp)("tool_create / tool_update say so", () => {
  let tenantId = 0n;
  let genericRef = "";
  let bearerRef = "";
  let n = 0;

  const principal = (): VerifiedToken =>
    ({
      userId: null,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
      clientId: "c",
      jti: "j",
    }) as unknown as VerifiedToken;

  const warningsOf = (r: Awaited<ReturnType<typeof toolCreate>>): string[] =>
    r.ok ? ((r.data as { warnings?: string[] }).warnings ?? []) : [];
  const wiringWarning = (r: Awaited<ReturnType<typeof toolCreate>>): string[] =>
    warningsOf(r).filter((w) => w.includes("never sent"));

  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "ToolWiring", slug: `toolwiring-${process.pid}` },
    });
    tenantId = t.id;
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    genericRef = (
      await createVaultEntry(
        ctx,
        { name: "wiring-generic", value: "abc123TOKEN", kind: "generic" },
        undefined,
        undefined,
        appDb,
      )
    ).ref;
    bearerRef = (
      await createVaultEntry(
        ctx,
        { name: "wiring-bearer", value: "abc123TOKEN", kind: "bearer_token" },
        undefined,
        undefined,
        appDb,
      )
    ).ref;
  });

  afterAll(async () => {
    if (su && tenantId) {
      await su.$executeRawUnsafe(
        `DELETE FROM tool_definitions WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM vault_entries WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
  });

  const create = (over: Record<string, unknown> = {}) => {
    n += 1;
    return toolCreate(
      principal(),
      {
        name: `wiring_${n}`,
        url_template: `https://${PUBLIC}/v1/thing`,
        allowed_hosts: [PUBLIC],
        ...over,
      } as Parameters<typeof toolCreate>[1],
      { base: appDb },
    );
  };

  test("a generic credential nothing sends is reported, in the preview AND in the apply", async () => {
    // NOTE: both halves, because the preview is what the caller reads before deciding. A warning the
    // apply adds and the dry run withholds is the preview promising a clean write (#490).
    for (const dry_run of [undefined, false]) {
      const r = await create({ credential_ref: genericRef, dry_run });
      expect(r.ok).toBe(true);
      expect(wiringWarning(r)).toHaveLength(1);
      expect(wiringWarning(r)[0]).toContain("unauthenticated");
    }
  });

  test("the same tool with {{secret}} in a header is not warned about", async () => {
    const r = await create({
      credential_ref: genericRef,
      headers: { "X-Auth": "{{secret}}" },
    });
    expect(r.ok).toBe(true);
    expect(wiringWarning(r)).toHaveLength(0);
  });

  test("a single-brace {secret} is judged AFTER normalization, not before", async () => {
    // NOTE: the write stores `{{secret}}` here — `normalizeToolShapes` rewrites the single brace
    // because "secret" is a name it knows. Scanning the raw argument would warn about a tool that
    // is wired the instant it is stored, and the operator would have nothing to fix.
    const r = await create({
      credential_ref: genericRef,
      headers: { "X-Auth": "{secret}" },
    });
    expect(r.ok).toBe(true);
    expect(wiringWarning(r)).toHaveLength(0);
  });

  test("a typed credential is auto-injected, so silence is right", async () => {
    const r = await create({ credential_ref: bearerRef });
    expect(r.ok).toBe(true);
    expect(wiringWarning(r)).toHaveLength(0);
  });

  test("no credential attached, no warning", async () => {
    // NOTE: most tools need none. A warning here would fire on nearly every write.
    const r = await create({});
    expect(r.ok).toBe(true);
    expect(wiringWarning(r)).toHaveLength(0);
  });

  test("attaching the credential to a stored tool judges the STORED templates", async () => {
    // NOTE: the patch says nothing about the templates. Judging the patch alone would find no
    // {{secret}} in an empty object and warn about every tool, or find none to judge and warn about
    // nothing — which is the same bug read from either end.
    const created = await create({ dry_run: false });
    expect(created.ok).toBe(true);
    const id = created.ok
      ? (created.data as { target: string }).target.split(":")[1]
      : "";
    const r = await toolUpdate(
      principal(),
      { tool_id: id as string, credential_ref: genericRef },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    expect(wiringWarning(r)).toHaveLength(1);
  });

  test("rewriting a template away from {{secret}} judges the STORED credential", async () => {
    // NOTE: the mirror of the case above, and the reason the effective row is patch-over-stored
    // rather than either one: here the patch carries the templates and the credential is the half
    // that only exists in the row.
    const created = await create({
      credential_ref: genericRef,
      headers: { "X-Auth": "{{secret}}" },
      dry_run: false,
    });
    expect(created.ok).toBe(true);
    expect(wiringWarning(created)).toHaveLength(0);
    const id = created.ok
      ? (created.data as { target: string }).target.split(":")[1]
      : "";
    const r = await toolUpdate(
      principal(),
      { tool_id: id as string, headers: { "X-Other": "constant" } },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    expect(wiringWarning(r)).toHaveLength(1);
  });

  test("a patch that touches neither still reads the row, and stays quiet on a wired tool", async () => {
    // NOTE: the control for the two above. A rename must not start warning about a tool whose
    // wiring nobody touched.
    const created = await create({
      credential_ref: genericRef,
      headers: { "X-Auth": "{{secret}}" },
      dry_run: false,
    });
    const id = created.ok
      ? (created.data as { target: string }).target.split(":")[1]
      : "";
    const r = await toolUpdate(
      principal(),
      { tool_id: id as string, label: "Renamed" },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    expect(wiringWarning(r)).toHaveLength(0);
  });
});
