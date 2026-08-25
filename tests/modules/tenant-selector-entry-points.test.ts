import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PrismaClient as PrismaClientType } from "@/../generated/prisma/client";
import { PrismaClient } from "@/../generated/prisma/client";
import { createTenant } from "@/api/v1/tenants.admin.service";
import { listTenants } from "@/api/v1/tenants.service";
import { ActiveTenantNotFoundError, AppError } from "@/lib/errors";
import { resolveRequestTenantContext, type TenantContext } from "@/lib/tenancy";
import { issueDocument } from "@/modules/documents/issue";
import {
  createExperiment,
  deleteExperiment,
  experimentResults,
  getExperiment,
  listExperiments,
  updateExperiment,
} from "@/modules/experiments/service";
import { createIntegrationInstance } from "@/modules/integrations/service";
import { resolveEffectivePrincipal } from "@/modules/mcp/tenant-target";
import { exportToolWorkflowForTenant } from "@/modules/n8n-export/service";
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  readEmbeddingBlock,
  reindexKnowledgeBase,
  retryDocument,
  updateDocument,
} from "@/modules/rag/documents";
import {
  approveApprovalItem,
  createKnowledgeBase,
  createSuggestion,
  deleteKnowledgeBase,
  editApprovalItem,
  getKnowledgeBase,
  listChunks,
  listKnowledgeBases,
  listPendingApprovals,
  rejectApprovalItem,
  searchKnowledge,
  updateKnowledgeBase,
} from "@/modules/rag/service";

// #268 fixed the playground and said the playground was the one console surface that handed a
// module a bare tenant id. It was four more: knowledge/RAG, experiments, integrations and
// documents. Same mechanism — `runScopedOn` verifies an unknown tenant ONLY for a `SUPER_ADMIN`
// context, because the role is what separates an id that reached this process from outside (the
// `X-Tenant-Id` selector the console persists in the browser) from one it read from a row; a module
// that takes `tenantId: bigint` and rebuilds a `TENANT_ADMIN` context around it tells that check the
// id was internal, whatever its real provenance.
//
// Measured before the change, against this database, with a selector naming a tenant that does not
// exist. Five answered as though the tenant were real and merely empty:
//
//   listKnowledgeBases   -> []   listPendingApprovals -> []   searchKnowledge -> []
//   listExperiments      -> []   readEmbeddingBlock   -> { reason: "embedding_not_configured" }
//
// while the same selector on any other route answered 404 `ActiveTenantNotFoundError`. The rest did
// refuse, about the wrong fact — "knowledge base not found", "document not found", "experiment not
// found", "document template not found", "tool definition not found" — none of which tells the
// console anything about the selector it is carrying, so the recovery #265 added never fires. The
// one write in the set was worse still: `createIntegrationInstance` reached Postgres and came back
// with a raw foreign-key violation, which is not an `AppError` at all and surfaces as a 500.
//
// Issue #280.

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

afterAll(async () => {
  await su?.$disconnect();
  await app?.$disconnect();
});

let liveId = 0n;
let deadId = 0n;

// At file level rather than inside the first `describe`: the MCP control below reads the same live
// tenant, and a teardown that fires when the first block ends deletes it out from under it.
beforeAll(async () => {
  if (!dbUp) return;
  const t = await suDb.tenant.create({
    data: { name: "SelSweep", slug: `selsweep-${process.pid}` },
  });
  liveId = t.id;
  const max = await suDb.$queryRaw<
    { m: bigint | null }[]
  >`SELECT MAX(id) AS m FROM tenants`;
  deadId = (max[0]?.m ?? 0n) + 1_000_000n;
});

afterAll(async () => {
  if (liveId) await suDb.tenant.deleteMany({ where: { id: liveId } });
});

// The context the REST boundary actually builds from the header, rather than one written by hand:
// what makes this reachable is that the selector is a string the browser persists.
function fromSelector(tenantId: bigint): TenantContext {
  const { context } = resolveRequestTenantContext(
    { id: 1n, tenantId: null, role: "SUPER_ADMIN" },
    String(tenantId),
  );
  if (!context) throw new Error("the boundary refused a SUPER_ADMIN principal");
  return context;
}

