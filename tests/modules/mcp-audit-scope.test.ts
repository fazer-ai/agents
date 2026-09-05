import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { recordAudit } from "@/modules/audit/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { auditList } from "@/modules/mcp/read";
import { buildMcpServer } from "@/modules/mcp/server";
import { syntheticAction } from "../utils/audit-action";

// THE SCOPE HAS TO SURVIVE THE TRANSPORT (#520, review round 1).
//
// `audit_list` is registered through `registerTenantTool`, whose whole job is to make a fleet-level
// SUPER_ADMIN token name a target tenant before any per-tenant tool runs. That is right for every
// other tool on that list and wrong for this one on two of its three scopes: `fleet` and `all` name
// their own trail, so a tenant target is not merely unnecessary there, it is a value the read has
// nowhere to put. Two independent gates enforced it anyway -- the selector in the tool's own schema
// and `readGate`'s null-tenant check -- so the widest reader of the trail could reach the fleet rows
// only by naming an unrelated tenant, and on a deployment with no tenants at all could not reach
// them from MCP whatsoever. The REST surface has answered this correctly since the first commit of
// this PR; the point of these tests is that the two doors agree.
//
// TWO BLOCKS, because the two gates sit on opposite sides of the DB line. `tests/setup.ts` points
// `DATABASE_URL` at a database that does not exist, on purpose, so nothing reaches Postgres through
// `basePrisma`: a call through the registered tool can therefore prove the WRAPPER let it past, and
// never what the read returned. The rows are asserted one layer down, on `auditList` with an
// injected client, which is the same function the wrapper calls.

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

const TAG = `m520-${process.pid}`;
const USER = 9521n;

// The exact sentence `resolveEffectivePrincipal` answers a targetless SUPER_ADMIN with. Asserting on
// it is what tells "the wrapper demanded a tenant" apart from every other way a call can fail.
const ASKS_FOR_A_TARGET = "pass `tenant`";

function principal(over: Partial<VerifiedToken> = {}): VerifiedToken {
  return {
    userId: USER,
    tenantId: null,
    role: "SUPER_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
    ...over,
  };
}

async function withClient<T>(
  p: VerifiedToken,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const server = buildMcpServer(p);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "audit-scope", version: "0" });
  await client.connect(clientT);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function call(p: VerifiedToken, args: Record<string, unknown>) {
  return withClient(p, async (client) => {
    const res = await client.callTool({ name: "audit_list", arguments: args });
    const text = (res.content as { type: string; text?: string }[])
      .map((c) => c.text ?? "")
      .join("");
    return { isError: res.isError === true, text };
  });
}

