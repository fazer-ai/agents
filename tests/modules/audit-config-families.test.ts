import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { refForAudit } from "@/modules/audit/projection";
import {
  createDocumentTemplate,
  deleteDocumentTemplate,
  updateDocumentTemplate,
} from "@/modules/documents/templates";
import {
  createExperiment,
  deleteExperiment,
  updateExperiment,
} from "@/modules/experiments/service";
import {
  createIntegrationInstance,
  deleteIntegrationInstance,
  rotateIntegrationRouteToken,
  updateIntegrationInstance,
} from "@/modules/integrations/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { mcpConnectionCreate, toolCreate } from "@/modules/mcp/write-agents";
import { documentTemplateCreate } from "@/modules/mcp/write-documents";
import { experimentCreate } from "@/modules/mcp/write-settings";
import { integrationCreate } from "@/modules/mcp/write-webhooks";
import {
  createMcpConnection,
  deleteMcpConnection,
  updateMcpConnection,
} from "@/modules/mcp-connections/service";
import {
  createToolDefinition,
  deleteToolDefinition,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";
import { outboundUrl } from "../utils/outbound";

// Five configuration families whose trail was written by the MCP transport and by nothing else.
//
// The seam (#392) puts the row inside the service, in the mutation's own transaction, so it covers
// whichever door the change came through. This file is the family measurement for the five that
// were still on the transport: tool definitions, MCP connections, integration instances,
// experiments and document templates (issue #399). What makes it one file rather than five is that
// the five have the same shape — three routes over one service — so the assertion is a matrix over
// the shape, and a family that stops matching it falls out as a failing row rather than as a file
// nobody wrote.

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
let tenantId = 0n;

const USER = 9399n;

const ctx = (over: Partial<TenantContext> = {}): TenantContext => ({
  tenantId,
  userId: USER,
  role: "TENANT_ADMIN",
  ...over,
});

const principal = (over: Partial<VerifiedToken> = {}): VerifiedToken => ({
  userId: USER,
  tenantId,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read", "mcp:write"],
  clientId: "c",
  jti: "j",
  ...over,
});

async function rows(action?: string) {
  return (
    (await su?.auditLog.findMany({
      where: { tenantId, ...(action ? { action } : {}) },
      orderBy: { id: "asc" },
    })) ?? []
  );
}

async function clearAudit() {
  await su?.$executeRawUnsafe(
    `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
  );
}

// One family = the three mutations plus what the row should name. `create` returns the id the
// other two operate on, so the matrix never needs to know how a family spells its own DTO.
interface Family {
  key: string;
  entity: string;
  create: (c: TenantContext) => Promise<bigint>;
  update: (c: TenantContext, id: bigint) => Promise<unknown>;
  del: (c: TenantContext, id: bigint) => Promise<unknown>;
  // The field the update above moves, and the two values it moves it between. The row has to show
  // BOTH, because a projection that carries only the new value cannot say what was replaced.
  movedField: string;
  movedFrom: unknown;
  movedTo: unknown;
}

const uniq = () => `${process.pid}${Math.floor(Math.random() * 1e6)}`;

const FAMILIES: Family[] = [
  {
    key: "tool",
    entity: "tool",
    create: async (c) => {
      const t = await createToolDefinition(
        c,
        {
          name: `t${uniq()}`,
          label: "before",
          urlTemplate: outboundUrl("/x"),
          allowedHosts: ["203.0.113.10"],
        },
        appDb,
      );
      return BigInt(t.id);
    },
    update: (c, id) => updateToolDefinition(c, id, { label: "after" }, appDb),
    del: (c, id) => deleteToolDefinition(c, id, appDb),
    movedField: "label",
    movedFrom: "before",
    movedTo: "after",
  },
  {
    key: "mcp_connection",
    entity: "mcp_connection",
    create: async (c) => {
      const m = await createMcpConnection(
        c,
        {
          name: `m${uniq()}`,
          transport: "streamableHttp",
          url: outboundUrl("/mcp"),
          enabled: true,
        },
        appDb,
      );
      return BigInt(m.id);
    },
    update: (c, id) => updateMcpConnection(c, id, { enabled: false }, appDb),
    del: (c, id) => deleteMcpConnection(c, id, appDb),
    movedField: "enabled",
    movedFrom: true,
    movedTo: false,
  },
  {
    key: "integration",
    entity: "integration",
    create: async (c) => {
      const i = await createIntegrationInstance(
        c,
        { catalogType: "ASAAS", name: `i${uniq()}` },
        appDb,
      );
      return i.id;
    },
    update: (c, id) =>
      updateIntegrationInstance(c, id, { enabled: false }, appDb),
    del: (c, id) => deleteIntegrationInstance(c, id, appDb),
    movedField: "enabled",
    movedFrom: true,
    movedTo: false,
  },
  {
    key: "experiment",
    entity: "experiment",
    create: async (c) => {
      const e = await createExperiment({
        ctx: c,
        name: `e${uniq()}`,
        variants: [
          { key: "a", systemPrompt: "A", weight: 1 },
          { key: "b", systemPrompt: "B", weight: 1 },
        ],
        base: appDb,
      });
      return e.id;
    },
    update: (c, id) =>
      updateExperiment({ ctx: c, id, enabled: false, base: appDb }),
    del: (c, id) => deleteExperiment(c, id, appDb),
    movedField: "enabled",
    movedFrom: true,
    movedTo: false,
  },
  {
    key: "document_template",
    entity: "document_template",
    create: async (c) => {
      const d = await createDocumentTemplate(
        c,
        {
          name: `d${uniq()}`,
          blocks: [{ id: "t", type: "text", text: "before" }],
          fields: [],
        },
        appDb,
      );
      return BigInt(d.id);
    },
    update: (c, id) => updateDocumentTemplate(c, id, { enabled: false }, appDb),
    del: (c, id) => deleteDocumentTemplate(c, id, appDb),
    movedField: "enabled",
    movedFrom: true,
    movedTo: false,
  },
];

describe.skipIf(!dbUp)(
  "the five families record from their own service",
  () => {
    beforeAll(async () => {
      if (!su) return;
      const t = await su.tenant.create({
        data: { name: "AUD399", slug: `aud399-${process.pid}` },
      });
      tenantId = t.id;
    });

    afterAll(async () => {
      if (su && tenantId) {
        for (const table of [
          "audit_logs",
          "tool_definitions",
          "mcp_server_connections",
          "integration_instances",
          "experiments",
          "document_templates",
          "vault_entries",
          "agents",
        ]) {
          await su.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          );
        }
        await su.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
      await su?.$disconnect();
      await app?.$disconnect();
    });

    for (const f of FAMILIES) {
      describe(f.key, () => {
        test("creating one through the service writes the row the MCP tool used to write", async () => {
          await clearAudit();
          const id = await f.create(ctx());
          const r = await rows(`${f.entity}.create`);
          expect(r.length).toBe(1);
          expect(r[0]?.target).toBe(`${f.entity}:${id}`);
          expect(r[0]?.actorId).toBe(USER);
          expect(r[0]?.actorType).toBe("user");
          await f.del(ctx(), id);
        });

        test("an update carries what changed, before and after", async () => {
          const id = await f.create(ctx());
          await clearAudit();
          await f.update(ctx(), id);
          const r = await rows(`${f.entity}.update`);
          expect(r.length).toBe(1);
          const [only] = r;
          expect(
            (only?.before as Record<string, unknown> | undefined)?.[
              f.movedField
            ],
          ).toEqual(f.movedFrom);
          expect(
            (only?.after as Record<string, unknown> | undefined)?.[
              f.movedField
            ],
          ).toEqual(f.movedTo);
          await f.del(ctx(), id);
        });

        test("a delete leaves the record of what was deleted", async () => {
          const id = await f.create(ctx());
          await clearAudit();
          await f.del(ctx(), id);
          const r = await rows(`${f.entity}.delete`);
          expect(r.length).toBe(1);
          expect(r[0]?.target).toBe(`${f.entity}:${id}`);
          expect(r[0]?.before).not.toBeNull();
          expect(r[0]?.after).toBeNull();
        });

        test("a refused mutation writes no row", async () => {
          await clearAudit();
          await expect(f.update(ctx(), 999999999n)).rejects.toThrow();
          expect((await rows()).length).toBe(0);
        });

        test("the door is on the row, so an MCP context is not a browser session", async () => {
          await clearAudit();
          const id = await f.create(ctx({ actorType: "mcp" }));
          const r = await rows(`${f.entity}.create`);
          expect(r[0]?.actorType).toBe("mcp");
          await f.del(ctx(), id);
        });
      });
    }

    // ── the transport writes ONE row, and it is the service's ──
    //
    // The tools used to build the row themselves, one layer up and in a second transaction. Removing
    // that without the service writing one would have left the MCP door recording nothing, and
    // leaving it in would have double-recorded every apply — so the count is the assertion, not the
    // presence.

    const MCP_APPLY: {
      entity: string;
      run: (dryRun: boolean) => Promise<unknown>;
    }[] = [
      {
        entity: "tool",
        run: (dry_run) =>
          toolCreate(
            principal(),
            {
              name: `mt${uniq()}`,
              label: "l",
              url_template: outboundUrl("/x"),
              allowed_hosts: ["203.0.113.10"],
              dry_run,
            },
            { base: appDb },
          ),
      },
      {
        entity: "mcp_connection",
        run: (dry_run) =>
          mcpConnectionCreate(
            principal(),
            {
              name: `mm${uniq()}`,
              transport: "streamableHttp",
              url: outboundUrl("/mcp"),
              dry_run,
            },
            { base: appDb },
          ),
      },
      {
        entity: "integration",
        run: (dry_run) =>
          integrationCreate(
            principal(),
            { catalog_type: "ASAAS", name: `mi${uniq()}`, dry_run },
            { base: appDb },
          ),
      },
      {
        entity: "experiment",
        run: (dry_run) =>
          experimentCreate(
            principal(),
            {
              name: `me${uniq()}`,
              variants: [
                { key: "a", system_prompt: "A" },
                { key: "b", system_prompt: "B" },
              ],
              dry_run,
            },
            { base: appDb },
          ),
      },
      {
        entity: "document_template",
        run: (dry_run) =>
          documentTemplateCreate(
            principal(),
            {
              name: `md${uniq()}`,
              blocks: [{ id: "t", type: "text", text: "x" }],
              fields: [],
              dry_run,
            },
            { base: appDb },
          ),
      },
    ];

    for (const m of MCP_APPLY) {
      test(`applying ${m.entity} over MCP writes one row, not one per layer`, async () => {
        await clearAudit();
        const res = (await m.run(false)) as { ok?: boolean };
        expect(res.ok).toBe(true);
        const r = await rows(`${m.entity}.create`);
        expect(r.length).toBe(1);
        expect(r[0]?.actorType).toBe("mcp");
      });

      test(`a dry run of ${m.entity} applies nothing and records nothing`, async () => {
        await clearAudit();
        const res = (await m.run(true)) as { ok?: boolean; data?: unknown };
        expect(res.ok).toBe(true);
        expect((res.data as { dryRun?: boolean }).dryRun).toBe(true);
        expect((await rows()).length).toBe(0);
      });
    }

    test("rotating an inbound route token is recorded, and the token is not in the row", async () => {
      const id = (await FAMILIES[2]?.create(ctx())) as bigint;
      await clearAudit();
      const { routeToken } = await rotateIntegrationRouteToken(
        ctx(),
        id,
        appDb,
      );
      const r = await rows("integration.rotate_token");
      expect(r.length).toBe(1);
      expect(r[0]?.target).toBe(`integration:${id}`);
      expect(
        JSON.stringify(r[0], (_k, v) =>
          typeof v === "bigint" ? String(v) : v,
        ),
      ).not.toContain(routeToken);
      await FAMILIES[2]?.del(ctx(), id);
    });

    // ── the snapshot is read under the write's lock ──
    //
    // At READ COMMITTED two concurrent writers both read state A; the first commits B; the second's
    // own write blocks, wakes, and would file a row saying A became C — attributing B's change to
    // whoever wrote C. The proof is A/B with a delay in the WRITER, because reading the code proves
    // the statement is there and not that it serializes anything: remove the `FOR UPDATE` from the
    // family under test and the assertion below goes red.

    const LOCKED: {
      key: string;
      table: string;
      column: string;
      holderValue: string;
      make: () => Promise<bigint>;
      update: (id: bigint) => Promise<unknown>;
      del: (id: bigint) => Promise<unknown>;
      heldBefore: Record<string, unknown>;
    }[] = [
      {
        key: "tool",
        table: "tool_definitions",
        column: "label",
        holderValue: "'held'",
        make: () => (FAMILIES[0] as Family).create(ctx()),
        update: (id) =>
          updateToolDefinition(ctx(), id, { enabled: false }, appDb),
        del: (id) => deleteToolDefinition(ctx(), id, appDb),
        heldBefore: { label: "held" },
      },
      {
        key: "mcp_connection",
        table: "mcp_server_connections",
        column: "name",
        holderValue: "'held-mcp'",
        make: () => (FAMILIES[1] as Family).create(ctx()),
        update: (id) =>
          updateMcpConnection(ctx(), id, { enabled: false }, appDb),
        del: (id) => deleteMcpConnection(ctx(), id, appDb),
        heldBefore: { name: "held-mcp" },
      },
      {
        key: "integration",
        table: "integration_instances",
        column: "name",
        holderValue: "'held-int'",
        make: () => (FAMILIES[2] as Family).create(ctx()),
        update: (id) =>
          updateIntegrationInstance(ctx(), id, { enabled: false }, appDb),
        del: (id) => deleteIntegrationInstance(ctx(), id, appDb),
        heldBefore: { name: "held-int" },
      },
      {
        key: "experiment",
        table: "experiments",
        column: "name",
        holderValue: "'held-exp'",
        make: () => (FAMILIES[3] as Family).create(ctx()),
        update: (id) =>
          updateExperiment({ ctx: ctx(), id, enabled: false, base: appDb }),
        del: (id) => deleteExperiment(ctx(), id, appDb),
        heldBefore: { name: "held-exp" },
      },
      {
        key: "document_template",
        table: "document_templates",
        column: "description",
        holderValue: "'held-doc'",
        make: () => (FAMILIES[4] as Family).create(ctx()),
        update: (id) =>
          updateDocumentTemplate(ctx(), id, { enabled: false }, appDb),
        del: (id) => deleteDocumentTemplate(ctx(), id, appDb),
        heldBefore: { description: "held-doc" },
      },
    ];

    // A writer that commits while the caller under test is between its own read and its own write.
    async function underHolder(
      l: (typeof LOCKED)[number],
      id: bigint,
      run: () => Promise<unknown>,
    ) {
      let held = false;
      const holder = (su as PrismaClient).$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE ${l.table} SET ${l.column} = ${l.holderValue} WHERE id = ${id}`,
          );
          held = true;
          await Bun.sleep(500);
        },
        { timeout: 10_000 },
      );
      await Bun.sleep(120);
      // The rendezvous FIRED: without this the test is a `sleep` with a better name.
      expect(held).toBe(true);
      await Promise.all([holder, run()]);
    }

    for (const l of LOCKED) {
      test(`${l.key}: an update archives what the holder left, not what it read first`, async () => {
        const id = await l.make();
        await clearAudit();
        await underHolder(l, id, () => l.update(id));
        const [row] = await rows(`${l.key}.update`);
        expect(row?.before).toMatchObject(l.heldBefore);
        await l.del(id);
      });

      test(`${l.key}: a delete archives what the holder left`, async () => {
        const id = await l.make();
        await clearAudit();
        await underHolder(l, id, () => l.del(id));
        const [row] = await rows(`${l.key}.delete`);
        expect(row?.before).toMatchObject(l.heldBefore);
      });
    }

    // ── a save that moves nothing writes nothing ──

    for (const f of FAMILIES) {
      test(`${f.key}: a save that moves nothing writes no row`, async () => {
        const id = await f.create(ctx());
        await clearAudit();
        // The console PATCHes a whole editor tab per save, so a caller setting a field to the value
        // it already holds is the ordinary case rather than a degenerate one.
        await f.update(ctx(), id);
        await f.update(ctx(), id);
        // Two applies, one change: the second moved nothing.
        expect((await rows()).map((r) => r.action)).toEqual([
          `${f.entity}.update`,
        ]);
        await f.del(ctx(), id);
      });
    }

    // ── a reference the read cannot show is still a change when it is cleared ──

    test("clearing an unreadable credential ref writes a row, because the projection marks it", async () => {
      const id = await (FAMILIES[0] as Family).create(ctx());
      // Planted with the SUPERUSER client, past the guard that has refused this spelling on the way
      // in since #126: the column predates that guard and the rows it wrote are still there.
      await su?.$executeRawUnsafe(
        `UPDATE tool_definitions SET credential_ref = 'sk-live-399-not-a-reference' WHERE id = ${id}`,
      );
      await clearAudit();
      await updateToolDefinition(ctx(), id, { credentialRef: null }, appDb);
      const [row] = await rows("tool.update");
      // Without `credentialRefOpaque` both sides of this change read as `credentialRef: null` —
      // `readableVaultRef` shows the stored value only where it IS a reference (#438) — so
      // `projectionMoved` would see nothing and the one save that removed a credential would write
      // no row at all.
      expect(row).toBeDefined();
      expect(row?.before).toMatchObject({
        credentialRef: null,
        credentialRefOpaque: true,
      });
      expect(row?.after).toMatchObject({
        credentialRef: null,
        credentialRefOpaque: false,
      });
      // And the value itself is nowhere in the row.
      expect(
        JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
      ).not.toContain("sk-live-399-not-a-reference");
      await (FAMILIES[0] as Family).del(ctx(), id);
    });

    test("the marker is the predicate, over values the tree does not hold", () => {
      // Positive control: a fence over a clean tree reports nothing either way.
      expect(refForAudit(null)).toEqual({ ref: null, opaque: false });
      expect(refForAudit("vault:7")).toEqual({ ref: "vault:7", opaque: false });
      expect(refForAudit("sk-live-x")).toEqual({ ref: null, opaque: true });
      // A ref whose entry is gone is still a ref: `readableVaultRef` answers for the SPELLING, not
      // for whether the row survives, and an audit row outlives the entry it names by design.
      expect(refForAudit("vault:999999999")).toEqual({
        ref: "vault:999999999",
        opaque: false,
      });
    });

    // ── what a projection may NOT hold ──
    //
    // Three of the five families own a field that is large, free-form, or both, and none of the three
    // is an allowlist on the way in. A row is append-only and readable by every tenant admin, so what
    // goes on it is the SHAPE of those fields and never their contents.

    test("an integration's config contributes its keys and not its values", async () => {
      const created = await createIntegrationInstance(
        ctx(),
        {
          catalogType: "ASAAS",
          name: `cfg${uniq()}`,
          config: { pixKey: "typed-by-the-operator-399", timeoutMs: 5000 },
        },
        appDb,
      );
      const [row] = await rows("integration.create");
      expect(row?.after).toMatchObject({ configKeys: ["pixKey", "timeoutMs"] });
      expect(
        JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
      ).not.toContain("typed-by-the-operator-399");
      await deleteIntegrationInstance(ctx(), created.id, appDb);
    });

    test("an experiment records the split and not the prompts it splits between", async () => {
      await clearAudit();
      const e = await createExperiment({
        ctx: ctx(),
        name: `p${uniq()}`,
        variants: [
          { key: "a", systemPrompt: "PROMPT-A-399", weight: 3 },
          { key: "b", systemPrompt: "PROMPT-B-399", weight: 1 },
        ],
        base: appDb,
      });
      const [row] = await rows("experiment.create");
      expect(row?.after).toMatchObject({
        variants: [
          { key: "a", weight: 3 },
          { key: "b", weight: 1 },
        ],
      });
      const text = JSON.stringify(row, (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      );
      expect(text).not.toContain("PROMPT-A-399");
      expect(text).not.toContain("PROMPT-B-399");
      await deleteExperiment(ctx(), e.id, appDb);
    });

    test("a template edit inside a block is visible as a change without the text being in the row", async () => {
      const created = await createDocumentTemplate(
        ctx(),
        {
          name: `dg${uniq()}`,
          blocks: [{ id: "t", type: "text", text: "ORIGINAL-399" }],
          fields: [],
        },
        appDb,
      );
      const id = BigInt(created.id);
      await clearAudit();
      await updateDocumentTemplate(
        ctx(),
        id,
        { blockText: { t: "REPLACED-399" } },
        appDb,
      );
      const [row] = await rows("document_template.update");
      // The structure did not move — same block, same id, same type — so without the digest this
      // edit, which is the commonest one a template gets, would write no row.
      expect(row).toBeDefined();
      const before = row?.before as { contentDigest: string; blocks: unknown };
      const after = row?.after as { contentDigest: string; blocks: unknown };
      expect(before.blocks).toEqual(after.blocks);
      expect(before.contentDigest).not.toBe(after.contentDigest);
      const text = JSON.stringify(row, (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      );
      expect(text).not.toContain("ORIGINAL-399");
      expect(text).not.toContain("REPLACED-399");
      await deleteDocumentTemplate(ctx(), id, appDb);
    });

    // ── the two routes that look like mutations and are not ──
    //
    // Asserted on the SOURCE rather than by driving them, and the reason is the discover: it opens a
    // real MCP connection, so a behavioural probe against a fixture host spends the network timeout
    // and then proves nothing the read of the function does not already say. What is being claimed is
    // that neither function contains a write to the trail, and that is a property of the text.
    //
    // `docs/mcp.md` records the same decision for the MCP twin of the first one (#397): the trail
    // records changes, and these two change nothing.

    test("discover and preview record nothing, and the predicate can tell", async () => {
      const conns = await Bun.file(
        "src/modules/mcp-connections/service.ts",
      ).text();
      const docs = await Bun.file("src/modules/documents/templates.ts").text();
      const bodyOf = (src: string, fn: string) => {
        const start = [`export async function ${fn}(`, `export function ${fn}(`]
          .map((a) => src.indexOf(a))
          .find((i) => i >= 0);
        if (start === undefined) throw new Error(`${fn} not found`);
        const next = src.indexOf("\nexport ", start + 1);
        return src.slice(start, next < 0 ? undefined : next);
      };
      // Positive control, on this same file's own writers: the predicate finds the call where there
      // IS one, so a green below is the absence of a write and not a broken matcher.
      expect(bodyOf(conns, "createMcpConnection")).toContain("auditMutation(");
      expect(bodyOf(docs, "createDocumentTemplate")).toContain(
        "auditMutation(",
      );

      expect(bodyOf(conns, "discoverMcpTools")).not.toContain("auditMutation(");
      expect(bodyOf(docs, "previewDocumentTemplate")).not.toContain(
        "auditMutation(",
      );
    });
  },
);
