import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { AppError } from "@/lib/errors";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { buildMcpServer } from "@/modules/mcp/server";
import * as writeRoot from "@/modules/mcp/write";
import * as writeAgents from "@/modules/mcp/write-agents";
import * as writeChannels from "@/modules/mcp/write-channels";
import * as writeConversations from "@/modules/mcp/write-conversations";
import * as writeDocuments from "@/modules/mcp/write-documents";
import * as writeFleet from "@/modules/mcp/write-fleet";
import * as writeKnowledge from "@/modules/mcp/write-knowledge";
import * as writeSettings from "@/modules/mcp/write-settings";
import * as writeWebhooks from "@/modules/mcp/write-webhooks";
import { seedChatwootInstance, withRunNamespace } from "../../utils/chatwoot";

// A write tool with `dry_run` answers its preview WITHOUT touching the core, and that shortcut is
// what makes the preview cheap. It is also what makes every rule the core learns start out
// unmirrored: the preview keeps answering `ok`, nobody notices, and the operator (or the model
// driving MCP) reads a confident description of a write that cannot happen. Issue #490.
//
// Two things this harness learned the hard way, both worth keeping written down. It does NOT drive
// the tools through the MCP client, tempting as that is: the server's handlers use `basePrisma`,
// built at import time off `DATABASE_URL`, which `tests/setup.ts` deliberately points at a dead
// database — so every apply "refused" with `Database 'test' does not exist` and eleven tools looked
// broken that were not. And a refusal is not any failure: a thrown Prisma error is a CRASH, and
// counting it as a refusal is what made that contamination invisible. `verdict` below separates the
// three outcomes and the rows fail loudly on the third.
//
// The fence has two halves and needs both. The TABLE below gives every dry-run tool one input the
// APPLY refuses; the first test derives the tool list from the live registry and fails when a tool
// has no row, so a tool added later cannot join silently. The second drives both halves of each row
// and requires them to agree — and requires the apply to have actually refused, because a row whose
// apply succeeds proves nothing and would quietly become decoration.

const NOPE = "999999999";

// `skip` states, in writing, why a tool has no refusable input reachable from its arguments alone.
// It is not an escape hatch for a row that is merely awkward: the reason has to be a property of the
// tool, and the fence prints it.
type Case = { args: Record<string, unknown>; why: string };
// `also` carries the inputs a one-row-per-tool table cannot: a tool agrees on the row's input and
// still diverges on another, and each of these was a real second divergence found after the row for
// that tool was already green.
type Row = (Case & { also?: Case[] }) | { skip: string };

