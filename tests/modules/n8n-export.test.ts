import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  assertNoSecrets,
  buildToolWorkflow,
  SecretLeakError,
} from "@/modules/n8n-export/n8n";
import { exportToolWorkflow } from "@/modules/n8n-export/service";
import { dbProbeFailed } from "@/tests/db-gate";

// Built at run time so the repo holds no literal that reads as a credential.
const FAKE_TOKEN = ["abcd", "EFGH", "1234", "5678"].join("");

describe("assertNoSecrets (value scan)", () => {
  test("passes clean content", () => {
    expect(() =>
      assertNoSecrets({
        name: "Create charge",
        url: "https://api.x.com/v1/pay",
      }),
    ).not.toThrow();
    // The same object with one token in it is refused, so the pass above is the scan's answer.
    expect(() =>
      assertNoSecrets({
        name: "Create charge",
        url: `https://api.x.com/v1/pay?access_token=${FAKE_TOKEN}`,
      }),
    ).toThrow(SecretLeakError);
  });

  test("allows our {{secret}} vault placeholder (a reference, not a secret)", () => {
    expect(() =>
      assertNoSecrets({ headers: { Authorization: "{{secret}}" } }),
    ).not.toThrow();
    expect(() =>
      assertNoSecrets({
        headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
      }),
    ).toThrow(SecretLeakError);
  });

  test("catches a Bearer token anywhere (even under an innocent key)", () => {
    expect(() =>
      assertNoSecrets({ note: "use Bearer sk-abcd1234efgh5678 this" }),
    ).toThrow(SecretLeakError);
  });

  test("catches a secret embedded in a URL", () => {
    expect(() =>
      assertNoSecrets({
        url: "https://api.x.com?access_token=ABCD1234EFGH5678",
      }),
    ).toThrow(SecretLeakError);
  });

  test("catches an OpenAI-style key and a JWT", () => {
    expect(() => assertNoSecrets("sk-ABCDEFGHIJKLMNOP12345")).toThrow(
      SecretLeakError,
    );
    expect(() =>
      assertNoSecrets(
        "eyJhbGciOiJIUzI1Nied.eyJzdWIiOiIxMjM0NQ.SflKxwRJSMeKKF2QT4",
      ),
    ).toThrow(SecretLeakError);
  });

  test("scans recursively through arrays and nested objects", () => {
    expect(() =>
      assertNoSecrets({ a: [{ b: { c: "ghp_ABCDEFGHIJKLMNOPQRST" } }] }),
    ).toThrow(SecretLeakError);
  });
});

describe("buildToolWorkflow", () => {
  test("produces a valid Manual Trigger → HTTP Request workflow without auth material", () => {
    const wf = buildToolWorkflow({
      name: "Asaas charge",
      method: "post",
      url: "https://api.asaas.com/v3/payments",
    });
    expect(wf.active).toBe(false);
    expect(wf.nodes).toHaveLength(2);
    const http = wf.nodes.find((n) => n.type === "n8n-nodes-base.httpRequest");
    expect(http?.parameters.method).toBe("POST");
    expect(http?.parameters.authentication).toBe("none");
    expect(wf.connections["When clicked"]).toBeDefined();
  });

  test("refuses to build when the url carries a secret (backstop)", () => {
    expect(() =>
      buildToolWorkflow({
        name: "leaky",
        method: "get",
        url: "https://x.com?api_key=SECRETVALUE123456",
      }),
    ).toThrow(SecretLeakError);
  });
});

// ── DB-gated: tenant-scoped export ──
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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantA = 0n;
let tenantB = 0n;
let toolAId = 0n;
function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("exportToolWorkflow (tenant-scoped)", () => {
  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "N8nA", slug: `n8n-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "N8nB", slug: `n8n-b-${process.pid}` },
    });
    tenantB = b.id;
    const tool = await suDb.toolDefinition.create({
      data: {
        tenantId: tenantA,
        name: "Create charge",
        label: "Create charge",
        method: "POST",
        urlTemplate: "https://api.asaas.com/v3/payments",
        allowedHosts: ["api.asaas.com"],
        // A credential placeholder lives in headers — it must NOT appear in the export.
        headers: { Authorization: "{{secret}}" },
        credentialRef: "asaas-token",
      },
    });
    toolAId = tool.id;
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM tool_definitions WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("exports the tool as a workflow with no credential material", async () => {
    const { workflow, credentialsNote } = await exportToolWorkflow(
      ctx(tenantA),
      toolAId,
      appDb,
    );
    expect(workflow.name).toBe("Create charge");
    const json = JSON.stringify(workflow);
    expect(json).not.toContain("asaas-token");
    expect(json).not.toContain("{{secret}}");
    expect(credentialsNote).toContain("no credentials");
  });

  test("a tenant cannot export another tenant's tool", async () => {
    expect(exportToolWorkflow(ctx(tenantB), toolAId, appDb)).rejects.toThrow();
  });
});
