import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildHttpTool } from "@/graph/tools/http";
import type { TenantContext } from "@/lib/tenancy";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { toolCreate, toolUpdate } from "@/modules/mcp/write-agents";
import {
  createToolDefinition,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";

// Issue #150. A body authored as a plain JSON object was accepted by every write, stored, echoed
// back by the dry-run preview, and then discarded at invocation — `parseBody` recognizes three
// shapes and falls back to assembling the payload from the declared input fields for anything else.
// So the request went out looking plausible, missing whatever the operator had written, and the
// only symptom was the upstream API complaining about a field the operator could see in their own
// tool definition.
//
// The reporter read this as "nested placeholders are not substituted". They are not substituted,
// but neither are the top-level ones: the first test here shows the whole body being ignored.

const NESTED_BODY = {
  order_id: "{{order_id}}",
  contact: { email: "{{contact_email}}" },
};

const INPUT_SCHEMA = {
  order_id: { type: "integer", required: true },
  contact_email: { type: "string" },
};

describe("the body that motivated the refusal", () => {
  // NOTE: This is the measurement the issue's diagnosis got wrong, so it is pinned rather than described.
  test("a plain-object body is ignored entirely, not just at depth", async () => {
    let sent = "";
    const fetchImpl = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      sent = String(init?.body ?? "");
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const tool = buildHttpTool(
      {
        name: "lookup",
        method: "POST",
        urlTemplate: "https://example.com/lookup",
        allowedHosts: ["example.com"],
        headers: {},
        // NOTE: A field the body never mentions, which is what makes this conclusive: if the body were
        // a template with a substitution gap, this key could not appear at all.
        inputSchema: { unrelated_field: { type: "string" } },
        body: NESTED_BODY,
      } as never,
      { fetchImpl, allowHttp: true, resolveCredential: async () => null },
    );
    await tool.invoke({ unrelated_field: "xyz" });

    expect(JSON.parse(sent)).toEqual({ unrelated_field: "xyz" });
  });
});

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

let tenantId = 0n;
const tenants: bigint[] = [];

function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function principal(): VerifiedToken {
  return {
    userId: 1n,
    tenantId,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  };
}

function toolInput(name: string, body?: unknown) {
  return {
    name,
    label: name,
    method: "POST" as const,
    urlTemplate: "https://example.com/lookup",
    allowedHosts: ["example.com"],
    inputSchema: INPUT_SCHEMA,
    ...(body !== undefined ? { body } : {}),
  };
}

afterAll(async () => {
  if (dbUp) {
    for (const id of tenants) {
      await suDb.$executeRaw`DELETE FROM tool_definitions WHERE tenant_id = ${id}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${id}`;
    }
  }
  await su?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!dbUp)(
  "an unsupported body is refused where it is authored",
  () => {
    test("setup", async () => {
      const t = await suDb.tenant.create({
        data: { name: "body-shape", slug: `body-shape-${process.pid}` },
      });
      tenantId = t.id;
      tenants.push(t.id);
      expect(tenantId).toBeGreaterThan(0n);
    });

    // NOTE: REST and the console both land here.
    test("createToolDefinition refuses it, and says what to write instead", async () => {
      const err = await createToolDefinition(
        ctx(),
        toolInput("plain_body", NESTED_BODY) as never,
        appDb,
      ).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).not.toBeNull();
      expect(String(err?.message)).toContain('{"mode":"raw"');

      const row = await suDb.toolDefinition.findFirst({
        where: { tenantId, name: "plain_body" },
      });
      expect(row).toBeNull();
    });

    test("the three supported shapes still pass", async () => {
      for (const [i, body] of [
        { mode: "kv", rows: [{ key: "order_id", value: "{{order_id}}" }] },
        { mode: "raw", raw: '{"contact":{"email":"{{contact_email}}"}}' },
        {},
      ].entries()) {
        const created = await createToolDefinition(
          ctx(),
          toolInput(`ok_body_${i}`, body) as never,
          appDb,
        );
        expect(created.name).toBe(`ok_body_${i}`);
      }
    });

    // NOTE: A limit added over data that already exists refuses only what the write itself changes: a row
    // stored before this existed must stay editable, or the operator cannot fix it from the console.
    test("a patch that does not touch the body is not refused for a stored one", async () => {
      const created = await createToolDefinition(
        ctx(),
        toolInput("legacy_body") as never,
        appDb,
      );
      // NOTE: Straight to the DB, the way a row written before the check would look.
      await suDb.$executeRaw`
      UPDATE tool_definitions SET body = ${JSON.stringify(NESTED_BODY)}::jsonb
      WHERE id = ${BigInt(created.id)}`;

      const patched = await updateToolDefinition(
        ctx(),
        BigInt(created.id),
        { label: "renamed" },
        appDb,
      );
      expect(patched.label).toBe("renamed");

      // NOTE: But writing that same shape back IS refused, since that write is the one being judged.
      const err = await updateToolDefinition(
        ctx(),
        BigInt(created.id),
        { body: NESTED_BODY } as never,
        appDb,
      ).then(
        () => null,
        (e: Error) => e,
      );
      expect(err).not.toBeNull();
    });

    // NOTE: The dry run is where the issue says the author should have found out, and it never called the
    // service — it previewed the input back and applied nothing, so a refusal in the service alone
    // would still let `dry_run: true` echo the broken shape with no warning.
    test("MCP tool_create refuses in the dry-run preview, not only on apply", async () => {
      const dry = await toolCreate(
        principal(),
        {
          name: "mcp_plain_body",
          url_template: "https://example.com/lookup",
          allowed_hosts: ["example.com"],
          input_schema: INPUT_SCHEMA,
          body: NESTED_BODY,
        } as never,
        { base: appDb },
      );
      expect(dry.ok).toBe(false);
      if (!dry.ok) expect(dry.error).toContain('"mode":"raw"');
    });

    test("MCP tool_update refuses it in the dry-run preview too", async () => {
      const created = await createToolDefinition(
        ctx(),
        toolInput("mcp_patch_body") as never,
        appDb,
      );
      const dry = await toolUpdate(
        principal(),
        { tool_id: String(created.id), body: NESTED_BODY } as never,
        { base: appDb },
      );
      expect(dry.ok).toBe(false);
      if (!dry.ok) expect(dry.error).toContain('"mode":"raw"');
    });
  },
);