const TABLE: Record<string, Row> = {
  agent_clone: {
    args: { agent_id: NOPE, name: "x" },
    why: "agent does not exist",
  },
  agent_create: {
    args: { name: "" },
    why: "empty name",
    also: [
      {
        args: { name: "a", business_hours_id: "not-an-id" },
        why: "business_hours_id is not a db id",
      },
    ],
  },
  agent_delete: { args: { agent_id: NOPE }, why: "agent does not exist" },
  agent_import: { args: { export: {} }, why: "export bundle has no agent" },
  agent_settings_set: {
    args: { agent_id: NOPE, debounce: {} },
    why: "agent does not exist",
  },
  agent_tools_set: {
    args: { agent_id: NOPE, grants: [] },
    why: "agent does not exist",
  },
  agent_update: {
    args: { agent_id: NOPE, name: "x" },
    why: "agent does not exist",
  },
  alert_channel_create: {
    args: { name: "n", type: "webhook", url_ref: `vault:${NOPE}` },
    why: "url_ref names no credential",
  },
  alert_channel_delete: {
    args: { channel_id: NOPE },
    why: "channel does not exist",
  },
  alert_channel_update: {
    args: { channel_id: NOPE, name: "x" },
    why: "channel does not exist",
  },
  api_key_revoke: { args: { api_key_id: NOPE }, why: "key does not exist" },
  branding_asset_set: {
    args: {
      kind: "logo",
      variant: "light",
      content_base64: "!!not base64!!",
      mime: "image/png",
    },
    why: "content is not base64",
  },
  branding_set: {
    args: { brand_color: "not-a-hex" },
    why: "brand_color is not #rrggbb",
  },
  business_hours_create: { args: { name: "" }, why: "empty name" },
  business_hours_delete: {
    args: { business_hours_id: NOPE },
    why: "schedule does not exist",
  },
  business_hours_update: {
    args: { business_hours_id: NOPE, name: "x" },
    why: "schedule does not exist",
  },
  conversation_handoff: {
    args: { conversation_id: NOPE },
    why: "conversation does not exist",
  },
  conversation_reengage: {
    args: { conversation_id: NOPE },
    why: "conversation does not exist",
  },
  conversation_reply: {
    args: { conversation_id: NOPE, content: "x" },
    why: "conversation does not exist",
  },
  conversation_return: {
    args: { conversation_id: NOPE },
    why: "conversation does not exist",
  },
  conversation_status: {
    args: { conversation_id: NOPE, status: "open" },
    why: "conversation does not exist",
  },
  credential_create: {
    args: { name: "c", kind: "not_a_kind" },
    why: "kind is not in the catalog",
  },
  deployment_connect: {
    args: { base_url: "not-a-url", admin_token: "t" },
    why: "base_url is not a URL",
  },
  deployment_list_accounts: {
    skip: "takes no arguments: every refusal it has is a property of the deployment, not of an input",
  },
  deployment_rotate_token: { args: { admin_token: "" }, why: "empty token" },
  deployment_set_accounts: {
    args: { account_ids: [999999999] },
    why: "no Chatwoot deployment is connected",
  },
  document_template_create: { args: { name: "" }, why: "empty name" },
  document_template_delete: {
    args: { document_template_id: NOPE },
    why: "template does not exist",
  },
  document_template_update: {
    args: { document_template_id: NOPE, name: "x" },
    why: "template does not exist",
  },
  experiment_create: {
    args: { name: "e", agent_id: "abc", variants: [] },
    why: "agent_id is not a number",
  },
  experiment_delete: {
    args: { experiment_id: NOPE },
    why: "experiment does not exist",
  },
  experiment_update: {
    args: { experiment_id: NOPE, name: "x" },
    why: "experiment does not exist",
  },
  inbox_bind: { args: { inbox_id: NOPE }, why: "inbox does not exist" },
  inbox_reconcile: {
    skip: "takes no arguments: every refusal it has is a property of the deployment, not of an input",
  },
  inbox_reconnect: { args: { inbox_id: NOPE }, why: "inbox does not exist" },
  inbox_remove: { args: { inbox_id: NOPE }, why: "inbox does not exist" },
  instance_disconnect: {
    args: { instance_id: NOPE },
    why: "instance does not exist",
  },
  instance_sync_inboxes: {
    args: { instance_id: NOPE },
    why: "instance does not exist",
  },
  integration_create: {
    args: { catalog_type: "not_a_provider", name: "n" },
    why: "provider is not in the catalog",
  },
  integration_delete: {
    args: { integration_id: NOPE },
    why: "instance does not exist",
  },
  integration_update: {
    args: { integration_id: NOPE, name: "x" },
    why: "instance does not exist",
  },
  knowledge_approve: {
    args: { approval_id: "abc" },
    why: "approval_id is not a number",
  },
  knowledge_create: {
    // NOTE: a NUL, because this core refuses almost nothing else about a create — an empty name, a
    // 5000-character name and a chunk_size of 99999999 all APPLY. That leniency is its own issue.
    args: { name: "a\u0000b" },
    why: "the column cannot store a NUL",
  },
  knowledge_delete: {
    args: { knowledge_base_id: NOPE },
    why: "base does not exist",
  },
  knowledge_document_create: {
    args: { knowledge_base_id: NOPE, title: "t", text: "x" },
    why: "base does not exist",
  },
  knowledge_document_delete: {
    args: { document_id: NOPE },
    why: "document does not exist",
  },
  knowledge_document_retry: {
    args: { document_id: NOPE },
    why: "document does not exist",
  },
  knowledge_edit: {
    args: { approval_id: "abc", title: "t" },
    why: "approval_id is not a number",
  },
  knowledge_reindex: {
    args: { knowledge_base_id: NOPE },
    why: "base does not exist",
  },
  knowledge_reject: {
    args: { approval_id: "abc" },
    why: "approval_id is not a number",
  },
  knowledge_update: {
    args: { knowledge_base_id: NOPE, name: "x" },
    why: "base does not exist",
  },
  langfuse_connect: {
    args: { public_key: "pk", secret_key: "sk", base_url: "not-a-url" },
    why: "base_url is not a URL",
    also: [
      {
        // NOTE: whitespace normalizes to the empty string WITHOUT raising, and `langfuse` is a kind
        // that requires a base URL — so the verdict is the validator's return, not its throwing.
        args: { public_key: "pk", secret_key: "sk", base_url: "   " },
        why: "base_url normalizes to empty, and langfuse requires one",
      },
    ],
  },
  mcp_connection_create: {
    args: { name: "n", transport: "streamableHttp" },
    why: "a network transport with no url",
  },
  mcp_connection_delete: {
    args: { connection_id: NOPE },
    why: "connection does not exist",
  },
  mcp_connection_update: {
    args: { connection_id: NOPE, name: "x" },
    why: "connection does not exist",
  },
  prompt_set: {
    args: { agent_id: NOPE, system_prompt: "x" },
    why: "agent does not exist",
  },
  tenant_create: { args: { name: "n", slug: "" }, why: "empty slug" },
  tenant_settings_update: {
    args: { embedding: { credential_ref: `vault:${NOPE}` } },
    why: "credential_ref names no credential",
  },
  tenant_update: { args: { name: "" }, why: "empty name" },
  tool_create: {
    // NOTE: the NAME, not the URL and not the method. `createToolDefinition` never validates
    // `url_template`, so "not-a-url" is stored and both halves say ok; and the method IS an enum on
    // the published schema, so "PURGE" is a row the transport could never deliver. Measured.
    args: {
      name: "not a valid name!",
      url_template: "https://example.com/x",
      allowed_hosts: ["example.com"],
    },
    why: "name is not [A-Za-z0-9_-]{1,64}",
  },
  tool_delete: { args: { tool_id: NOPE }, why: "tool does not exist" },
  tool_update: {
    args: { tool_id: NOPE, name: "x" },
    why: "tool does not exist",
  },
  webhook_create: {
    args: { url: "not-a-url", events: ["message.created"] },
    why: "url is not a URL",
  },
  webhook_delete: {
    args: { webhook_id: NOPE },
    why: "subscription does not exist",
  },
  webhook_delivery_requeue: {
    args: { delivery_id: NOPE },
    why: "delivery does not exist",
  },
  webhook_update: {
    // NOTE: a literal IP, not a hostname. The preview now vets this URL the way the write does, and
    // for a hostname that means a DNS lookup — which would make this row measure the resolver.
    args: { webhook_id: NOPE, url: "https://93.184.216.34/hook" },
    why: "subscription does not exist",
  },
};

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

const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

// The dispatch, DERIVED rather than authored: every tool name is its function name in snake case,
// with no exceptions across all 66 — so the lookup is the mapping, and a tool whose function this
// cannot resolve fails the coverage test below instead of silently going unexercised.
type WriteFn = (
  principal: VerifiedToken,
  args: Record<string, unknown>,
  deps: { base: PrismaClient },
) => Promise<{ ok: boolean }>;

