import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildHttpTool, type HttpToolDef } from "@/graph/tools/http";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { toolCreate, toolUpdate } from "@/modules/mcp/write-agents";
import { unusedCredentialWarning } from "@/modules/tool-definitions/credential-wiring";
import type { ToolShapePatch } from "@/modules/tool-definitions/normalize";
import { SECRET_TYPE_IDS } from "@/modules/vault/secret-types";
import { createVaultEntry } from "@/modules/vault/service";

// Issue #504, second half: an HTTP tool can reference a `generic` credential while nothing in its
// templates interpolates {{secret}}. Nothing refuses it and nothing should — a tool may hold a
// reference it has not wired yet — but the request then goes out UNAUTHENTICATED and the upstream
// answers 401/403, which reads as a bad credential rather than one that was never sent.
//
// THE FENCE IS EXECUTION, NOT A LIST. Every row below is built ONCE and read two ways: as a tool
// definition the real executor runs against a captured fetch, and as the shapes a write would store.
// The assertion is that the two agree. A rule the runtime has and this file does not shows up as a
// secret in the captured request with the warning saying it was never sent, or the reverse.
//
// Four of these rows were wrong answers in the first draft, and none of them is a site the scan
// missed: the body of a GET is assembled and discarded, a fixed field only leaves if something
// emitted names it, a typed credential's auto-injection is SKIPPED when the operator already wrote
// its target header, and a stored single-brace `{secret}` is normalized at build time and does reach.

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

// One row, and the two projections of it. Written once so the executor and the scanner cannot be
// given different tools by accident, which is the only way a fence like this lies.
interface Wiring {
  label: string;
  reaches: boolean;
  method?: string;
  kind?: string;
  paramName?: string | null;
  credentialBaseUrl?: string;
  urlTemplate?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  inputSchema?: unknown;
}

const asDef = (w: Wiring): HttpToolDef => ({
  name: "thing",
  method: w.method ?? "GET",
  urlTemplate: w.urlTemplate ?? `https://${PUBLIC}/v1/thing`,
  allowedHosts: [PUBLIC],
  headers: w.headers ?? {},
  query: w.query,
  body: w.body,
  inputSchema: w.inputSchema ?? {},
  credentialRef: "vault:1",
  credentialKind: w.kind ?? "generic",
  credentialParamName: w.paramName ?? null,
  credentialBaseUrl: w.credentialBaseUrl ?? null,
});

const asShapes = (w: Wiring): ToolShapePatch => ({
  urlTemplate: w.urlTemplate ?? `https://${PUBLIC}/v1/thing`,
  headers: w.headers ?? {},
  query: w.query,
  body: w.body,
  inputSchema: w.inputSchema ?? {},
});

// Invoked with NO model input, which is the reading the warning has to take: a credential that
// leaves on some invocations is a credential that leaves. One row below depends on exactly that —
// the runtime skips a lone AI placeholder the model omits, and the earlier row's `{{secret}}` stays.
async function secretLeft(w: Wiring): Promise<boolean> {
  const captured: Captured = {};
  const tool = buildHttpTool(asDef(w), {
    resolveCredential: async () => SECRET,
    fetchImpl: stubFetch(captured),
  });
  // NOTE: a REQUIRED ai field is supplied, because zod refuses the call without it — which is the
  // very reason its row always overwrites. Everything optional is left out, so the runtime takes the
  // omission branch the table is reading.
  const input: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(
    (w.inputSchema ?? {}) as Record<string, { required?: boolean }>,
  )) {
    if (spec?.required === true) input[name] = "model-value";
  }
  (await tool.invoke(input)) as unknown as ToolMessage;
  const headers = captured.init?.headers as Record<string, string> | undefined;
  return [
    // The URL as far as it is TRANSMITTED. A stub fetch is handed the whole string, fragment and
    // all, and the wire is not — the test below measures that against a real socket, and without
    // this cut a credential written into a fragment would read here as sent.
    (captured.url ?? "").split("#")[0] ?? "",
    ...Object.values(headers ?? {}),
    String(captured.init?.body ?? ""),
  ]
    .join(" | ")
    .includes(SECRET);
}

const scannerSaysReaches = (w: Wiring): boolean =>
  unusedCredentialWarning(
    {
      kind: w.kind ?? "generic",
      paramName: w.paramName ?? null,
      baseUrl: w.credentialBaseUrl ?? null,
    },
    w.method ?? "GET",
    asShapes(w),
  ) === null;

