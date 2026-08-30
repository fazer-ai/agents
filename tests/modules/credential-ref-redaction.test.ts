import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import {
  createIntegrationInstance,
  listIntegrationInstances,
  updateIntegrationInstance,
} from "@/modules/integrations/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  integrationList,
  mcpConnectionList,
  toolList,
} from "@/modules/mcp/read";
import { mcpConnectionUpdate } from "@/modules/mcp/write-agents";
import {
  createMcpConnection,
  listMcpConnections,
  updateMcpConnection,
} from "@/modules/mcp-connections/service";
import {
  createToolDefinition,
  getToolDefinition,
  listToolDefinitions,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";
import { codeOnly } from "@/tests/utils/source-text";
import { outboundUrl } from "../utils/outbound";

// FOUR REF COLUMNS STILL HAND A READER WHAT THE COLUMN HOLDS (issue #438).
//
// `requireVaultRef` reached every writer of every ref column in ONE commit, `dc6c467a` (#126,
// 2026-08-18). Before it the field was `z.string().min(1).max(128)` and the value was stored
// verbatim, so a row can hold text that names no vault entry — most plausibly a secret VALUE, from
// an API caller who read the field name as "the secret" rather than "a reference to one". Both
// modules predate the guard by more than two months.
//
// The write was made by whoever held the credential. The READ is not: these DTOs go out over REST
// and over `mcp:read`, a principal scope deliberately narrower than the console's TENANT_ADMIN, and
// the MCP tool descriptions promise "No secrets". For a pre-#126 row that promise rests on nobody
// having typed one into the field.
//
// The tests plant such a value with the SUPERUSER client, because the service refuses to write one —
// which is the point: the rows this is about were written before the service could refuse.

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
let secretId = 0n;

const ctx = (): TenantContext => ({
  tenantId,
  userId: 9438n,
  role: "TENANT_ADMIN",
});

// The value a pre-#126 caller could have put in the column. It is not a ref, so no resolver ever
// matched it and the credential never worked — it just sits there, reachable by every reader.
const PLANTED = "sk-live-438-not-a-reference";

describe.skipIf(!dbUp)(
  "a stored ref reaches a reader only when it names an entry",
  () => {
    const plant = (table: string, column: string, id: bigint, value: string) =>
      (su as PrismaClient).$executeRawUnsafe(
        `UPDATE ${table} SET ${column} = '${value}' WHERE id = ${id}`,
      );

    beforeAll(async () => {
      if (!su) return;
      const t = await su.tenant.create({
        data: { name: "CRR", slug: `crr-${process.pid}` },
      });
      tenantId = t.id;
      const sec = await su.vaultEntry.create({
        data: {
          tenantId,
          name: "crr-key",
          kind: "generic",
          secret: encryptJson("the-secret-value"),
        },
        select: { id: true },
      });
      secretId = sec.id;
    });

    afterAll(async () => {
      if (su && tenantId) {
        for (const table of [
          "audit_logs",
          "tool_definitions",
          "mcp_server_connections",
          "integration_instances",
          "vault_entries",
        ]) {
          await su.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          );
        }
        await su.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
      await app?.$disconnect();
      await su?.$disconnect();
    });

    // ── HTTP tool definitions ──

    describe("ToolDefinition.credentialRef", () => {
      const create = (name: string) =>
        createToolDefinition(
          ctx(),
          {
            name,
            label: name,
            urlTemplate: outboundUrl("/tool"),
            allowedHosts: ["203.0.113.10"],
            credentialRef: `vault:${secretId}`,
          },
          appDb,
        );

      test("a ref that names an entry is returned, canonically", async () => {
        await create("td-ok");
        const row = (await listToolDefinitions(ctx(), appDb)).find(
          (t) => t.name === "td-ok",
        );
        expect(row?.credentialRef).toBe(`vault:${secretId}`);
      });

      test("a value that names nothing never leaves the service", async () => {
        const made = await create("td-planted");
        await plant(
          "tool_definitions",
          "credential_ref",
          BigInt(made.id),
          PLANTED,
        );

        const listed = (await listToolDefinitions(ctx(), appDb)).find(
          (t) => t.name === "td-planted",
        );
        expect(JSON.stringify(listed).includes(PLANTED)).toBe(false);
        expect(listed?.credentialRef).toBe(null);

        const one = await getToolDefinition(ctx(), BigInt(made.id), appDb);
        expect(JSON.stringify(one).includes(PLANTED)).toBe(false);
      });

      // WHAT NULL MEANS, and the four MCP descriptions say the same sentence. The guard proves the
      // value IS a reference, deliberately not that it resolves (#437), so a ref whose entry was
      // deleted still comes back: the operator sees a credential that is set and broken instead of a
      // field that reads empty. Pinned because the first spelling of those descriptions said "names
      // no entry", which is a different and false claim.
      test("a ref whose entry is gone is still a ref, and is still shown", async () => {
        const made = await create("td-dangling");
        await plant(
          "tool_definitions",
          "credential_ref",
          BigInt(made.id),
          "vault:999999999",
        );
        const row = (await listToolDefinitions(ctx(), appDb)).find(
          (t) => t.name === "td-dangling",
        );
        expect(row?.credentialRef).toBe("vault:999999999");
      });

      test("a lenient spelling is answered with the canonical one", async () => {
        const made = await create("td-lenient");
        await plant(
          "tool_definitions",
          "credential_ref",
          BigInt(made.id),
          `vault:000${secretId}`,
        );
        const row = (await listToolDefinitions(ctx(), appDb)).find(
          (t) => t.name === "td-lenient",
        );
        expect(row?.credentialRef).toBe(`vault:${secretId}`);
      });
    });

    // ── outbound MCP server connections ──

    describe("McpServerConnection.credentialRef", () => {
      const create = (name: string) =>
        createMcpConnection(
          ctx(),
          {
            name,
            transport: "streamableHttp",
            url: outboundUrl("/mcp"),
            credentialRef: `vault:${secretId}`,
          },
          appDb,
        );

      test("a value that names nothing never leaves the service", async () => {
        const made = await create("mcp-planted");
        await plant(
          "mcp_server_connections",
          "credential_ref",
          BigInt(made.id),
          PLANTED,
        );
        const listed = (await listMcpConnections(ctx(), appDb)).find(
          (c) => c.name === "mcp-planted",
        );
        expect(JSON.stringify(listed).includes(PLANTED)).toBe(false);
        expect(listed?.credentialRef).toBe(null);
      });

      test("a ref that names an entry survives", async () => {
        const made = await create("mcp-ok");
        const listed = (await listMcpConnections(ctx(), appDb)).find(
          (c) => c.name === "mcp-ok",
        );
        expect(listed?.credentialRef).toBe(`vault:${secretId}`);
        expect(String(made.credentialRef)).toBe(`vault:${secretId}`);
      });
    });

    // ── integration instances: TWO ref columns, and the issue counted one ──

    describe("IntegrationInstance credentialRef and inboundSecretRef", () => {
      test("neither column hands out a value that names nothing", async () => {
        const made = await createIntegrationInstance(
          ctx(),
          {
            catalogType: "ASAAS",
            name: "int-planted",
            credentialRef: `vault:${secretId}`,
            inboundAuthStrategy: "HMAC_SHA256",
            inboundSecretRef: `vault:${secretId}`,
          },
          appDb,
        );
        await plant(
          "integration_instances",
          "credential_ref",
          BigInt(made.id),
          PLANTED,
        );
        await plant(
          "integration_instances",
          "inbound_secret_ref",
          BigInt(made.id),
          `${PLANTED}-inbound`,
        );

        const listed = (await listIntegrationInstances(ctx(), appDb)).find(
          (i) => i.name === "int-planted",
        );
        const text = JSON.stringify(listed);
        expect(text.includes(PLANTED)).toBe(false);
        expect(listed?.credentialRef).toBe(null);
        expect(listed?.inboundSecretRef).toBe(null);
      });
    });

    // ── the surface the issue names: `mcp:read`, narrower than the console's TENANT_ADMIN ──
    //
    // Driven through the MCP reads rather than trusting that they pass the DTO along, because that
    // is the property under test: these four hand back the SERVICE dto, and their descriptions used
    // to promise a vault entry NAME, which was true of the settings reads and of nothing here.

    test("no mcp:read tool hands a planted value to its client", async () => {
      const principal: VerifiedToken = {
        userId: 9438n,
        tenantId,
        role: "TENANT_ADMIN",
        scopes: ["mcp:read"],
        clientId: "c",
        jti: "j",
      };
      const td = await createToolDefinition(
        ctx(),
        {
          name: "td-mcp",
          label: "td-mcp",
          urlTemplate: outboundUrl("/tool"),
          allowedHosts: ["203.0.113.10"],
          credentialRef: `vault:${secretId}`,
        },
        appDb,
      );
      const mc = await createMcpConnection(
        ctx(),
        {
          name: "mcp-mcp",
          transport: "streamableHttp",
          url: outboundUrl("/mcp"),
          credentialRef: `vault:${secretId}`,
        },
        appDb,
      );
      const ii = await createIntegrationInstance(
        ctx(),
        {
          catalogType: "ASAAS",
          name: "int-mcp",
          credentialRef: `vault:${secretId}`,
          inboundAuthStrategy: "HMAC_SHA256",
          inboundSecretRef: `vault:${secretId}`,
        },
        appDb,
      );
      for (const [table, column, id] of [
        ["tool_definitions", "credential_ref", td.id],
        ["mcp_server_connections", "credential_ref", mc.id],
        ["integration_instances", "credential_ref", ii.id],
        ["integration_instances", "inbound_secret_ref", ii.id],
      ] as const) {
        await plant(table, column, BigInt(id), PLANTED);
      }

      const answers = await Promise.all([
        ["td-mcp", await toolList(principal, { base: appDb })],
        ["mcp-mcp", await mcpConnectionList(principal, { base: appDb })],
        ["int-mcp", await integrationList(principal, { base: appDb })],
      ] as const);
      for (const [name, a] of answers) {
        const text = JSON.stringify(a);
        expect(text.includes(PLANTED)).toBe(false);
        // The row IS in the answer, which is what separates redaction from a read that failed —
        // three refusals carry no planted value either, and would pass the line above.
        expect(text.includes(name)).toBe(true);
      }
    });

    // ── the AUDIT row, which is where a leak would have been permanent ──
    //
    // `mcpConnectionUpdate` projects its before/after out of the DTO, so the column reached
    // `recordMcpAudit` and an append-only row. An MCP caller clearing an opaque ref therefore wrote
    // whatever the column held — plausibly a secret — into storage nothing deletes.
    //
    // What is LEFT is a diff that under-reports: the before is now null and the caller sends null, so
    // the change reads as none while the column does get cleared. That is the residue of removing the
    // leak, and it under-reports the removal of a value that resolved nowhere. A presence signal on
    // the DTO would close it, and that is a different mechanism from this one.

    test("clearing an opaque ref over MCP leaves no trace of what it held", async () => {
      const principal: VerifiedToken = {
        userId: 9438n,
        tenantId,
        role: "TENANT_ADMIN",
        scopes: ["mcp:read", "mcp:write"],
        clientId: "c",
        jti: "j",
      };
      const made = await createMcpConnection(
        ctx(),
        {
          name: "mcp-audit",
          transport: "streamableHttp",
          url: outboundUrl("/mcp"),
          credentialRef: `vault:${secretId}`,
        },
        appDb,
      );
      await plant(
        "mcp_server_connections",
        "credential_ref",
        BigInt(made.id),
        PLANTED,
      );

      const res = await mcpConnectionUpdate(
        principal,
        {
          connection_id: made.id,
          credential_ref: null,
          dry_run: false,
        },
        { base: appDb },
      );
      expect(res.ok).toBe(true);

      const rows = await (su as PrismaClient).$queryRawUnsafe<
        { payload: string }[]
      >(
        `SELECT row_to_json(a)::text AS payload FROM audit_logs a WHERE tenant_id = ${tenantId} AND action = 'mcp_connection.update'`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.payload.includes(PLANTED)).toBe(false);

      const stored = await (
        su as PrismaClient
      ).mcpServerConnection.findUniqueOrThrow({
        where: { id: BigInt(made.id) },
        select: { credentialRef: true },
      });
      expect(stored.credentialRef).toBe(null);
    });

    // ── what the echo-back does, which is the question the redaction OPENS ──
    //
    // All three consoles prefill their picker from the DTO and send the field on every save, so a read
    // that starts returning null turns the next unrelated save into a clear. That is #435's shape, and
    // the reason it does NOT need #435's fix here is a property of what gets redacted: `readableVaultRef`
    // hides a value only when it is not a well-formed ref at all, and such a value resolved to nothing
    // in every resolver, so the credential never worked. Clearing it loses no behaviour, and it takes a
    // probable secret VALUE out of a column that should never have held one.
    //
    // That argument is only worth having if the OTHER two cases survive the same trip. Measured here
    // rather than reasoned about, because "the form is safe" is exactly the claim a checklist swallows.

    describe("the whole-body save a console performs", () => {
      test("a resolvable ref survives being read and echoed back", async () => {
        const made = await createToolDefinition(
          ctx(),
          {
            name: "td-echo",
            label: "td-echo",
            urlTemplate: outboundUrl("/tool"),
            allowedHosts: ["203.0.113.10"],
            credentialRef: `vault:${secretId}`,
          },
          appDb,
        );
        const listed = (await listToolDefinitions(ctx(), appDb)).find(
          (t) => t.name === "td-echo",
        );
        const saved = await updateToolDefinition(
          ctx(),
          BigInt(made.id),
          { label: "renamed", credentialRef: listed?.credentialRef ?? null },
          appDb,
        );
        expect(saved.credentialRef).toBe(`vault:${secretId}`);
      });

      test("a lenient spelling comes back canonical and is stored that way", async () => {
        const made = await createMcpConnection(
          ctx(),
          {
            name: "mcp-echo",
            transport: "streamableHttp",
            url: outboundUrl("/mcp"),
            credentialRef: `vault:${secretId}`,
          },
          appDb,
        );
        await (su as PrismaClient).$executeRawUnsafe(
          `UPDATE mcp_server_connections SET credential_ref = 'vault: 000${secretId}' WHERE id = ${made.id}`,
        );
        const listed = (await listMcpConnections(ctx(), appDb)).find(
          (c) => c.name === "mcp-echo",
        );
        expect(listed?.credentialRef).toBe(`vault:${secretId}`);

        const saved = await updateMcpConnection(
          ctx(),
          BigInt(made.id),
          { name: "mcp-echo-2", credentialRef: listed?.credentialRef ?? null },
          appDb,
        );
        expect(saved.credentialRef).toBe(`vault:${secretId}`);
        const stored = await (
          su as PrismaClient
        ).mcpServerConnection.findUniqueOrThrow({
          where: { id: BigInt(made.id) },
          select: { credentialRef: true },
        });
        // The column too, not just the answer: the lenient spelling is what `requireVaultRef` refuses on
        // the way in, so a read that echoed it verbatim would hand back an unsavable form.
        expect(stored.credentialRef).toBe(`vault:${secretId}`);
      });

      test("and a value that names nothing is cleared rather than preserved", async () => {
        const made = await createIntegrationInstance(
          ctx(),
          {
            catalogType: "ASAAS",
            name: "int-echo",
            credentialRef: `vault:${secretId}`,
          },
          appDb,
        );
        await (su as PrismaClient).$executeRawUnsafe(
          `UPDATE integration_instances SET credential_ref = '${PLANTED}' WHERE id = ${made.id}`,
        );
        const listed = (await listIntegrationInstances(ctx(), appDb)).find(
          (i) => i.name === "int-echo",
        );
        await updateIntegrationInstance(
          ctx(),
          BigInt(made.id),
          { name: "int-echo-2", credentialRef: listed?.credentialRef ?? null },
          appDb,
        );
        const stored = await (
          su as PrismaClient
        ).integrationInstance.findUniqueOrThrow({
          where: { id: BigInt(made.id) },
          select: { credentialRef: true },
        });
        expect(stored.credentialRef).toBe(null);
      });
    });
  },
);

// ── the family, counted from the schema rather than from a checklist ──
//
// A checklist is satisfied halfway with nothing red. This reads the ref columns out of the Prisma
// schema and requires each one's projection to pass through the same guard, so a SEVENTH column
// added later arrives here as a failure rather than as an omission nobody sees.

const REF_COLUMN = /(\w*(?:credentialRef|[sS]ecretRef))\s+String\?/g;

export function refColumnsInSchema(schema: string): string[] {
  const out: string[] = [];
  let model = "";
  for (const line of schema.split("\n")) {
    const m = line.match(/^model\s+(\w+)/);
    if (m?.[1]) model = m[1];
    for (const c of line.matchAll(REF_COLUMN)) out.push(`${model}.${c[1]}`);
  }
  return out.sort();
}

export function guardedProjections(files: { rel: string; source: string }[]) {
  return files
    .filter(({ source }) => codeOnly(source).includes("readableVaultRef("))
    .map((f) => f.rel)
    .sort();
}

// The two decisions above, over inputs they are HANDED — because a sweep run only against a clean
// tree reports nothing either way, and a mutation to it survives with the suite green. These are the
// cases the tree does not contain, and the ones the sweep exists to catch.
describe("the sweep's decisions, over what it is given", () => {
  test("a comment that NAMES the guard does not count as calling it", () => {
    const source = `
      // Every ref here goes through readableVaultRef( before it is handed out.
      function toDto(r: Row) {
        return { credentialRef: r.credentialRef };
      }`;
    expect(guardedProjections([{ rel: "a.ts", source }])).toEqual([]);
  });

  test("and a call does count", () => {
    const source = `function toDto(r: Row) {
      return { credentialRef: readableVaultRef(r.credentialRef) };
    }`;
    expect(guardedProjections([{ rel: "a.ts", source }])).toEqual(["a.ts"]);
  });

  test("the schema reader finds both spellings, and only on a ref column", () => {
    const schema = `
model Thing {
  id            BigInt   @id
  name          String?  @map("name")
  credentialRef String?  @map("credential_ref")
  someSecretRef String?  @map("some_secret_ref")
  secretRef     String?  @map("secret_ref")
  note          String?
}`;
    expect(refColumnsInSchema(schema)).toEqual([
      "Thing.credentialRef",
      "Thing.secretRef",
      "Thing.someSecretRef",
    ]);
  });

  test("a column on a later model is named by THAT model", () => {
    const schema = `
model A {
  secretRef String?
}

model B {
  credentialRef String?
}`;
    expect(refColumnsInSchema(schema)).toEqual([
      "A.secretRef",
      "B.credentialRef",
    ]);
  });
});

describe("every ref column in the schema is projected through one guard", () => {
  test("the schema still holds the six this issue is about", async () => {
    const schema = await Bun.file("prisma/schema.prisma").text();
    expect(refColumnsInSchema(schema)).toEqual([
      "AlertChannel.secretRef",
      "IntegrationInstance.credentialRef",
      "IntegrationInstance.inboundSecretRef",
      "McpServerConnection.credentialRef",
      "ToolDefinition.credentialRef",
      "WebhookSubscription.secretRef",
    ]);
  });

  test("and every service that owns one redacts it", async () => {
    const owners = [
      "src/modules/flowlog/channels.ts",
      "src/modules/integrations/service.ts",
      "src/modules/mcp-connections/service.ts",
      "src/modules/tool-definitions/service.ts",
      "src/modules/webhooks/outbound/subscriptions.ts",
    ];
    const files = await Promise.all(
      owners.map(async (rel) => ({ rel, source: await Bun.file(rel).text() })),
    );
    expect(guardedProjections(files)).toEqual(owners);
  });
});