const FNS = {
  ...writeAgents,
  ...writeChannels,
  ...writeConversations,
  ...writeDocuments,
  ...writeFleet,
  ...writeKnowledge,
  ...writeSettings,
  ...writeWebhooks,
  ...writeRoot,
} as unknown as Record<string, WriteFn | undefined>;

const camel = (snake: string): string =>
  snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const fnFor = (tool: string): WriteFn | undefined => {
  const f = FNS[camel(tool)];
  return typeof f === "function" ? f : undefined;
};

// The three outcomes, kept apart. `refused` is the tool saying no on purpose — a falsy `ok` on the
// WriteResult, or a 4xx `AppError`. Anything else thrown is a CRASH: the tool did not answer, and a
// row that reads a crash as a refusal measures the harness instead of the tool.
type Verdict = "ok" | "refused" | "crash";

async function verdict(run: () => Promise<{ ok: boolean }>): Promise<Verdict> {
  try {
    return (await run()).ok ? "ok" : "refused";
  } catch (e) {
    if (e instanceof AppError && e.statusCode >= 400 && e.statusCode < 500) {
      return "refused";
    }
    return "crash";
  }
}

// The registry is the source: a tool that publishes `dry_run` is a tool this fence covers, whether
// or not anyone remembered to add a row. Read under BOTH principals, because the fleet tier
// (`mcp:admin`) registers eight the tenant tier never sees.
const TENANT_SCOPES = ["mcp:read", "mcp:write"];
const FLEET_SCOPES = ["mcp:read", "mcp:write", "mcp:admin"];

// The published schema of one tool, as much of JSON Schema as the registry actually emits.
interface JsonSchema {
  type?: string;
  enum?: unknown[];
  anyOf?: JsonSchema[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

async function publishedDryRunTools(): Promise<{
  all: string[];
  fleetOnly: Set<string>;
  schemas: Map<string, JsonSchema>;
}> {
  const seen = new Map<string, Set<string>>();
  // Tenant tier first, then fleet, and the FIRST wins: a tenant-scoped tool published to both tiers
  // is exercised by the fence under the tenant principal, and only that tier's schema describes the
  // arguments it will get (the fleet one carries the wrapper's extra `tenant`).
  const schemas = new Map<string, JsonSchema>();
  for (const [tier, over] of [
    ["tenant", { role: "TENANT_ADMIN", scopes: TENANT_SCOPES }],
    ["fleet", { role: "SUPER_ADMIN", scopes: FLEET_SCOPES }],
  ] as const) {
    const server = buildMcpServer({
      userId: 1n,
      tenantId: 1n,
      clientId: "c",
      jti: "j",
      ...over,
    } as VerifiedToken);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "fence", version: "0" });
    await client.connect(ct);
    const published = (await client.listTools()).tools.filter((t) => {
      const props = (t.inputSchema as JsonSchema).properties;
      return !!props && "dry_run" in props;
    });
    for (const t of published) {
      if (!schemas.has(t.name))
        schemas.set(t.name, t.inputSchema as JsonSchema);
    }
    seen.set(tier, new Set(published.map((t) => t.name)));
    await client.close();
  }
  const tenant = seen.get("tenant") ?? new Set<string>();
  const fleet = seen.get("fleet") ?? new Set<string>();
  const all = [...new Set([...tenant, ...fleet])].sort();
  return {
    all,
    fleetOnly: new Set(all.filter((t) => !tenant.has(t))),
    schemas,
  };
}

// Does this value fit what the registry says the argument is? Enough of JSON Schema to judge the
// shapes the registry emits (type, enum, anyOf, array items), and no more.
function fits(value: unknown, schema: JsonSchema): boolean {
  if (schema.anyOf) return schema.anyOf.some((s) => fits(value, s));
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case undefined:
      return true;
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "array":
      return (
        Array.isArray(value) &&
        (!schema.items ||
          value.every((v) => fits(v, schema.items as JsonSchema)))
      );
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
      }
      // A nested block with DECLARED properties is judged like the top level: an undeclared key
      // there is the same artifact, one level down, and that is exactly where the first one hid
      // (`embedding: { credentialRef }` against a block publishing `credential_ref`). A block with
      // no `properties` is free-form by design (tool headers, a body) and passes.
      const nested = schema.properties;
      if (!nested) return true;
      return Object.entries(value as Record<string, unknown>).every(
        ([k, v]) => !!nested[k] && fits(v, nested[k] as JsonSchema),
      );
    }
    default:
      return true;
  }
}

// Why a row's arguments could never reach the tool it claims to measure. The fence dispatches
// DIRECTLY, past the registry's own input schema, which buys it a live database and costs it this:
// an argument the schema would have rejected exercises a path the transport has no way to produce,
// and the row reads as a divergence that no client can hit. Three of the first thirteen failures
// were exactly that — `account_ids: ["not-a-number"]` against `z.array(z.number().int())`, a
// `method` outside its enum, and `credentialRef` where the tool publishes `credential_ref`.
function schemaComplaints(
  args: Record<string, unknown>,
  schema: JsonSchema,
): string[] {
  const props = schema.properties ?? {};
  const out: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const prop = props[key];
    if (!prop) {
      out.push(`${key}: not a published argument`);
      continue;
    }
    if (!fits(value, prop)) {
      out.push(`${key}: ${JSON.stringify(value)} does not fit the schema`);
    }
  }
  for (const key of schema.required ?? []) {
    // `tenant` is the wrapper's, resolved into the principal before the handler runs, so a direct
    // dispatch supplies it by choosing the principal rather than by naming it.
    if (key === "tenant" || key in args) continue;
    out.push(`${key}: required and missing`);
  }
  return out;
}