// What a console operator carries: a tenant-scoped principal, whose id this process read from a row.
function operator(tenantId: bigint): TenantContext {
  return { tenantId, userId: 1n, role: "TENANT_ADMIN" };
}

// Counts the existence check, so "a console operator does not pay for this" is measured rather than
// asserted.
function counting(base: PrismaClient) {
  const seen = { tenantFindUnique: 0 };
  const client = base.$extends({
    query: {
      tenant: {
        findUnique({ args, query }) {
          seen.tenantFindUnique += 1;
          return query(args);
        },
      },
    },
  });
  return { client: client as unknown as PrismaClientType, seen };
}

describe.skipIf(!dbUp)("a REST call carrying a dead tenant selector", () => {
  // One row per exported entry point the four controllers reach, because the defect was per call
  // site: the decision lives in `runScopedOn` and what this pins is that each of these actually
  // reaches it with the CALLER's context instead of one rebuilt from the id inside it.
  //
  // Ids and names below are deliberately arbitrary. Every one of these refuses before the row it
  // names is looked up, which is the whole point: the answer must be about the selector, not about
  // what the selector could not find.
  const entryPoints: Array<[string, (ctx: TenantContext) => Promise<unknown>]> =
    [
      // knowledge bases
      ["listKnowledgeBases", (ctx) => listKnowledgeBases(ctx, appDb)],
      [
        "createKnowledgeBase",
        (ctx) => createKnowledgeBase({ ctx, name: "kb", base: appDb }),
      ],
      [
        "getKnowledgeBase",
        (ctx) => getKnowledgeBase({ ctx, id: 1n, base: appDb }),
      ],
      [
        "updateKnowledgeBase",
        (ctx) => updateKnowledgeBase({ ctx, id: 1n, name: "kb", base: appDb }),
      ],
      [
        "deleteKnowledgeBase",
        (ctx) => deleteKnowledgeBase({ ctx, id: 1n, base: appDb }),
      ],
      [
        "listChunks",
        (ctx) => listChunks({ ctx, knowledgeBaseId: 1n, base: appDb }),
      ],
      [
        "searchKnowledge",
        (ctx) => searchKnowledge({ ctx, query: "q", base: appDb }),
      ],
      // documents inside a base
      ["listDocuments", (ctx) => listDocuments(ctx, 1n, appDb)],
      ["getDocument", (ctx) => getDocument(ctx, 1n, appDb)],
      [
        "createDocument",
        (ctx) =>
          createDocument({
            ctx,
            knowledgeBaseId: 1n,
            title: "t",
            text: "x",
            sourceType: "text",
            base: appDb,
          }),
      ],
      [
        "updateDocument",
        (ctx) => updateDocument(ctx, 1n, { title: "t" }, appDb),
      ],
      ["deleteDocument", (ctx) => deleteDocument(ctx, 1n, appDb)],
      ["retryDocument", (ctx) => retryDocument(ctx, 1n, appDb)],
      ["readEmbeddingBlock", (ctx) => readEmbeddingBlock(ctx, appDb)],
      ["reindexKnowledgeBase", (ctx) => reindexKnowledgeBase(ctx, 1n, appDb)],
      // the approval queue
      ["listPendingApprovals", (ctx) => listPendingApprovals(ctx, appDb)],
      [
        "createSuggestion",
        (ctx) =>
          createSuggestion({
            ctx,
            knowledgeBaseId: 1n,
            proposedContent: "c",
            threadId: "t",
            base: appDb,
          }),
      ],
      [
        "editApprovalItem",
        (ctx) =>
          editApprovalItem({ ctx, id: 1n, proposedTitle: "t", base: appDb }),
      ],
      [
        "approveApprovalItem",
        (ctx) => approveApprovalItem({ ctx, id: 1n, base: appDb }),
      ],
      [
        "rejectApprovalItem",
        (ctx) => rejectApprovalItem({ ctx, id: 1n, base: appDb }),
      ],
      // experiments
      ["listExperiments", (ctx) => listExperiments(ctx, appDb)],
      [
        "createExperiment",
        (ctx) =>
          createExperiment({
            ctx,
            name: "e",
            variants: [{ key: "a" }, { key: "b" }],
            base: appDb,
          }),
      ],
      ["getExperiment", (ctx) => getExperiment(ctx, 1n, appDb)],
      [
        "updateExperiment",
        (ctx) => updateExperiment({ ctx, id: 1n, name: "e", base: appDb }),
      ],
      ["deleteExperiment", (ctx) => deleteExperiment(ctx, 1n, appDb)],
      ["experimentResults", (ctx) => experimentResults(ctx, 1n, appDb)],
      // integrations, documents, n8n export
      [
        "createIntegrationInstance",
        (ctx) =>
          createIntegrationInstance(
            ctx,
            { catalogType: "ASAAS", name: `sel-${process.pid}` },
            appDb,
          ),
      ],
      [
        "issueDocument",
        (ctx) =>
          issueDocument({
            ctx,
            templateId: 1n,
            idempotencyKey: `sel-${process.pid}`,
            values: {},
            base: appDb,
          }),
      ],
      [
        "exportToolWorkflowForTenant",
        (ctx) => exportToolWorkflowForTenant(ctx, 1n, appDb),
      ],
    ];

  for (const [name, call] of entryPoints) {
    test(`${name} refuses it, naming the selector`, async () => {
      const err = await call(fromSelector(deadId)).catch((e: unknown) => e);
      expect(err instanceof AppError).toBe(true);
      const appErr = err as AppError;
      expect(appErr.statusCode).toBe(404);
      // Not merely "a 404": the class that says WHICH fact is wrong. `errors.knowledgeBaseNotFound`
      // is also a 404 here and tells the console nothing about the selection it has stored.
      expect(err instanceof ActiveTenantNotFoundError).toBe(true);
      expect((err as ActiveTenantNotFoundError).rejectedTenantId).toBe(
        String(deadId),
      );
    });
  }

  test("a live selector still answers, and pays one statement for the check", async () => {
    const { client, seen } = counting(appDb);
    expect(await listKnowledgeBases(fromSelector(liveId), client)).toEqual([]);
    expect(seen.tenantFindUnique).toBe(1);
  });

  test("a console operator pays nothing, because the role is the predicate", async () => {
    const { client, seen } = counting(appDb);
    expect(await listKnowledgeBases(operator(liveId), client)).toEqual([]);
    expect(seen.tenantFindUnique).toBe(0);
  });
});