const CASES: Wiring[] = [
  // ── the five interpolation sites ──
  {
    label: "{{secret}} in url_template",
    reaches: true,
    urlTemplate: `https://${PUBLIC}/v1/{{secret}}`,
  },
  {
    label: "{{secret}} in a header",
    reaches: true,
    headers: { "X-Auth": "{{secret}}" },
  },
  {
    label: "{{secret}} in a query value",
    reaches: true,
    query: { token: "{{secret}}" },
  },
  {
    label: "{{secret}} in a raw body, on a POST",
    reaches: true,
    method: "POST",
    body: { mode: "raw", raw: '{"t":"{{secret}}"}' },
  },
  {
    label: "{{secret}} in a kv body row, on a POST",
    reaches: true,
    method: "POST",
    body: { mode: "kv", rows: [{ key: "t", value: "{{secret}}" }] },
  },
  {
    label: "{{secret}} in a fixed field the URL names",
    reaches: true,
    urlTemplate: `https://${PUBLIC}/v1/{{tok}}`,
    inputSchema: {
      tok: { type: "string", source: "fixed", value: "{{secret}}" },
    },
  },

  // ── a template that is assembled and discarded ──
  {
    label: "a raw body on a GET is never sent",
    reaches: false,
    method: "GET",
    body: { mode: "raw", raw: '{"t":"{{secret}}"}' },
  },
  {
    label: "a raw body on a DELETE is never sent either",
    reaches: false,
    method: "DELETE",
    body: { mode: "raw", raw: '{"t":"{{secret}}"}' },
  },
  {
    label: "a fixed field nothing references, with a kv body",
    reaches: false,
    method: "POST",
    body: { mode: "kv", rows: [{ key: "a", value: "1" }] },
    inputSchema: {
      tok: { type: "string", source: "fixed", value: "{{secret}}" },
    },
  },
  {
    label: "the same fixed field, with a legacy fields body that assembles it",
    reaches: true,
    method: "POST",
    inputSchema: {
      tok: { type: "string", source: "fixed", value: "{{secret}}" },
    },
  },
  {
    label: "{{secret}} in an AI field's value is not interpolated",
    reaches: false,
    inputSchema: { tok: { type: "string", value: "{{secret}}" } },
  },

  // ── auto-injection, and the operator's value winning over it ──
  {
    label: "bearer_token injects on its own",
    reaches: true,
    kind: "bearer_token",
  },
  {
    label: "bearer_token whose Authorization header the operator already wrote",
    reaches: false,
    kind: "bearer_token",
    headers: { Authorization: "constant" },
  },
  {
    label: "…unless what they wrote is {{secret}}",
    reaches: true,
    kind: "bearer_token",
    headers: { Authorization: "Bearer {{secret}}" },
  },
  {
    label: "a header kind injects into its own param name",
    reaches: true,
    kind: "header",
    paramName: "X-Api-Key",
  },
  {
    label: "…and is shadowed by that header in any casing",
    reaches: false,
    kind: "header",
    paramName: "X-Api-Key",
    headers: { "x-api-key": "constant" },
  },
  {
    label: "a query kind injects its param",
    reaches: true,
    kind: "query",
    paramName: "token",
  },
  {
    label: "…and is shadowed by an explicit query value",
    reaches: false,
    kind: "query",
    paramName: "token",
    query: { token: "constant" },
  },
  {
    label: "…and by one hand-written into the URL",
    reaches: false,
    kind: "query",
    paramName: "token",
    urlTemplate: `https://${PUBLIC}/v1/thing?token=constant`,
  },

  // ── the query map, which the runtime reads on its own terms ──
  {
    label: "a query value the URL template already spells is discarded",
    reaches: false,
    urlTemplate: `https://${PUBLIC}/v1/thing?token=fixed`,
    query: { token: "{{secret}}" },
  },
  {
    label:
      "a query kind shadowed by a NON-string literal the runtime stringifies",
    reaches: false,
    kind: "query",
    paramName: "token",
    query: { token: 123 },
  },
  {
    label: "…and not shadowed by an empty one, which the runtime skips",
    reaches: true,
    kind: "query",
    paramName: "token",
    query: { token: "" },
  },
  {
    label: "a fixed field whose NAME cannot be a placeholder reaches nothing",
    reaches: false,
    method: "POST",
    body: { mode: "kv", rows: [{ key: "a", value: "1" }] },
    inputSchema: {
      "a[b": { type: "string", source: "fixed", value: "{{secret}}" },
    },
  },

  {
    label: "a query key the URL spells past a value that carries its own '?'",
    reaches: false,
    urlTemplate: `https://${PUBLIC}/v1/thing?redirect=https://a.test/?x=1&token=fixed`,
    query: { token: "{{secret}}" },
  },
  {
    label: "a query kind shadowed by a value that cannot interpolate empty",
    reaches: false,
    kind: "query",
    paramName: "token",
    query: { token: "prefix-{{contact_name}}" },
  },
  {
    label: "…and not shadowed by one that can",
    reaches: true,
    kind: "query",
    paramName: "token",
    query: { token: "{{contact_name}}" },
  },
  {
    label: "{{secret}} in a URL fragment is written and never transmitted",
    reaches: false,
    urlTemplate: `https://${PUBLIC}/v1/thing#token={{secret}}`,
  },

  {
    label: "a kv row a later row overwrites is assembled and discarded",
    reaches: false,
    method: "POST",
    body: {
      mode: "kv",
      rows: [
        { key: "auth", value: "{{secret}}" },
        { key: "auth", value: "fixed" },
      ],
    },
  },
  {
    label: "…and the row that wins is the one that counts",
    reaches: true,
    method: "POST",
    body: {
      mode: "kv",
      rows: [
        { key: "auth", value: "fixed" },
        { key: "auth", value: "{{secret}}" },
      ],
    },
  },
  {
    label: "a kv row with a blank key emits nothing",
    reaches: false,
    method: "POST",
    body: { mode: "kv", rows: [{ key: "  ", value: "{{secret}}" }] },
  },
  {
    label: "a query kind shadowed through a fixed field that is always set",
    reaches: false,
    kind: "query",
    paramName: "token",
    query: { token: "{{configured}}" },
    inputSchema: {
      configured: { type: "string", source: "fixed", value: "abc" },
    },
  },
  {
    label: "…and not shadowed through one that may resolve empty",
    reaches: true,
    kind: "query",
    paramName: "token",
    query: { token: "{{configured}}" },
    inputSchema: {
      configured: {
        type: "string",
        source: "fixed",
        value: "{{contact_name}}",
      },
    },
  },

  {
    label:
      "a query kind shadowed by the legacy query derivation, on a non-body method",
    reaches: false,
    method: "GET",
    kind: "query",
    paramName: "token",
    inputSchema: { token: { type: "string", source: "fixed", value: "xyz" } },
  },
  {
    label: "…not when that field is spent on the path instead",
    reaches: true,
    method: "GET",
    kind: "query",
    paramName: "token",
    urlTemplate: `https://${PUBLIC}/v1/{{token}}`,
    inputSchema: { token: { type: "string", source: "fixed", value: "xyz" } },
  },
  {
    label: "…and not on a POST, which assembles a body instead of a query",
    reaches: true,
    method: "POST",
    kind: "query",
    paramName: "token",
    inputSchema: { token: { type: "string", source: "fixed", value: "xyz" } },
  },
  {
    label:
      "a URL query KEY that is a fixed placeholder still takes the parameter",
    reaches: false,
    urlTemplate: `https://${PUBLIC}/v1/thing?{{auth_param}}=constant`,
    query: { token: "{{secret}}" },
    inputSchema: {
      auth_param: { type: "string", source: "fixed", value: "token" },
    },
  },

  {
    label: "a kv row a later LONE AI placeholder may not overwrite",
    reaches: true,
    method: "POST",
    body: {
      mode: "kv",
      rows: [
        { key: "auth", value: "{{secret}}" },
        { key: "auth", value: "{{override}}" },
      ],
    },
    inputSchema: { override: { type: "string" } },
  },
  {
    label:
      "…but a lone FIXED placeholder always resolves, so it always overwrites",
    reaches: false,
    method: "POST",
    body: {
      mode: "kv",
      rows: [
        { key: "auth", value: "{{secret}}" },
        { key: "auth", value: "{{override}}" },
      ],
    },
    inputSchema: {
      override: { type: "string", source: "fixed", value: "constant" },
    },
  },
  {
    label:
      "a fixed query key holding a URL metacharacter is ONE parameter, not two",
    reaches: true,
    kind: "query",
    paramName: "token",
    urlTemplate: `https://${PUBLIC}/v1/thing?{{auth_param}}=constant`,
    inputSchema: {
      auth_param: { type: "string", source: "fixed", value: "token&x" },
    },
  },

  {
    label:
      "{{secret}} stored in the credential's own base, under a relative template",
    reaches: true,
    urlTemplate: "/v1/thing",
    credentialBaseUrl: `https://${PUBLIC}/{{secret}}`,
  },
  {
    label: "…and an absolute template ignores that base entirely",
    reaches: false,
    urlTemplate: `https://${PUBLIC}/v1/thing`,
    credentialBaseUrl: `https://${PUBLIC}/{{secret}}`,
  },
  {
    label:
      "a lone {{secret}} row on a tool that DECLARES an ai field called secret",
    reaches: false,
    method: "POST",
    body: { mode: "kv", rows: [{ key: "auth", value: "{{secret}}" }] },
    inputSchema: { secret: { type: "string" } },
  },
  {
    label: "a later lone AI row that is REQUIRED always overwrites",
    reaches: false,
    method: "POST",
    body: {
      mode: "kv",
      rows: [
        { key: "auth", value: "{{secret}}" },
        { key: "auth", value: "{{override}}" },
      ],
    },
    inputSchema: { override: { type: "string", required: true } },
  },

  {
    label: "a query key nothing here can resolve is unknown, not a literal `_`",
    reaches: true,
    kind: "query",
    paramName: "_",
    urlTemplate: `https://${PUBLIC}/v1/thing?{{field}}=constant`,
    inputSchema: { field: { type: "string", required: true } },
  },

  // ── spelling ──
  {
    label:
      "a stored single-brace {secret} is normalized at build time and does reach",
    reaches: true,
    headers: { "X-Auth": "{secret}" },
  },
  {
    label: "the spacing the runtime accepts",
    reaches: true,
    headers: { "X-Auth": "{{ secret }}" },
  },

  // ── the control every row above needs ──
  {
    label: "a generic credential and no wiring at all",
    reaches: false,
    headers: { "X-Other": "constant" },
    query: { page: "1" },
    inputSchema: { note: { type: "string" } },
  },
];