describe.skipIf(!dbUp)(
  "every dry-run tool previews what it would apply",
  () => {
    let tenantId = 0n;
    let fleetOnly = new Set<string>();

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "DryRunFence", slug: `dryfence-${process.pid}` },
      });
      tenantId = t.id;
      fleetOnly = (await publishedDryRunTools()).fleetOnly;
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

    const principalFor = (tool: string): VerifiedToken =>
      ({
        userId: 1n,
        tenantId,
        clientId: "c",
        jti: "j",
        ...(fleetOnly.has(tool)
          ? { role: "SUPER_ADMIN", scopes: FLEET_SCOPES }
          : { role: "TENANT_ADMIN", scopes: TENANT_SCOPES }),
      }) as VerifiedToken;

    test("the table and the dispatch cover exactly what the registry publishes", async () => {
      const { all } = await publishedDryRunTools();
      expect(all.filter((t) => !TABLE[t])).toEqual([]);
      expect(Object.keys(TABLE).filter((t) => !all.includes(t))).toEqual([]);
      expect(all.filter((t) => !fnFor(t))).toEqual([]);
    });

    test("every row's arguments are ones the registry would actually deliver", async () => {
      const { schemas } = await publishedDryRunTools();
      const bad: Record<string, string[]> = {};
      for (const [name, row] of Object.entries(TABLE)) {
        if ("skip" in row) continue;
        const schema = schemas.get(name);
        if (!schema) continue;
        const complaints = [row, ...(row.also ?? [])].flatMap((c) =>
          schemaComplaints(c.args, schema),
        );
        if (complaints.length > 0) bad[name] = complaints;
      }
      expect(bad).toEqual({});
    });

    for (const [name, row] of Object.entries(TABLE)) {
      if ("skip" in row) {
        test.skip(`${name} — ${row.skip}`, () => {});
        continue;
      }
      test(`${name}: preview and apply agree (${row.why})`, async () => {
        const fn = fnFor(name) as WriteFn;
        const p = principalFor(name);
        for (const extra of row.also ?? []) {
          const label = `${name} (${extra.why})`;
          expect({
            row: label,
            applied: await verdict(() =>
              fn(p, { ...extra.args, dry_run: false }, { base: appDb }),
            ),
          }).toEqual({ row: label, applied: "refused" });
          expect({
            row: label,
            previewed: await verdict(() =>
              fn(p, { ...extra.args }, { base: appDb }),
            ),
          }).toEqual({ row: label, previewed: "refused" });
        }
        // NOTE: the control, and it runs first on purpose. A row whose apply SUCCEEDS has nothing to
        // disagree about — the comparison below would pass forever measuring nothing, and the row
        // would have created a real record getting there. A row that CRASHES is worse: it is the
        // harness failing, dressed as the tool refusing.
        const applied = await verdict(() =>
          fn(p, { ...row.args, dry_run: false }, { base: appDb }),
        );
        expect({ row: name, applied }).toEqual({
          row: name,
          applied: "refused",
        });
        const previewed = await verdict(() =>
          fn(p, { ...row.args }, { base: appDb }),
        );
        expect({ row: name, previewed }).toEqual({
          row: name,
          previewed: "refused",
        });
      });
    }
  },
);

// ── The same rule, asked of one input the row-per-tool table above cannot reach ──────────────────
//
// The fence gives every tool ONE refusable input, which is a floor and not a proof: a tool can agree
// on that input and still diverge on another. This is the second one worth naming, because it is a
// CLASS rather than a tool — a caller-supplied outbound URL, vetted by the core through
// `assertSafeOutboundUrl` after the preview has already approved it.
//
// It was found by measuring a sentence in the PR body that had no number behind it ("the SSRF check
// stays on the apply — it is a call, not a judgement about the arguments"). It is both: with the
// guard armed, `http://127.0.0.1:9/` is refused on the PROTOCOL, before any lookup, and the preview
// was approving exactly that. Four tools reach the check; `mcp_connection_create` was the only one
// already covered, by the assert extracted for its own row.
// Two of them, and the pair is the point. The first fails on the PROTOCOL, with no lookup involved;
// the second fails on where the NAME points, which no amount of reading the string can tell you.
// Skipping the resolution — which is what an earlier round of this PR did, to avoid a doubled lookup
// on the apply — closes the first gap and leaves the second wide open, and `https://localhost` is a
// URL an operator types by accident constantly. The doubled lookup was the wrong thing to fix: the
// preflight lives inside the preview branch, so an apply never reaches it at all.
const BLOCKED_URLS = {
  protocol: "http://127.0.0.1:9/hook",
  resolution: "https://localhost/hook",
} as const;

