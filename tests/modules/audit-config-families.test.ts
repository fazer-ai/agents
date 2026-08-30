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

    // The rotation takes the SAME lock, and it is the one site where the snapshot is the whole row.
    // Neither token is on it, so `name` and `catalogType` are all that identify what was rotated:
    // a rename committing in the window makes the trail say the old name lost its URL.
    test("integration: a rotation archives the name the holder left", async () => {
      const l = LOCKED[2] as (typeof LOCKED)[number];
      const id = await l.make();
      await clearAudit();
      await underHolder(l, id, () =>
        rotateIntegrationRouteToken(ctx(), id, appDb),
      );
      const [row] = await rows("integration.rotate_token");
      expect(row?.after).toMatchObject({ name: "held-int" });
      await l.del(id);
    });

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

    // The allowlist is `z.string().min(1).max(255)` per entry and nothing more, and it sits beside
    // the URL field in the editor, so a pasted URL lands in it. It never WORKS there — the gate
    // compares `allowedHosts.includes(url.hostname)` — but it would have been archived whole beside
    // a `urlTemplate` redacted for exactly this reason.
    test("a token pasted into a tool's host allowlist does not reach the row", async () => {
      await clearAudit();
      const created = await createToolDefinition(
        ctx(),
        {
          name: `ah${uniq()}`,
          label: "l",
          urlTemplate: "https://203.0.113.10/hook",
          allowedHosts: [
            "203.0.113.10",
            "203.0.113.10/hook/tok-399-in-a-host-entry",
          ],
        },
        appDb,
      );
      const [row] = await rows("tool.create");
      const text = JSON.stringify(row, (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      );
      expect(text).not.toContain("tok-399-in-a-host-entry");
      // The bare host is still shown: the allowlist IS the policy, and a reader needs it.
      expect(text).toContain("203.0.113.10");
      await deleteToolDefinition(ctx(), BigInt(created.id), appDb);
    });

    // NEITHER the values NOR the key names. `config` is `z.record(z.string(), z.unknown())` on both
    // writers, so an operator names its keys as freely as they fill them, and #394 settled that an
    // unknown, caller-controlled key can itself be secret material.
    test("an integration's config contributes neither its values nor its key names", async () => {
      const created = await createIntegrationInstance(
        ctx(),
        {
          catalogType: "ASAAS",
          name: `cfg${uniq()}`,
          config: {
            "pix-key-399-typed-by-the-operator": "value-399-typed-too",
            timeoutMs: 5000,
          },
        },
        appDb,
      );
      const [row] = await rows("integration.create");
      const text = JSON.stringify(row, (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      );
      expect(text).not.toContain("value-399-typed-too");
      expect(text).not.toContain("pix-key-399-typed-by-the-operator");
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
      // The structure did not move — same block, same id, same type — so without the compared
      // half this edit, which is the commonest one a template gets, would write no row.
      expect(row).toBeDefined();
      const before = row?.before as {
        undisclosedChanged?: true;
        blocks: unknown;
      };
      const after = row?.after as {
        undisclosedChanged?: true;
        blocks: unknown;
      };
      expect(before?.blocks).toEqual(after?.blocks);
      expect(before?.undisclosedChanged).toBe(true);
      expect(after?.undisclosedChanged).toBe(true);
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

    // The row says THAT the undisclosed half moved and nothing about what it holds — not the value
    // and not a fingerprint of one. A fingerprint would be an offline verifier: `audit_logs` is
    // append-only and readable by every tenant admin long after the record is deleted, and a reader
    // holding a candidate could hash it and confirm. The proof is that two different contents leave
    // audit rows that are byte-identical, which no derived value survives.
    test("two different undisclosed contents leave identical rows", async () => {
      // ONE definition, edited twice: the projected half is identity and policy, so a second tool
      // would differ by its name alone and prove nothing about the half under test.
      const id = await (FAMILIES[0] as Family).create(ctx());
      const project = async (headers: Record<string, string>) => {
        await clearAudit();
        await updateToolDefinition(ctx(), id, { headers }, appDb);
        const [row] = await rows("tool.update");
        return JSON.stringify({ before: row?.before, after: row?.after });
      };
      const one = await project({ "X-Key": "candidate-a-399" });
      const other = await project({ "X-Key": "candidate-b-399" });
      // Both rows exist — the write is NOT being suppressed, which is the other half of the rule.
      expect(one).toContain("undisclosedChanged");
      expect(one).toBe(other);
      await (FAMILIES[0] as Family).del(ctx(), id);
    });

    // ── the half that is compared and not carried, and why it is not optional ──
    //
    // Review round 1 found five columns that changed without the projection noticing. Each one below
    // is an ORDINARY edit of its family, and each writes no row at all when its column is in neither
    // half of the projection.

    test("a tool patch that touches only an omitted field still writes a row", async () => {
      const id = await (FAMILIES[0] as Family).create(ctx());
      await clearAudit();
      // `headers` is not projected — a header name and value are the caller's to write and the row
      // may not keep them — and editing the headers of an HTTP tool is the ordinary edit it gets.
      await updateToolDefinition(
        ctx(),
        id,
        { headers: { "X-Trace": "on" } },
        appDb,
      );
      const r = await rows("tool.update");
      expect(r.length).toBe(1);
      const before = r[0]?.before as { undisclosedChanged?: true } | undefined;
      const after = r[0]?.after as { undisclosedChanged?: true } | undefined;
      expect(before?.undisclosedChanged).toBe(true);
      expect(after?.undisclosedChanged).toBe(true);
      await (FAMILIES[0] as Family).del(ctx(), id);
    });

    test("a token in a tool's url template does not reach the row", async () => {
      await clearAudit();
      const created = await createToolDefinition(
        ctx(),
        {
          name: `tu${uniq()}`,
          label: "l",
          urlTemplate:
            "https://203.0.113.10/hook/tok-399-in-the-path?k=tok-399-in-the-query",
          allowedHosts: ["203.0.113.10"],
        },
        appDb,
      );
      const [row] = await rows("tool.create");
      expect((row?.after as { urlMasked: string } | undefined)?.urlMasked).toBe(
        "https://203.0.113.10/…",
      );
      const text = JSON.stringify(row, (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      );
      expect(text).not.toContain("tok-399-in-the-path");
      expect(text).not.toContain("tok-399-in-the-query");
      await deleteToolDefinition(ctx(), BigInt(created.id), appDb);
    });

    test("a token in an MCP connection's url does not reach the row", async () => {
      await clearAudit();
      const created = await createMcpConnection(
        ctx(),
        {
          name: `mu${uniq()}`,
          transport: "streamableHttp",
          url: "https://203.0.113.10/mcp/tok-399-mcp-path",
        },
        appDb,
      );
      const [row] = await rows("mcp_connection.create");
      expect((row?.after as { urlMasked: string } | undefined)?.urlMasked).toBe(
        "https://203.0.113.10/…",
      );
      expect(
        JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
      ).not.toContain("tok-399-mcp-path");
      await deleteMcpConnection(ctx(), BigInt(created.id), appDb);
    });

    test("an integration config value edited under an existing key still writes a row", async () => {
      const created = await createIntegrationInstance(
        ctx(),
        {
          catalogType: "ASAAS",
          name: `iv${uniq()}`,
          config: { pixKey: "first-399" },
        },
        appDb,
      );
      await clearAudit();
      // Only a VALUE moves under a key that stays, which is the ordinary shape of an integration
      // edit and the one a projection listing key names would have missed.
      await updateIntegrationInstance(
        ctx(),
        created.id,
        { config: { pixKey: "second-399" } },
        appDb,
      );
      const r = await rows("integration.update");
      expect(r.length).toBe(1);
      const before = r[0]?.before as { undisclosedChanged?: true } | undefined;
      const after = r[0]?.after as { undisclosedChanged?: true } | undefined;
      expect(before?.undisclosedChanged).toBe(true);
      expect(after?.undisclosedChanged).toBe(true);
      const text = JSON.stringify(r[0], (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      );
      expect(text).not.toContain("first-399");
      expect(text).not.toContain("second-399");
      await deleteIntegrationInstance(ctx(), created.id, appDb);
    });

    test("an experiment variant's prompt edited alone still writes a row", async () => {
      const e = await createExperiment({
        ctx: ctx(),
        name: `ep${uniq()}`,
        variants: [
          { key: "a", systemPrompt: "FIRST-399", weight: 1 },
          { key: "b", systemPrompt: "B", weight: 1 },
        ],
        base: appDb,
      });
      await clearAudit();
      // Same keys, same weights: only the prompt behind arm `a` moved.
      await updateExperiment({
        ctx: ctx(),
        id: e.id,
        variants: [
          { key: "a", systemPrompt: "SECOND-399", weight: 1 },
          { key: "b", systemPrompt: "B", weight: 1 },
        ],
        base: appDb,
      });
      const r = await rows("experiment.update");
      expect(r.length).toBe(1);
      const before = r[0]?.before as
        | { undisclosedChanged?: true; variants: unknown }
        | undefined;
      const after = r[0]?.after as
        | { undisclosedChanged?: true; variants: unknown }
        | undefined;
      expect(before?.variants).toEqual(after?.variants);
      expect(before?.undisclosedChanged).toBe(true);
      expect(after?.undisclosedChanged).toBe(true);
      const text = JSON.stringify(r[0], (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      );
      expect(text).not.toContain("FIRST-399");
      expect(text).not.toContain("SECOND-399");
      await deleteExperiment(ctx(), e.id, appDb);
    });

    // The four the battery caught after the first fix: a column the projection MENTIONS through a
    // transform that reports less than it holds. Each of these keeps the visible half identical, so
    // only the digest can say the change happened.

    test("a tool url template edited within the same origin still writes a row", async () => {
      const created = await createToolDefinition(
        ctx(),
        {
          name: `tp${uniq()}`,
          label: "l",
          urlTemplate: "https://203.0.113.10/first",
          allowedHosts: ["203.0.113.10"],
        },
        appDb,
      );
      await clearAudit();
      await updateToolDefinition(
        ctx(),
        BigInt(created.id),
        { urlTemplate: "https://203.0.113.10/second" },
        appDb,
      );
      const r = await rows("tool.update");
      expect(r.length).toBe(1);
      const before = r[0]?.before as
        | { urlMasked: string; undisclosedChanged?: true }
        | undefined;
      const after = r[0]?.after as
        | { urlMasked: string; undisclosedChanged?: true }
        | undefined;
      // The masked half cannot tell these apart, which is exactly why the digest is there.
      expect(before?.urlMasked).toBe(after?.urlMasked);
      expect(before?.undisclosedChanged).toBe(true);
      expect(after?.undisclosedChanged).toBe(true);
      await deleteToolDefinition(ctx(), BigInt(created.id), appDb);
    });

    test("an MCP url edited within the same origin still writes a row", async () => {
      const created = await createMcpConnection(
        ctx(),
        {
          name: `mp${uniq()}`,
          transport: "streamableHttp",
          url: "https://203.0.113.10/one",
        },
        appDb,
      );
      await clearAudit();
      await updateMcpConnection(
        ctx(),
        BigInt(created.id),
        { url: "https://203.0.113.10/two" },
        appDb,
      );
      const r = await rows("mcp_connection.update");
      expect(r.length).toBe(1);
      const before = r[0]?.before as
        | { urlMasked: string; undisclosedChanged?: true }
        | undefined;
      const after = r[0]?.after as
        | { urlMasked: string; undisclosedChanged?: true }
        | undefined;
      expect(before?.urlMasked).toBe(after?.urlMasked);
      expect(before?.undisclosedChanged).toBe(true);
      expect(after?.undisclosedChanged).toBe(true);
      await deleteMcpConnection(ctx(), BigInt(created.id), appDb);
    });

    test("a template field edited without changing its key or type still writes a row", async () => {
      const created = await createDocumentTemplate(
        ctx(),
        {
          name: `df${uniq()}`,
          blocks: [{ id: "t", type: "text", text: "x" }],
          fields: [{ name: "cliente", type: "text", label: "Cliente" }],
        },
        appDb,
      );
      const id = BigInt(created.id);
      await clearAudit();
      await updateDocumentTemplate(
        ctx(),
        id,
        {
          fields: [{ name: "cliente", type: "text", label: "Nome do cliente" }],
        },
        appDb,
      );
      const r = await rows("document_template.update");
      expect(r.length).toBe(1);
      const before = r[0]?.before as
        | { fields: unknown; undisclosedChanged?: true }
        | undefined;
      const after = r[0]?.after as
        | { fields: unknown; undisclosedChanged?: true }
        | undefined;
      // The visible half NAMES the field, which is what makes the comparison below mean anything:
      // read under the wrong key it would be `{name: null}` on both sides — equal for the wrong
      // reason — and a field added or retyped would move nothing here either.
      expect(after?.fields).toEqual([{ name: "cliente", type: "text" }]);
      // `{name, type}` is all the visible half carries, and neither moved.
      expect(before?.fields).toEqual(after?.fields);
      expect(before?.undisclosedChanged).toBe(true);
      expect(after?.undisclosedChanged).toBe(true);
      await deleteDocumentTemplate(ctx(), id, appDb);
    });

    test("a stdio command's arguments do not reach the row, only its launcher", async () => {
      // Planted with the SUPERUSER client: creating a stdio connection is gated on
      // `config.mcpStdioEnabled`, and what is under test is the PROJECTION of such a row rather than
      // the writer's gate. The row is what an operator with stdio enabled would have.
      const planted = await su?.mcpServerConnection.create({
        data: {
          tenantId,
          name: `ms${uniq()}`,
          transport: "stdio",
          command: "bunx some-server --api-key=sk-399-in-an-argument",
        },
        select: { id: true },
      });
      const id = planted?.id as bigint;
      await clearAudit();
      await deleteMcpConnection(ctx(), id, appDb);
      const [row] = await rows("mcp_connection.delete");
      expect(
        (row?.before as { commandLauncher: string } | undefined)
          ?.commandLauncher,
      ).toBe("bunx");
      // An argument is where a self-hosted server's key goes, and this row outlives the connection.
      expect(
        JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
      ).not.toContain("sk-399-in-an-argument");
    });

    // ── the fence: every mutable column is in one half or the other ──
    //
    // The five findings above were five instances of ONE mistake — a column that is in neither half —
    // and fixing them one by one would leave the sixth to be found by review again. So the coverage
    // is cobbled from the SOURCE of the invariant rather than from the projections: the columns come
    // out of `prisma/schema.prisma`, and a column added to any of these models later fails this test
    // until its author has decided which half it belongs in.
    //
    // Reading the schema is what makes it a fence rather than a restatement. Counting off the
    // projections would only ever agree with itself (the lesson #438 wrote down: count the DECLARATION
    // and not the projection of it).

    test("every mutable column of the five models is projected, compared, or exempt with a reason", async () => {
      const schema = await Bun.file("prisma/schema.prisma").text();
      const missing: string[] = [];
      for (const f of FENCED) {
        const cols = mutableColumns(schema, f.model);
        // A model whose columns cannot be read is a broken matcher, not a clean model.
        expect(cols.length).toBeGreaterThan(2);
        const src = await Bun.file(f.file).text();
        const covered = coveredColumns(src);
        for (const c of cols) {
          if (c in f.exempt || c in (f.whole ?? {}) || covered.has(c)) continue;
          missing.push(`${f.model}.${c}`);
        }
      }
      expect(missing).toEqual([]);
    });

    test("every undisclosed name is a column the service actually reads", async () => {
      const unread: string[] = [];
      for (const f of FENCED) {
        const src = await Bun.file(f.file).text();
        const selected = selectedColumns(src);
        // A select that cannot be read is a broken matcher, not a module with no columns.
        expect(selected.size).toBeGreaterThan(2);
        for (const n of undisclosedNames(src)) {
          if (!selected.has(n)) unread.push(`${f.model}.${n}`);
        }
      }
      expect(unread).toEqual([]);
    });

    test("the fence's two halves catch what they are for, over bodies the tree does not hold", () => {
      const schema = `
enum Mood {
  HAPPY
  SAD
}

model Widget {
  id        BigInt   @id
  tenantId  BigInt
  name      String
  secretBag Json
  count     Int      @default(0)
  mood      Mood     @default(HAPPY)
  owner     Tenant   @relation(fields: [tenantId], references: [id])
  parts     Part[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
`;
      // Relations and the four columns the row already holds in its own columns are not the
      // projection's business; every scalar and every enum is — and `Tenant`/`Part` are recognised
      // as relations WITHOUT either being declared in this fixture, which is what the allowlist
      // buys over asking whether a type is a model here.
      expect(mutableColumns(schema, "Widget")).toEqual([
        "count",
        "mood",
        "name",
        "secretBag",
      ]);
      // A model that is not there reads as no columns, which the test above turns into a failure
      // rather than a silent pass.
      expect(mutableColumns(schema, "Missing")).toEqual([]);

      const complete = `function auditProjection(r: Row) {
  return { name: r.name };
}
const UNDISCLOSED = ["secretBag", "count"] as const;`;
      const leaky = `function auditProjection(r: Row) {
  return { name: r.name };
}
const UNDISCLOSED = ["secretBag"] as const;`;
      expect(coveredColumns(complete)).toEqual(
        new Set(["name", "secretBag", "count"]),
      );
      // The shape review found: a column read nowhere in the projection, so it moves and the row does
      // not.
      expect(coveredColumns(leaky).has("count")).toBe(false);
      // A pair that only OPENS as a whole-value pair does not count: this is the shape review found
      // on `allowedHosts`, where `.map(hostForAudit)` reports a redacted list under the same key.
      expect(
        coveredColumns(`function auditProjection(r: Row) {
  return { name: r.name.map(redact) };
}
const UNDISCLOSED = [] as const;`).has("name"),
      ).toBe(false);
      // And the extraction stops at the function, so a mention further down the file does not vouch
      // for a projection that omits it.
      expect(
        coveredColumns(`${leaky}\nfunction other() { return r.count; }`).has(
          "count",
        ),
      ).toBe(false);
    });
  },
);

// The columns a projection answers for: every scalar the model declares, minus the four the audit
// row already holds in its own columns and minus every relation. Enums count as scalars — an
// inbound auth strategy is a policy an operator changes — so relations are told apart by being
// declared as `model` in the same schema.
export function mutableColumns(schema: string, model: string): string[] {
  // An ALLOWLIST of what counts, not a denylist of what does not. Told the other way round — "a
  // type that is a model in this schema is a relation" — the predicate quietly admits any type it
  // does not recognise, and a relation to a model declared elsewhere, or a type this file has not
  // heard of, becomes a column the fence then demands a projection for. Enums are on the list
  // because an inbound auth strategy IS a policy an operator changes.
  const SCALARS = new Set([
    "String",
    "Int",
    "BigInt",
    "Boolean",
    "DateTime",
    "Json",
    "Float",
    "Decimal",
    "Bytes",
  ]);
  const enums = new Set(
    [...schema.matchAll(/^enum\s+(\w+)/gm)].map((m) => m[1] as string),
  );
  const block = new RegExp(
    `^model\\s+${model}\\s*\\{([\\s\\S]*?)^\\}`,
    "m",
  ).exec(schema);
  if (!block?.[1]) return [];
  const skip = new Set(["id", "tenantId", "createdAt", "updatedAt"]);
  const out: string[] = [];
  for (const line of block[1].split("\n")) {
    const m = /^\s*(\w+)\s+(\w+)(\[\])?\??/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const [, name, type] = m;
    if (skip.has(name)) continue;
    if (!SCALARS.has(type) && !enums.has(type)) continue;
    out.push(name);
  }
  return out.sort();
}

// Which columns a change to would MOVE the projection, which is not the same as which ones it
// mentions.
//
// Mentioning is what the first version of this fence counted, and it passed with the defect
// restored: `urlMasked: redactEndpoint(r.urlTemplate)` mentions `urlTemplate` while reporting only
// its origin, so a template edited from `/a` to `/b` moves nothing and writes no row. Same for an
// MCP `url`, for a `command` shown as its launcher, and for `fields` shown as `{key, type}`. So a
// column counts in exactly two shapes:
//
// - named in the module's `UNDISCLOSED` list, which the update path compares whole; or
// - as a whole-value pair, `name: r.name`, where the projection carries it as it stands, and the
//   pair has to END there: `allowedHosts: r.allowedHosts.map(hostForAudit)` opens with the same
//   eleven characters and reports a redacted list, so a prefix match would vouch for exactly the
//   transform this fence exists to catch.
//
// A transformed projection is neither, and has to be listed as well to count. The one lossless
// transform in the tree is declared per family in `FENCED[].whole`, with its reason.
export function coveredColumns(source: string): Set<string> {
  const start = source.indexOf("function auditProjection(");
  if (start < 0) return new Set();
  // Bounded at the function, so a `r.column` anywhere else in the file cannot vouch for it.
  const next = source.indexOf("\nfunction ", start + 1);
  const body = source.slice(start, next < 0 ? undefined : next);
  const out = new Set<string>();
  // The undisclosed half is a DECLARATION rather than a call, so the fence reads the list itself.
  // It is matched over the whole file: the list sits beside the projection, not inside it.
  const listed = /const UNDISCLOSED = \[([\s\S]*?)\] as const;/.exec(source);
  for (const m of (listed?.[1] ?? "").matchAll(/"(\w+)"/g)) {
    out.add(m[1] as string);
  }
  for (const m of body.matchAll(/\b(\w+):\s*r\.\1\s*(?=[,\n}])/g)) {
    out.add(m[1] as string);
  }
  return out;
}

// The names in `UNDISCLOSED` are compared against the ROWS the service read, so a name that is not
// a key of those rows compares `undefined` to `undefined` on every save — always equal, forever
// silent, and the column it was meant to cover is uncovered while the fence above reads as
// satisfied. That is the same hole this whole PR exists to close, one level down, so the list is
// checked against the module's own `select` rather than trusted.
export function selectedColumns(source: string): Set<string> {
  const block = /^const [A-Z_]*SELECT[A-Z_]* = \{([\s\S]*?)^\} as const;/m.exec(
    source,
  );
  const out = new Set<string>();
  for (const m of (block?.[1] ?? "").matchAll(/^\s*(\w+):\s*true,/gm)) {
    out.add(m[1] as string);
  }
  return out;
}

export function undisclosedNames(source: string): string[] {
  const listed = /const UNDISCLOSED = \[([\s\S]*?)\] as const;/.exec(source);
  return [...(listed?.[1] ?? "").matchAll(/"(\w+)"/g)].map(
    (m) => m[1] as string,
  );
}

const FENCED: {
  model: string;
  file: string;
  exempt: Record<string, string>;
  // Carried in FULL by the projection, through a transform that loses nothing. Separate from
  // `exempt`, which is the opposite claim: a column deliberately in neither half.
  whole?: Record<string, string>;
}[] = [
  {
    model: "ToolDefinition",
    file: "src/modules/tool-definitions/service.ts",
    exempt: {},
  },
  {
    model: "McpServerConnection",
    file: "src/modules/mcp-connections/service.ts",
    exempt: {},
  },
  {
    model: "IntegrationInstance",
    file: "src/modules/integrations/service.ts",
    exempt: {
      routeToken:
        "the inbound credential itself: the route authenticates by nothing else, and the change that matters to it has an action of its own (integration.rotate_token)",
      routeTokenHash: "the verifier for that same credential",
    },
  },
  {
    model: "Experiment",
    file: "src/modules/experiments/service.ts",
    exempt: {},
    whole: {
      agentId:
        "projected whole, as a decimal string, because the audit columns are jsonb and JSON has no BigInt",
    },
  },
  {
    model: "DocumentTemplate",
    file: "src/modules/documents/templates.ts",
    exempt: {
      lastNumber:
        "the issuer's counter, advanced by issuing a document and not by editing the template",
    },
  },
];