// Why the same modules reached over MCP were left alone, measured rather than assumed.
//
// The MCP transport asks this question at its OWN boundary: every per-tenant tool is registered
// through `registerTenantTool`, which calls `resolveEffectivePrincipal` before the handler runs, and
// a SUPER_ADMIN token's `tenant` selector is resolved against the tenants table there. So an id that
// reached the process from outside has already been proven to name a row by the time any of the
// functions above sees it, and the `ctx.tenantId` those tools carry is no longer caller-supplied in
// the sense that matters. That is also why they keep passing `ctx` down without paying twice being
// a problem: `runScopedOn` re-asks a question already answered, once per scoped block.
describe.skipIf(!dbUp)(
  "the MCP transport refuses the same selector earlier",
  () => {
    test("an unknown `tenant` never reaches a tool", async () => {
      const resolved = await resolveEffectivePrincipal(
        {
          userId: 1n,
          tenantId: null,
          role: "SUPER_ADMIN",
          scopes: [],
          clientId: "c",
          jti: "j",
        },
        { tenant: String(deadId) },
        appDb,
      );
      expect(resolved.ok).toBe(false);
      // A graceful error the wrapper turns into an isError result, not a throw — and it names the
      // selector, which is the fact the caller has to act on.
      expect(resolved.ok === false && resolved.error).toContain(String(deadId));
    });

    test("a known `tenant` resolves to that tenant", async () => {
      const resolved = await resolveEffectivePrincipal(
        {
          userId: 1n,
          tenantId: null,
          role: "SUPER_ADMIN",
          scopes: [],
          clientId: "c",
          jti: "j",
        },
        { tenant: String(liveId) },
        appDb,
      );
      expect(resolved.ok && resolved.eff.tenantId).toBe(liveId);
    });
  },
);