describe.skipIf(!dbUp)("a preview vets the outbound URL its apply vets", () => {
  let tenantId = 0n;
  let webhookId = "";
  let connectionId = "";

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SsrfFence", slug: `ssrffence-${process.pid}` },
    });
    tenantId = t.id;
    // Seeded through Prisma rather than through the create tools: the row only has to EXIST, and
    // going through the tools would make this fence depend on their apply paths working.
    const hook = await suDb.webhookSubscription.create({
      data: {
        tenantId,
        url: "https://example.com/hook",
        events: ["heartbeat"],
      },
    });
    webhookId = String(hook.id);
    const conn = await suDb.mcpServerConnection.create({
      data: {
        tenantId,
        name: "ssrf-fence",
        transport: "streamableHttp",
        url: "https://example.com/mcp",
      },
    });
    connectionId = String(conn.id);
  });

  afterAll(async () => {
    if (su && tenantId) {
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
  });

  const principal = (admin: boolean): VerifiedToken =>
    ({
      userId: 1n,
      tenantId,
      clientId: "c",
      jti: "j",
      ...(admin
        ? { role: "SUPER_ADMIN", scopes: FLEET_SCOPES }
        : { role: "TENANT_ADMIN", scopes: TENANT_SCOPES }),
    }) as VerifiedToken;

  const ROWS: {
    tool: string;
    admin: boolean;
    args: (url: string) => Record<string, unknown>;
  }[] = [
    {
      tool: "deployment_connect",
      admin: true,
      args: (url) => ({ base_url: url, admin_token: "t" }),
    },
    {
      tool: "webhook_create",
      admin: false,
      args: (url) => ({ url, events: ["heartbeat"] }),
    },
    {
      tool: "webhook_update",
      admin: false,
      args: (url) => ({ webhook_id: webhookId, url }),
    },
    {
      tool: "mcp_connection_create",
      admin: false,
      args: (url) => ({ name: "x", transport: "streamableHttp", url }),
    },
    {
      tool: "mcp_connection_update",
      admin: false,
      args: (url) => ({ connection_id: connectionId, url }),
    },
  ];

  for (const row of ROWS) {
    for (const [why, url] of Object.entries(BLOCKED_URLS)) {
      test(`${row.tool}: a URL blocked by ${why} is refused by both halves`, async () => {
        const fn = fnFor(row.tool) as WriteFn;
        const p = principal(row.admin);
        const label = `${row.tool}/${why}`;
        const applied = await verdict(() =>
          fn(p, { ...row.args(url), dry_run: false }, { base: appDb }),
        );
        expect({ row: label, applied }).toEqual({
          row: label,
          applied: "refused",
        });
        const previewed = await verdict(() =>
          fn(p, { ...row.args(url) }, { base: appDb }),
        );
        expect({ row: label, previewed }).toEqual({
          row: label,
          previewed: "refused",
        });
      });
    }
  }
});