describe("the scanner answers what the runtime does", () => {
  for (const w of CASES) {
    test(`${w.reaches ? "reaches" : "never reaches"}: ${w.label}`, async () => {
      expect(await secretLeft(w)).toBe(w.reaches);
      expect(scannerSaysReaches(w)).toBe(w.reaches);
    });
  }

  test("a fragment does not reach the upstream, which is why the table cuts it", async () => {
    // NOTE: the PREMISE behind the row above, measured rather than assumed, because the stub fetch
    // the table runs on cannot show it: `fetchImpl` is handed the whole URL string. A real socket is
    // what says whether the bytes leave, and `req.url` on the server side is the request TARGET the
    // client put on the wire.
    //
    // node:http on both ends, not `fetch`/`Bun.serve`: this suite preloads happy-dom, and under it
    // that pair answers `Parse Error: Duplicate Content-Length`. The client still builds its own
    // request line from a real URL, which is the thing under measurement.
    let seen = "";
    const srv = createServer((req, res) => {
      seen = req.url ?? "";
      res.end("ok");
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const { port } = srv.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${port}/x?a=1#token=${SECRET}`,
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end();
    });
    await new Promise<void>((r) => srv.close(() => r()));
    expect(seen).toBe("/x?a=1");
    expect(seen).not.toContain(SECRET);
  });

  test("the table is not all one answer", () => {
    // NOTE: the floor. Every assertion above is `toBe(w.reaches)`, so a table that drifted to a
    // single verdict would still pass while proving nothing about the boundary between them.
    const reaching = CASES.filter((c) => c.reaches).length;
    expect(reaching).toBeGreaterThan(15);
    expect(CASES.length - reaching).toBeGreaterThan(14);
  });
});