describe("audit_list tenant targeting over MCP", () => {
  // THE SCHEMA IS A GATE OF ITS OWN, and it is the one that refuses before any code of ours runs:
  // a required `tenant` makes the SDK reject the call with a validation error, so no handler branch
  // could have rescued it.
  test("the selector is optional on this tool, and required on the others", async () => {
    const required = await withClient(principal(), async (client) => {
      const { tools } = await client.listTools();
      return new Map(
        tools.map((t) => [
          t.name,
          ((t.inputSchema as { required?: string[] }).required ??
            []) as string[],
        ]),
      );
    });
    expect(required.get("audit_list")).not.toContain("tenant");
    // The rule it is an exception to. `agent_list` has no scope to widen and reads one tenant only.
    expect(required.get("agent_list")).toContain("tenant");
  });

  for (const scope of ["fleet", "all"] as const) {
    test(`the wrapper lets a targetless ${scope} read through`, async () => {
      const r = await call(principal(), { scope, limit: 1 });
      expect(r.text).not.toContain(ASKS_FOR_A_TARGET);
    });
  }

  // The default is unchanged: the tenant trail cannot say WHICH tenant without a target, so that
  // scope still demands one and says so.
  test("the tenant scope still asks for a target", async () => {
    const r = await call(principal(), { limit: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(ASKS_FOR_A_TARGET);
  });

  // Ignoring the target would answer "acme plus the fleet rows" -- which is what an agent passing
  // both almost certainly meant -- with EVERY tenant's rows, presented as the answer.
  test("naming a tenant alongside a fleet scope is refused, not ignored", async () => {
    const r = await call(principal(), {
      scope: "all",
      tenant: "acme",
      limit: 1,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("scope");
    expect(r.text).not.toContain(ASKS_FOR_A_TARGET);
  });

  // A tenant-scoped token never sees the selector at all, so there is nothing to make optional.
  test("a tenant token is offered no selector on any tool", async () => {
    const required = await withClient(
      principal({ tenantId: 1n, role: "TENANT_ADMIN" }),
      async (client) => {
        const { tools } = await client.listTools();
        return new Map(
          tools.map((t) => [
            t.name,
            Object.keys(
              (t.inputSchema as { properties?: Record<string, unknown> })
                .properties ?? {},
            ),
          ]),
        );
      },
    );
    expect(required.get("audit_list")).not.toContain("tenant");
    expect(required.get("agent_list")).not.toContain("tenant");
  });
});

describe.skipIf(!dbUp)("what a targetless audit_list actually reads", () => {
  let mine = 0n;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "M520", slug: `m520-${process.pid}` },
    });
    mine = t.id;
    const ctx: TenantContext = {
      tenantId: mine,
      userId: USER,
      role: "SUPER_ADMIN",
    };
    await runScopedOn(appDb, ctx, (db) =>
      recordAudit(db, mine, {
        action: syntheticAction("agent.create"),
        target: `${TAG}:mine`,
        actorId: USER,
        actorType: "user",
      }),
    );
    await asSuperAdminOn(appDb, (db) =>
      recordAudit(db, null, {
        action: syntheticAction("mcp_client.create"),
        target: `${TAG}:fleet`,
        actorId: USER,
        actorType: "user",
      }),
    );
  });

  afterAll(async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE target LIKE '${TAG}:%'`,
    );
    if (mine) {
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${mine}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  const read = (p: VerifiedToken, args: Record<string, unknown>) =>
    auditList(p, { limit: 500, ...args }, { base: appDb });

  test("fleet reaches the rows keyed to no tenant, with no tenant selected", async () => {
    const r = await read(principal(), { scope: "fleet" });
    const text = JSON.stringify(r);
    expect(text).toContain(`${TAG}:fleet`);
    expect(text).not.toContain(`${TAG}:mine`);
  });

  // `all` is the one that must ALSO reach the tenant rows: a fleet read that stopped at the
  // NULL-tenant slice would answer the widest ask with the narrowest trail.
  test("all reaches both, still with no tenant selected", async () => {
    const text = JSON.stringify(await read(principal(), { scope: "all" }));
    expect(text).toContain(`${TAG}:fleet`);
    expect(text).toContain(`${TAG}:mine`);
  });

  // BOTH DOORS AGREE ON THE CURSOR TOO. The REST endpoint answers a pre-#530 cursor with a 400; this
  // one has to refuse it as well, and for the same reason -- read as the new key it would continue
  // the walk from somewhere else while the caller believes it is paging the same trail. An agent
  // that stored a cursor is the likeliest holder of an old one.
  test("a cursor that is neither shape is refused here too", async () => {
    for (const bad of [
      "abc",
      "|",
      "2026-01-01T00:00:00.000Z|x",
      "9".repeat(40),
    ]) {
      const r = await read(
        principal({ tenantId: mine, role: "TENANT_ADMIN" }),
        {
          cursor: bad,
        },
      );
      expect(JSON.stringify(r)).toContain("nextCursor` from a previous");
    }
  });

  // AND A BARE ID FROM THE PREVIOUS RELEASE IS READ AS THAT RELEASE'S OWN BOUND, not refused: an
  // agent that stored one mid-walk keeps walking, from the same place that cursor named rather than
  // from a different one. Both doors agree on that, as they do on the refusals above.
  test("a bare id from before the keyset change continues the same walk", async () => {
    const p = principal();
    const first = (await auditList(
      p,
      { limit: 1, scope: "all" },
      { base: appDb },
    )) as { ok: true; data: { nextCursor: string | null } };
    const cursor = first.data.nextCursor ?? "";
    const bareId = cursor.split("|")[1] as string;
    const viaOld = await auditList(
      p,
      { limit: 1, scope: "all", cursor: bareId },
      { base: appDb },
    );
    const viaNew = await auditList(
      p,
      { limit: 1, scope: "all", cursor },
      { base: appDb },
    );
    expect(JSON.stringify(viaOld)).not.toContain("nextCursor` from a previous");
    const rows = (r: unknown) =>
      JSON.stringify((r as { data: { entries: unknown } }).data.entries);
    expect(rows(viaOld)).toBe(rows(viaNew));

    // ...and the bound holds for the WHOLE walk, not just its first page: every id it hands back
    // stays under the ceiling the old release stopped at, and none comes back twice. Asserted over
    // the walk rather than over one `nextCursor`, because how many pages this shared fixture yields
    // is not this test's to know -- pinned to a second page it passed here and failed on a CI shard
    // where the `all` trail had one row under the bound.
    const seen: string[] = [];
    let at: string | null = bareId;
    for (let i = 0; i < 20 && at; i++) {
      const page = (await auditList(
        p,
        { limit: 1, scope: "all", cursor: at },
        { base: appDb },
      )) as {
        ok: true;
        data: { entries: { id: string }[]; nextCursor: string | null };
      };
      seen.push(...page.data.entries.map((e) => e.id));
      at = page.data.nextCursor;
      // While the walk continues, the ceiling travels with it.
      if (at) expect(at.split("|")[2]).toBe(bareId);
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of seen) expect(BigInt(id) < BigInt(bareId)).toBe(true);
  });

  // A BARE ID IS A BOUND AND NOT A LOOKUP, so it cannot reach across trails at all -- which is what
  // the earlier resolving version had to be scoped by hand to avoid, because `fleet` and `all` are
  // read under the fleet role where every row is visible and RLS separates nothing. A number
  // narrowing a walk names no row, so a tenant row's id offered to the fleet trail is just a smaller
  // ceiling: the walk stays on the fleet trail, and there is no id whose existence this answer
  // reveals.
  test("a bare id from another trail bounds the walk without reaching it", async () => {
    const p = principal();
    // The id of a row that belongs to a tenant, offered as a cursor for the fleet trail.
    const mineRow = (await auditList(
      principal({ tenantId: mine, role: "TENANT_ADMIN" }),
      { limit: 1 },
      { base: appDb },
    )) as { ok: true; data: { entries: { id: string }[] } };
    const tenantRowId = mineRow.data.entries[0]?.id as string;
    expect(tenantRowId).toBeTruthy();

    const r = await auditList(
      p,
      { limit: 500, scope: "fleet", cursor: tenantRowId },
      { base: appDb },
    );
    const text = JSON.stringify(r);
    expect(text).not.toContain("nextCursor` from a previous");
    // Still the fleet trail, whichever trail the number came from.
    expect(text).not.toContain(`${TAG}:mine`);
  });

  // THE UNAUTHORIZED SCOPE IS STILL THE TOOL'S OWN ERROR, cursor or no cursor. Resolving a bare id
  // needed the trail predicate, which needs the scope, which throws for a caller who may not ask for
  // it -- and it threw OUTSIDE the handler's `try`, so this one combination rejected the promise
  // instead of answering with `isError` like every other refusal (round 9 of #537). Reading the id
  // as a bound touches neither the scope nor the database, so the refusal comes from the one place
  // it always did.
  test("an unauthorized scope answers the same way with a bare cursor as without", async () => {
    const tenantAdmin = principal({ tenantId: mine, role: "TENANT_ADMIN" });
    for (const scope of ["fleet", "all"]) {
      const bare = await auditList(
        tenantAdmin,
        { limit: 1, scope, cursor: "115" },
        { base: appDb },
      );
      const none = await auditList(
        tenantAdmin,
        { limit: 1, scope },
        { base: appDb },
      );
      expect(JSON.stringify(bare)).toBe(JSON.stringify(none));
      expect(JSON.stringify(bare)).toContain("SUPER_ADMIN");
    }
  });

  test("the cursor this tool handed out is accepted, and continues the walk", async () => {
    // `all`, because it is the scope that reaches more than one row here and a cursor only exists
    // when there is a next page.
    const p = principal();
    const first = (await auditList(
      p,
      { limit: 1, scope: "all" },
      { base: appDb },
    )) as {
      ok: true;
      data: { nextCursor: string | null };
    };
    const cursor = first.data.nextCursor ?? "";
    expect(cursor).toContain("|");
    const second = await auditList(
      p,
      { limit: 1, scope: "all", cursor },
      { base: appDb },
    );
    expect(JSON.stringify(second)).not.toContain("nextCursor` from a previous");
    // ...and it really moved: the second page is not the first one again.
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
  });

  test("a tenant token still reads its own trail and only that", async () => {
    const text = JSON.stringify(
      await read(principal({ tenantId: mine, role: "TENANT_ADMIN" }), {}),
    );
    expect(text).toContain(`${TAG}:mine`);
    expect(text).not.toContain(`${TAG}:fleet`);
  });

  test("and is refused the wider scopes rather than narrowed to itself", async () => {
    const text = JSON.stringify(
      await read(principal({ tenantId: mine, role: "TENANT_ADMIN" }), {
        scope: "fleet",
      }),
    );
    expect(text).not.toContain(`${TAG}:mine`);
    expect(text).not.toContain(`${TAG}:fleet`);
  });
});