// ── The other way a row can be green while the tool diverges ─────────────────────────────────────
//
// A row gives its tool ONE refusable input, so it certifies the preflight exists — not that the
// preflight covers everything its core decides. `deployment_set_accounts` is the measured case: its
// row passes no deployment at all, and stayed green while a preview handed an account ANOTHER tenant
// owns answered "will connect" and the apply answered "already connected to another tenant". The
// preflight had half of `setConnectedAccounts`'s judgement, and half reads exactly like all of it.
describe.skipIf(!dbUp)("a preflight covers its core's whole judgement", () => {
  let mine = 0n;
  let theirs = 0n;
  const TAKEN_ACCOUNT = 4242;
  const SERVER = "https://cw.claimfence.local";

  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "ClaimA", slug: `claim-a-${process.pid}` },
    });
    mine = a.id;
    const b = await suDb.tenant.create({
      data: { name: "ClaimB", slug: `claim-b-${process.pid}` },
    });
    theirs = b.id;
    // The other tenant already owns the account, on the same Chatwoot server.
    await seedChatwootInstance(suDb, {
      tenantId: theirs,
      baseUrl: SERVER,
      accountId: TAKEN_ACCOUNT,
      adminToken: encryptJson("tok"),
    });
    await suDb.chatwootDeployment.create({
      data: {
        tenantId: mine,
        baseUrl: withRunNamespace(SERVER),
        adminToken: encryptJson("tok"),
      },
    });
  });

  afterAll(async () => {
    for (const id of [mine, theirs]) {
      if (!su || !id) continue;
      await su.$executeRawUnsafe(
        `DELETE FROM chatwoot_instances WHERE tenant_id = ${id}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM chatwoot_deployments WHERE tenant_id = ${id}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
    }
  });

  test("deployment_set_accounts: an account another tenant owns", async () => {
    const p = {
      userId: 1n,
      tenantId: mine,
      clientId: "c",
      jti: "j",
      role: "SUPER_ADMIN",
      scopes: FLEET_SCOPES,
    } as VerifiedToken;
    // The taken account is NOT first. A batched claim check that only ever looks at the head of the
    // array answers "will connect" here, and the one-query rewrite is exactly the kind of change
    // that can introduce that without any single-account test noticing.
    const args = { account_ids: [9001, TAKEN_ACCOUNT] };
    const applied = await verdict(() =>
      writeChannels.deploymentSetAccounts(
        p,
        { ...args, dry_run: false },
        { base: appDb },
      ),
    );
    expect(applied).toBe("refused");
    const previewed = await verdict(() =>
      writeChannels.deploymentSetAccounts(p, { ...args }, { base: appDb }),
    );
    expect(previewed).toBe("refused");
  });

  // The cost of the answer, not just the answer. `account_ids` is an uncapped array on the
  // published schema, so a claim check that asks per account opens one privileged transaction per
  // element — and the PREVIEW pays it, before the apply pays it again. The assertion is a shape,
  // not a magic number: whatever the preview spends on one account, it spends on twenty-five.
  test("deployment_set_accounts: the claim check does not scale with the array", async () => {
    const p = {
      userId: 1n,
      tenantId: mine,
      clientId: "c",
      jti: "j",
      role: "SUPER_ADMIN",
      scopes: FLEET_SCOPES,
    } as VerifiedToken;

    let transactions = 0;
    let claimQueries = 0;
    // `$extends` too: `runScopedOn` calls it and issues everything on the client that comes back,
    // so a proxy that only wraps `$transaction` counts the outer call and none of the queries.
    const wrap = (c: object): object =>
      new Proxy(c, {
        get(t, prop, recv) {
          const inner = Reflect.get(t, prop, recv);
          if (prop === "$extends") {
            return (...a: unknown[]) =>
              wrap((inner as (...x: unknown[]) => object).apply(t, a));
          }
          if (prop === "$transaction") {
            return (fn: (tx: unknown) => unknown, ...rest: unknown[]) => {
              transactions += 1;
              return (inner as (...a: unknown[]) => unknown).call(
                t,
                (tx: unknown) => fn(wrap(tx as object)),
                ...rest,
              );
            };
          }
          if (prop !== "chatwootInstance") return inner;
          return new Proxy(inner as object, {
            get(d, k, r) {
              const fn = Reflect.get(d, k, r);
              if (k !== "findFirst") return fn;
              return (...a: unknown[]) => {
                claimQueries += 1;
                return (fn as (...x: unknown[]) => unknown).apply(d, a);
              };
            },
          });
        },
      });
    const counting = wrap(appDb as object) as typeof appDb;

    // Both axes come back, because they fail differently and one hides the other: a query too WIDE
    // does not spend an extra transaction, it raises — and a count-only assertion reads that as
    // success.
    const spend = async (accountIds: number[]) => {
      transactions = 0;
      claimQueries = 0;
      const outcome = await verdict(() =>
        writeChannels.deploymentSetAccounts(
          p,
          { account_ids: accountIds },
          { base: counting },
        ),
      );
      return { transactions, claimQueries, outcome };
    };

    // Free account ids, so neither run is short-circuited by the cross-tenant refusal above.
    const one = await spend([9001]);
    const many = await spend(Array.from({ length: 25 }, (_, i) => 9100 + i));
    expect(one.transactions).toBeGreaterThan(0);
    expect(many.transactions).toBe(one.transactions);

    // And the other axis, which the assertion above cannot see: each id is a BIND PARAMETER, and
    // Postgres takes at most 32767. Measured before the chunking, 32760 ids answered in 56ms and
    // 32770 raised "The query parameter limit supported by your database is exceeded" — a CRASH,
    // not a refusal, on input the published schema accepts, and on the preview as much as on the
    // apply. Still one privileged transaction: the chunks share it.
    const huge = await spend(
      Array.from({ length: 40_000 }, (_, i) => 20_000 + i),
    );
    expect(huge.outcome).not.toBe("crash");
    expect(huge.transactions).toBe(one.transactions);
    // And the chunk cannot be shrunk to dodge the ceiling one id at a time: that is the per-element
    // query this function was written to remove, divided by nothing. 40k ids at 1000 per chunk is
    // 40 queries; the bound is generous so it pins the SHAPE, not the constant.
    expect(huge.claimQueries).toBeLessThan(100);
  });
});

// The class the TABLE structurally cannot reach: a divergence that depends on what is ALREADY IN
// THE DATABASE. Every row above passes an input bad on its face, so it needs no fixture; a name
// already taken is bad only relative to a row that exists, and the row has to be created first.
// Measured before it was fixed: all four previewed `ok` while their applies refused.
//
// These four preflights are ADVISORY and the distinction is the point. The rest of this fence
// covers questions whose answer cannot change between preview and apply, so a preview that agrees
// agrees forever. Uniqueness is not one of those: someone can take the name in the gap, and then
// the preview was right when it spoke and wrong when the apply ran. That residue is deliberate and
// is not what these tests pin — they pin the case that actually happens, an operator reusing a name
// they already used, which before this went out as "will create".
describe.skipIf(!dbUp)("a preview asks the questions that need a row", () => {
  let tenantId = 0n;
  const TAKEN = `dupfence-${process.pid}`;

  const principal = () =>
    ({
      userId: 1n,
      tenantId,
      clientId: "c",
      jti: "j",
      role: "SUPER_ADMIN",
      scopes: FLEET_SCOPES,
    }) as VerifiedToken;

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DupFence", slug: TAKEN },
    });
    tenantId = t.id;
    await suDb.toolDefinition.create({
      data: {
        tenantId,
        name: TAKEN,
        label: "taken",
        urlTemplate: "https://example.com/x",
        allowedHosts: ["example.com"],
      },
    });
    await suDb.mcpServerConnection.create({
      data: {
        tenantId,
        name: TAKEN,
        transport: "streamableHttp",
        url: "https://example.com/mcp",
      },
    });
    await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: TAKEN,
        kind: "generic",
        secret: encryptJson("s"),
      },
    });
  });

  afterAll(async () => {
    if (!su || !tenantId) return;
    for (const table of [
      "tool_definitions",
      "mcp_server_connections",
      "vault_entries",
    ]) {
      await su.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
      );
    }
    await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
  });

  const both = async (
    run: (args: Record<string, unknown>) => Promise<{ ok: boolean }>,
    args: Record<string, unknown>,
  ) => ({
    applied: await verdict(() => run({ ...args, dry_run: false })),
    previewed: await verdict(() => run({ ...args })),
  });

  test("tenant_create: a slug another tenant already has", async () => {
    const r = await both(
      (a) => writeFleet.tenantCreate(principal(), a as never, { base: appDb }),
      { name: "dup", slug: TAKEN },
    );
    expect(r.applied).toBe("refused");
    expect(r.previewed).toBe("refused");
  });

  test("tool_create: a name this tenant already used", async () => {
    const r = await both(
      (a) => writeAgents.toolCreate(principal(), a as never, { base: appDb }),
      {
        name: TAKEN,
        label: "dup",
        url_template: "https://example.com/x",
        allowed_hosts: ["example.com"],
      },
    );
    expect(r.applied).toBe("refused");
    expect(r.previewed).toBe("refused");
  });

  test("mcp_connection_create: a name this tenant already used", async () => {
    const r = await both(
      (a) =>
        writeAgents.mcpConnectionCreate(principal(), a as never, {
          base: appDb,
        }),
      {
        name: TAKEN,
        transport: "streamableHttp",
        url: "https://example.com/mcp",
      },
    );
    expect(r.applied).toBe("refused");
    expect(r.previewed).toBe("refused");
  });

  test("credential_create: a (name, kind) pair this tenant already used", async () => {
    const r = await both(
      (a) =>
        writeRoot.credentialCreate(principal(), a as never, { base: appDb }),
      { name: TAKEN },
    );
    expect(r.applied).toBe("refused");
    expect(r.previewed).toBe("refused");
  });

  // The normalization the advisory check depends on, and the reason it takes the NORMALIZED pair.
  // `kind` defaults to "generic" on the way in, and the uniqueness is on what gets STORED — so a
  // preview that looked the pair up with the raw `kind: null` would find nothing and answer "will
  // create" for the exact name it just refused above.
  test("credential_create: the default kind is the one the lookup uses", async () => {
    const r = await both(
      (a) =>
        writeRoot.credentialCreate(principal(), a as never, { base: appDb }),
      { name: TAKEN, kind: "generic" },
    );
    expect(r.applied).toBe("refused");
    expect(r.previewed).toBe("refused");
  });
});

// Round 6 of review, four findings, all four measured and all four real — and all four the SAME
// shape as `deployment_set_accounts` above: a preflight that answered part of what its core decides.
// The class is worth a block of its own because it does not announce itself: a tool with a
// preflight looks covered, and the fence's row for it stays green as long as the row happens to
// trip the part that IS covered.
describe.skipIf(!dbUp)(
  "a preflight answers all of its core, not the easy half",
  () => {
    let tenantId = 0n;
    let otherConnId = 0n;
    const TAKEN = `r6-${process.pid}`;

    const principal = () =>
      ({
        userId: 1n,
        tenantId,
        clientId: "c",
        jti: "j",
        role: "SUPER_ADMIN",
        scopes: FLEET_SCOPES,
      }) as VerifiedToken;

    const both = async (
      run: (args: Record<string, unknown>) => Promise<{ ok: boolean }>,
      args: Record<string, unknown>,
    ) => ({
      applied: await verdict(() => run({ ...args, dry_run: false })),
      previewed: await verdict(() => run({ ...args })),
    });

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "R6", slug: `r6-fence-${process.pid}` },
      });
      tenantId = t.id;
      await suDb.mcpServerConnection.create({
        data: {
          tenantId,
          name: TAKEN,
          transport: "streamableHttp",
          url: "https://example.com/a",
        },
      });
      const other = await suDb.mcpServerConnection.create({
        data: {
          tenantId,
          name: `${TAKEN}-other`,
          transport: "streamableHttp",
          url: "https://example.com/b",
        },
      });
      otherConnId = other.id;
      await suDb.chatwootDeployment.create({
        data: {
          tenantId,
          baseUrl: withRunNamespace("https://cw-one.example.com"),
          adminToken: encryptJson("tok"),
        },
      });
    });

    afterAll(async () => {
      if (!su || !tenantId) return;
      for (const table of [
        "mcp_server_connections",
        "chatwoot_deployments",
        "agents",
        "webhook_subscriptions",
      ]) {
        await su.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    });

    // ADVISORY. `assertAgentCreatable` already PARSES both schedule ids and hands them back; what it
    // cannot say is whether the row exists, which is a read.
    test("agent_create: a well-formed business_hours_id naming no row", async () => {
      const r = await both(
        (a) =>
          writeAgents.agentCreate(principal(), a as never, { base: appDb }),
        { name: "a", business_hours_id: NOPE },
      );
      expect(r.applied).toBe("refused");
      expect(r.previewed).toBe("refused");
    });

    test("agent_create: the same hole on follow_up_hours_id", async () => {
      const r = await both(
        (a) =>
          writeAgents.agentCreate(principal(), a as never, { base: appDb }),
        { name: "a", follow_up_hours_id: NOPE },
      );
      expect(r.applied).toBe("refused");
      expect(r.previewed).toBe("refused");
    });

    // The UPDATE side of the uniqueness class. It needs `exceptId`, and the test below it is what
    // keeps that from being answered by refusing every rename.
    test("mcp_connection_update: renaming onto a name already used", async () => {
      const r = await both(
        (a) =>
          writeAgents.mcpConnectionUpdate(principal(), a as never, {
            base: appDb,
          }),
        { connection_id: String(otherConnId), name: TAKEN },
      );
      expect(r.applied).toBe("refused");
      expect(r.previewed).toBe("refused");
    });

    // The inverse divergence, which is just as wrong and is what `exceptId` exists for: a connection
    // keeping its own name is not a collision. Without this, "refuse every rename" passes the test
    // above and breaks every real rename.
    test("mcp_connection_update: a connection keeping its own name is not a collision", async () => {
      const previewed = await verdict(() =>
        writeAgents.mcpConnectionUpdate(
          principal(),
          {
            connection_id: String(otherConnId),
            name: `${TAKEN}-other`,
            url: "https://example.com/b2",
          } as never,
          { base: appDb },
        ),
      );
      expect(previewed).toBe("ok");
    });

    // The preflight here asked only whether the URL was safe, and the schema asks two more things.
    test("webhook_create: an empty events array with a safe url", async () => {
      const r = await both(
        (a) =>
          writeWebhooks.webhookCreate(principal(), a as never, { base: appDb }),
        { url: "https://example.com/hook", events: [] },
      );
      expect(r.applied).toBe("refused");
      expect(r.previewed).toBe("refused");
    });

    test("webhook_update: the same hole on the patch", async () => {
      const hook = await suDb.webhookSubscription.create({
        data: {
          tenantId,
          url: "https://example.com/hook",
          events: ["conversation.created"],
        },
      });
      const r = await both(
        (a) =>
          writeWebhooks.webhookUpdate(principal(), a as never, { base: appDb }),
        { webhook_id: String(hook.id), events: [] },
      );
      expect(r.applied).toBe("refused");
      expect(r.previewed).toBe("refused");
    });

    // Round 7, same class again — and the reason this block keeps growing is that "the tool has a
    // preflight" is not the property that matters. `agent_create` had TWO by this point and still
    // approved a credential the apply refuses.
    test("agent_create: a credentialRef whose KIND cannot serve the field", async () => {
      const oauth = await suDb.vaultEntry.create({
        data: {
          tenantId,
          name: `oauth-${process.pid}`,
          kind: "google_oauth",
          secret: encryptJson({ clientId: "a", clientSecret: "b" }),
        },
      });
      // NOTE: a COMPLETE model config. The first cut passed `{ credentialRef }` alone, which the
      // schema refuses on its own shape — so both halves said no and the row measured nothing, the
      // same artifact the schema-conformance guard catches for table rows.
      const r = await both(
        (a) =>
          writeAgents.agentCreate(principal(), a as never, { base: appDb }),
        {
          name: "a",
          model_config: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${oauth.id}`,
          },
        },
      );
      expect(r.applied).toBe("refused");
      expect(r.previewed).toBe("refused");
    });

    // NOT from a review round: found by asking what `agent_update`'s row actually proves. It passes an
    // agent id that does not exist, so it proved the not-found path and stopped there — while the
    // tool's preview had no preflight at all and `updateAgent` applies half a dozen rules after the
    // ownership check. Thirty-three of the fifty-five rows in the table above are shaped like that;
    // the class is filed as its own issue, and this is the one that was measured.
    test("agent_update: three rules the row's not-found could never reach", async () => {
      const ag = await suDb.agent.create({
        data: {
          tenantId,
          name: "A",
          systemPrompt: "p",
          modelConfig: {},
          settings: {},
        },
      });
      const oauth = await suDb.vaultEntry.create({
        data: {
          tenantId,
          name: `oauth-upd-${process.pid}`,
          kind: "google_oauth",
          secret: encryptJson({ clientId: "a", clientSecret: "b" }),
        },
      });
      const cases: Record<string, unknown>[] = [
        { name: "" },
        { business_hours_id: NOPE },
        {
          model_config: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${oauth.id}`,
          },
        },
      ];
      for (const c of cases) {
        const r = await both(
          (a) =>
            writeAgents.agentUpdate(principal(), a as never, { base: appDb }),
          { agent_id: String(ag.id), ...c },
        );
        expect([JSON.stringify(c), r.applied]).toEqual([
          JSON.stringify(c),
          "refused",
        ]);
        expect([JSON.stringify(c), r.previewed]).toEqual([
          JSON.stringify(c),
          "refused",
        ]);
      }
    });

    test("langfuse_connect: a key with surrounding whitespace", async () => {
      const r = await both(
        (a) =>
          writeSettings.langfuseConnect(principal(), a as never, {
            base: appDb,
          }),
        {
          public_key: "  pk  ",
          secret_key: "sk",
          base_url: "https://cloud.langfuse.com",
        },
      );
      expect(r.applied).toBe("refused");
      expect(r.previewed).toBe("refused");
    });

    // The INVERSE divergence, and the only one in this PR. Everywhere else the preview approved a
    // write the apply refuses; here the preview refused and the apply SUCCEEDED — storing
    // `baseUrl: null` on a kind whose own create path rejects exactly that. `updateVaultEntry` asked
    // "does this kind require a base URL" only on the null/empty branch, while the other branch
    // normalized "   " to empty without raising and stored the null it had just refused.
    //
    // It needs the entry to ALREADY EXIST, because that is the branch `langfuse_connect` takes then
    // — which is why the create-side case above stayed green while this was broken.
    test("langfuse_connect: a whitespace base_url on an entry that already exists", async () => {
      await suDb.vaultEntry.create({
        data: {
          tenantId,
          name: "langfuse",
          kind: "langfuse",
          secret: encryptJson({ publicKey: "pk", secretKey: "sk" }),
          baseUrl: "https://cloud.langfuse.com",
        },
      });
      const args = { public_key: "pk2", secret_key: "sk2", base_url: "   " };
      const r = await both(
        (a) =>
          writeSettings.langfuseConnect(principal(), a as never, {
            base: appDb,
          }),
        args,
      );
      expect(r.applied).toBe("refused");
      expect(r.previewed).toBe("refused");
      // And the row is intact. A refusal that still cleared the column would satisfy the two lines
      // above and leave the configuration this test exists to protect.
      const after = await suDb.vaultEntry.findFirst({
        where: { tenantId, kind: "langfuse" },
        select: { baseUrl: true },
      });
      expect(after?.baseUrl).toBe("https://cloud.langfuse.com");
    });

    test("langfuse_connect: a key that is only whitespace", async () => {
      const r = await both(
        (a) =>
          writeSettings.langfuseConnect(principal(), a as never, {
            base: appDb,
          }),
        {
          public_key: "pk",
          secret_key: "   ",
          base_url: "https://cloud.langfuse.com",
        },
      );
      expect(r.applied).toBe("refused");
      expect(r.previewed).toBe("refused");
    });

    // ADVISORY, and the only one of the four whose apply spends a NETWORK round trip before it
    // refuses — which is why the preview answering it matters beyond coherence. Only the preview is
    // driven: the apply's refusal is reached after `listChatwootAccounts` calls a server that is not
    // there, so exercising it would measure a timeout. The core's own refusal is proven by the
    // mutation that deletes it, not by a row here.
    test("deployment_connect: a second, different Chatwoot server", async () => {
      const previewed = await verdict(() =>
        writeChannels.deploymentConnect(
          principal(),
          {
            base_url: "https://93.184.216.34",
            admin_token: "tok",
          } as never,
          { base: appDb },
        ),
      );
      expect(previewed).toBe("refused");
    });
  },
);