describe("which kinds the warning is about", () => {
  const bare: ToolShapePatch = { urlTemplate: `https://${PUBLIC}/v1/thing` };
  const warn = (kind: string | null) =>
    unusedCredentialWarning(
      { kind, paramName: "X-Probe", baseUrl: null },
      "GET",
      bare,
    );

  test("only the kinds that put nothing on the request by themselves", () => {
    const warned = SECRET_TYPE_IDS.filter((id) => warn(id) !== null);
    // NOTE: `generic` is the whole point — the escape hatch whose contract IS that the operator
    // writes {{secret}} by hand. `mcp_env` and `langfuse` also inject nothing and are deliberately
    // NOT warned about: their catalog entry says the value must never travel outbound, so "write
    // {{secret}} where the API expects it" would be advice to mail an stdio token to a third party.
    // That they can be attached to an HTTP tool at all is a separate defect, and a refusal rather
    // than a warning.
    expect(warned).toEqual(["generic"]);
  });

  test("a kind this build does not know is the legacy generic, and is warned about", () => {
    expect(warn(null)).not.toBeNull();
    expect(warn("kind_from_a_future_build")).not.toBeNull();
  });

  test("the sentence names a way out, and the ways out come from the catalog", () => {
    const w = warn("generic") ?? "";
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
const suDb = su as PrismaClient;

describe.skipIf(!dbUp)("tool_create / tool_update say so", () => {
  let tenantId = 0n;
  let genericRef = "";
  let bearerRef = "";
  let headerRef = "";
  let basedRef = "";
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
    headerRef = (
      await createVaultEntry(
        ctx,
        {
          name: "wiring-header",
          value: "abc123TOKEN",
          kind: "header",
          paramName: "X-Api-Key",
        },
        undefined,
        undefined,
        appDb,
      )
    ).ref;
    basedRef = (
      await createVaultEntry(
        ctx,
        {
          name: "wiring-based",
          value: "abc123TOKEN",
          kind: "generic",
          baseUrl: `https://${PUBLIC}/{{secret}}`,
        },
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

  test("where a header credential lands is read off the ENTRY, not guessed", async () => {
    // NOTE: `header` is the one kind whose injection target is operator-supplied, so the answer to
    // "does this credential reach the request" is in the vault row and nowhere else. Without the
    // stored param name the writer cannot resolve an injection at all, and every tool holding one of
    // these credentials would be reported as unwired — the shape a mutation of exactly that line
    // survived until this test existed.
    const clean = await create({ credential_ref: headerRef });
    expect(clean.ok).toBe(true);
    expect(wiringWarning(clean)).toHaveLength(0);

    // NOTE: and the other side of the same read — the operator wrote that header themselves, so the
    // runtime leaves their value alone and the credential never leaves. Different casing, because
    // the runtime compares case-insensitively and a warning that missed this would be a warning
    // about a header the operator can see.
    const shadowed = await create({
      credential_ref: headerRef,
      headers: { "x-api-key": "constant" },
    });
    expect(shadowed.ok).toBe(true);
    expect(wiringWarning(shadowed)).toHaveLength(1);
  });

  test("the credential's own base URL is part of the request, and is read off the entry", async () => {
    // NOTE: a RELATIVE template gets that base prepended before anything is interpolated, so a
    // {{secret}} stored in the base is sent — and the tool row alone cannot say so. Without the base
    // in the facts the writer reports a working tool as unwired, which a mutation of exactly that
    // line survived until this test existed.
    const relative = await create({
      credential_ref: basedRef,
      url_template: "/v1/thing",
    });
    expect(relative.ok).toBe(true);
    expect(wiringWarning(relative)).toHaveLength(0);

    // NOTE: the control — an ABSOLUTE template ignores the base entirely, so the same credential is
    // dead on this tool.
    const absolute = await create({ credential_ref: basedRef });
    expect(absolute.ok).toBe(true);
    expect(wiringWarning(absolute)).toHaveLength(1);
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

  test("a legacy single-brace {secret} in the stored row is not reported as unwired", async () => {
    // NOTE: the write normalizes, so this row cannot be produced through the write — it is what a
    // build older than that normalization left behind. `buildHttpTool` normalizes at BUILD time, so
    // the secret IS sent; a warning here would tell the operator to fix a tool that works, on an
    // update that never touched the template.
    const created = await create({
      credential_ref: genericRef,
      dry_run: false,
    });
    const id = created.ok
      ? (created.data as { target: string }).target.split(":")[1]
      : "";
    await suDb.$executeRawUnsafe(
      `UPDATE tool_definitions SET headers = '{"X-Auth":"{secret}"}'::jsonb WHERE id = ${id}`,
    );
    const r = await toolUpdate(
      principal(),
      { tool_id: id as string, label: "Renamed" },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    expect(wiringWarning(r)).toHaveLength(0);
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
