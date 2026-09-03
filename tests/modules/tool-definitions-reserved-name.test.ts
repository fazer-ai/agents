import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  createToolDefinition,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";

// Round 15 of PR #485. The assembly reserves every native name (#457, unique-names.ts): another tool
// that claims one is dropped, and the drop is a flow-log line. Nothing refused the name where it is
// TYPED, so an HTTP tool named `run_code` — or `handoff_to_human` — could be written, granted, shown
// in the console, and never reach the model. A document slug is refused at write time for the same
// collision (documents/slug.ts); this is the HTTP tool's equivalent, and REST, the console and MCP
// all land in the service.

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
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

function toolInput(name: string) {
  return {
    name,
    label: name,
    method: "GET" as const,
    urlTemplate: "https://example.com/x",
    allowedHosts: ["example.com"],
    inputSchema: {},
  };
}

async function refusal(p: Promise<unknown>): Promise<AppError | null> {
  return p.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e : null),
  );
}

describe.skipIf(!dbUp)("an HTTP tool cannot take a native tool's name", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "reserved-name", slug: `reserved-name-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (dbUp && tenantId) {
      await suDb.$executeRaw`DELETE FROM tool_definitions WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("creating one under any native name is refused as a conflict on the name", async () => {
    for (const name of NATIVE_TOOL_NAMES) {
      const err = await refusal(
        createToolDefinition(ctx(), toolInput(name) as never, appDb),
      );
      expect(err?.statusCode, name).toBe(409);
      expect(err?.translationKey, name).toBe("errors.toolNameReserved");
      expect(err?.field, name).toBe("name");
    }
    expect(await suDb.toolDefinition.count({ where: { tenantId } })).toBe(0);
  });

  test("renaming one onto a native name is refused, and the row keeps its name", async () => {
    const created = await createToolDefinition(
      ctx(),
      toolInput("run_code_custom") as never,
      appDb,
    );
    const err = await refusal(
      updateToolDefinition(
        ctx(),
        BigInt(created.id),
        { name: "run_code" } as never,
        appDb,
      ),
    );
    expect(err?.translationKey).toBe("errors.toolNameReserved");
    const row = await suDb.toolDefinition.findUnique({
      where: { id: BigInt(created.id) },
    });
    expect(row?.name).toBe("run_code_custom");
    // A rename to a free, non-native name is what the check must not touch.
    const renamed = await updateToolDefinition(
      ctx(),
      BigInt(created.id),
      { name: "run_code_http" } as never,
      appDb,
    );
    expect(renamed.name).toBe("run_code_http");
  });
});