// The half a table cannot cover. Everything above proves the FUNCTIONS refuse; it says nothing about
// whether the next route added to one of these controllers unwraps the request's context back down
// to an id, which is exactly how the defect got in — twice, in two different spellings (a `bigint`
// helper in three controllers, an inline cast in two more).
//
// Keyed on the TRANSPORT, not on a module path: the modules legitimately keep `sysCtx` for their
// internal callers (the graph, the ingest job, the scheduler all carry an id read from a row), so a
// sweep of `src/modules/**` would be a sweep of the wrong thing. #268's guard scanned one module
// directory and the two offenders that lived outside it were found by review, not by the guard.
export function handsOutABareTenantId(source: string): boolean {
  // A helper that unwraps the request's context down to its id, so every route below it can pass
  // the id on: the shape that was in knowledge, experiments and n8n-export.
  if (/\):\s*bigint\s*\{[\s\S]{0,300}?\breturn\s+\w+\.tenantId;/.test(source)) {
    return true;
  }
  // The same unwrapping written inline at the call: the shape that was in integrations-admin and
  // documents. In a controller the context always came from the request, so the cast is always the
  // provenance being thrown away — there is no benign spelling of it here.
  return /\.tenantId as bigint/.test(source);
}

describe("no REST controller hands a module a bare tenant id", () => {
  const HELPER = `function tenantId(ctx: TenantContext | null): bigint {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx.tenantId;
}`;
  const INLINE = `const created = await createIntegrationInstance(
        ctx.tenantId as bigint,
        b,
      );`;

  // A sweep that finds nothing passes whether or not it works, so both shapes are shown to be
  // caught, and the shape that REPLACED them is shown not to be.
  test("the predicate catches both shapes that were there", () => {
    expect(handsOutABareTenantId(HELPER)).toBe(true);
    expect(handsOutABareTenantId(INLINE)).toBe(true);
    expect(
      handsOutABareTenantId(`function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}`),
    ).toBe(false);
    // A row's id is not a selector: this is the case the role predicate exists to let through.
    expect(handsOutABareTenantId("await getTenantName(user.tenantId)")).toBe(
      false,
    );
  });

  test("no file under src/api does", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    for await (const rel of new Glob("**/*.ts").scan("src/api")) {
      const src = await Bun.file(`src/api/${rel}`).text();
      if (handsOutABareTenantId(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

// The negative control for the two exemptions at the bottom of this file, and the reason they are
// exemptions rather than routes nobody got around to converting: a FLEET operation answers the
// selector instead of refusing it. `listTenants` and `createTenant` both branch to `asSuperAdminOn`
// when the caller is a SUPER_ADMIN, so the id the selector carries is never looked up, and asking
// their response maps to name a 404 would publish a status they cannot return.
describe.skipIf(!dbUp)("a fleet route answers a dead selector", () => {
  test("listing tenants returns the fleet rather than refusing", async () => {
    const rows = await listTenants(fromSelector(deadId), appDb);
    expect(Array.isArray(rows)).toBe(true);
  });

  // Written as "whatever it answers, it is not about the selector" because this file ships to both
  // editions: the derivation swaps `tenants.admin.service` for a stub that refuses with
  // `ProEditionError` in Free, so asserting the row gets created would fail there for a reason that
  // has nothing to do with what is under test.
  test("creating a tenant never refuses the selector", async () => {
    const slug = `selsweep-fleet-${process.pid}`;
    const err = await createTenant(
      fromSelector(deadId),
      { name: "SelSweepFleet", slug },
      appDb,
    )
      .then(() => null)
      .catch((e: unknown) => e);
    try {
      expect(err instanceof ActiveTenantNotFoundError).toBe(false);
    } finally {
      await suDb.tenant.deleteMany({ where: { slug } });
    }
  });
});

// The other half of "refuses, naming the selector": the CONTRACT has to name that refusal too.
//
// A status a route returns that the contract does not name is a status no generated client knows how
// to handle: `openapi.json` is committed and `bun openapi:check` gates it, and the Eden types the
// console is built against come from the same declarations. #284 declared the twelve routes it had
// just converted; issue #297 is the fifty older ones, which could ALREADY answer 404 before that
// change and did not say so, and it is why this sweep is no longer scoped to two files.
//
// Measured for #297 over real HTTP — the whole app, a real Postgres, a SUPER_ADMIN cookie and an
// `X-Tenant-Id` naming a tenant that does not exist. 48 of the 50 answered
// `404 errors.tenantNotFound` carrying `X-Tenant-Id-Invalid`; the two that did not are the fleet
// routes exempted below. Reachability is input-dependent and that is why it was measured rather than
// read: `POST /v1/agents/tts/list` answers 200 for `provider: "openai"` (a curated list, no scoped
// read) and 404 for `provider: "elevenlabs"`, which resolves a vault credential inside the scope.
export function passesTheContextOn(routeBlock: string): boolean {
  // Used as a VALUE — an argument, an assignment, a property — rather than as a bare authorization
  // statement (`ctxOrThrow(tenantContext);`), which reaches no scoped read and so cannot 404.
  return /(?:=|\(|,|:)\s*ctxOrThrow\(tenantContext\)/.test(routeBlock);
}

function routeBlocks(source: string): string[] {
  const starts: number[] = [];
  const re = /^ {2}\.(?:get|post|patch|put|delete)\(/gm;
  let m = re.exec(source);
  while (m) {
    starts.push(m.index);
    m = re.exec(source);
  }
  return starts.map((s, i) => source.slice(s, starts[i + 1] ?? source.length));
}

// `GET /v1/knowledge/bases`, the way the published contract spells it: the controller's own prefix,
// and `:id` rewritten as `{id}`.
export function routeIdentity(
  prefix: string,
  block: string,
): { verb: string; path: string } | null {
  const verb = /^ {2}\.(\w+)\(/.exec(block)?.[1];
  const route = /^ {2}\.\w+\(\s*\n?\s*"([^"]*)"/.exec(block)?.[1];
  if (!verb || route === undefined) return null;
  const joined = `${prefix}${route === "/" ? "" : route}`;
  return {
    verb: verb.toLowerCase(),
    path: joined.replace(/:(\w+)/g, "{$1}"),
  };
}

// The routes that pass the context on and STILL cannot answer 404, so the sweep would otherwise be
// asking them to declare a status they never return — which is its own kind of wrong contract.
//
// Both are fleet operations: `listTenants` and `createTenant` branch to `asSuperAdminOn` for a
// SUPER_ADMIN caller, so the id the selector carries is never looked up. Measured, with a dead
// selector, both answered 200 (and `POST /v1/tenants` created the tenant). Pinned as behaviour by
// the two rows in the DB-backed block above rather than only asserted here, because an exemption
// that only lives in a list is an exemption nobody re-checks.
const CANNOT_REFUSE_THE_SELECTOR = new Set([
  "get /v1/tenants",
  "post /v1/tenants",
]);

async function sweepRoutes(): Promise<
  Array<{ file: string; verb: string; path: string; declared: string }>
> {
  const { Glob } = await import("bun");
  const out: Array<{
    file: string;
    verb: string;
    path: string;
    declared: string;
  }> = [];
  for await (const rel of new Glob("**/*.controller.ts").scan("src/api")) {
    const file = `src/api/${rel}`;
    const source = await Bun.file(file).text();
    const prefix = /new Elysia\(\{[^}]*prefix:\s*"([^"]+)"/.exec(source)?.[1];
    if (!prefix) continue;
    for (const block of routeBlocks(source)) {
      if (!passesTheContextOn(block)) continue;
      const id = routeIdentity(prefix, block);
      if (!id) throw new Error(`unreadable route in ${file}`);
      out.push({
        file,
        ...id,
        declared: /response:\s*errors\(([^)]*)\)/.exec(block)?.[1] ?? "",
      });
    }
  }
  return out;
}

describe("a route that can refuse the selector declares that refusal", () => {
  const AUTH_ONLY = `  .get(
    "/catalog",
    ({ tenantContext }) => {
      ctxOrThrow(tenantContext);
      return { catalog: listCatalog() };
    },
    { response: errors(401, 403) },
  )`;
  const PASSES_ON = `  .get(
    "/bases",
    async ({ tenantContext }) => {
      const bases = await listKnowledgeBases(ctxOrThrow(tenantContext));
      return { bases };
    },
    { response: errors(401, 403) },
  )`;

  test("the predicate separates passing the context on from checking it", () => {
    expect(passesTheContextOn(PASSES_ON)).toBe(true);
    expect(passesTheContextOn(AUTH_ONLY)).toBe(false);
  });

  test("the identity is the one the published contract uses", () => {
    expect(routeIdentity("/v1/knowledge", PASSES_ON)).toEqual({
      verb: "get",
      path: "/v1/knowledge/bases",
    });
    expect(
      routeIdentity(
        "/v1/chatwoot",
        `  .get(\n    "/inboxes/:id/widget-health",\n    async ({ tenantContext }) => {\n      const x = ctxOrThrow(tenantContext);\n    },\n  )`,
      ),
    ).toEqual({ verb: "get", path: "/v1/chatwoot/inboxes/{id}/widget-health" });
  });

  test("every v1 route that passes the context on names 404", async () => {
    const routes = await sweepRoutes();
    const offenders = routes
      .filter((r) => !CANNOT_REFUSE_THE_SELECTOR.has(`${r.verb} ${r.path}`))
      .filter((r) => !r.declared.includes("404"))
      .map((r) => `${r.file}: ${r.verb} ${r.path} → errors(${r.declared})`);
    expect(offenders).toEqual([]);
    // …and the sweep is looking at something. A rule whose subject can become empty starts passing
    // for the wrong reason the day someone reshapes these files.
    expect(routes.length).toBeGreaterThanOrEqual(150);
    // An exemption for a route that no longer exists (renamed, moved, deleted) silently exempts
    // nothing and hides the day it comes back under the same name. Every entry has to be met.
    const seen = new Set(routes.map((r) => `${r.verb} ${r.path}`));
    expect([...CANNOT_REFUSE_THE_SELECTOR].filter((k) => !seen.has(k))).toEqual(
      [],
    );
  });

  // The contract as it is actually published, not only as it is declared in the source:
  // `openapi.json` is the committed artifact and what a generated client reads.
  test("the published contract carries the 404 for every one of them", async () => {
    const spec = (await Bun.file("openapi.json").json()) as {
      paths: Record<
        string,
        Record<string, { responses?: Record<string, unknown> }>
      >;
    };
    const routes = await sweepRoutes();
    const missing = routes
      .filter((r) => !CANNOT_REFUSE_THE_SELECTOR.has(`${r.verb} ${r.path}`))
      .filter((r) => !spec.paths?.[r.path]?.[r.verb]?.responses?.["404"])
      .map((r) => `${r.verb} ${r.path}`);
    expect(missing).toEqual([]);
    // The published spec has to be the same set of routes the source sweep found: a path this test
    // cannot look up would otherwise pass as "no 404 missing".
    const unpublished = routes.filter((r) => !spec.paths?.[r.path]?.[r.verb]);
    expect(unpublished.map((r) => `${r.verb} ${r.path}`)).toEqual([]);
  });
});
