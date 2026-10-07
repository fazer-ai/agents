import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  createMcpConnection,
  discoverMcpTools,
} from "@/modules/mcp-connections/service";

// The console's discovery, end to end through the stored connection: a server it cannot reach
// comes back as the 502 the route answers, with the reason by kind, not as an unhandled error.
// NOTE: the test preload installs happy-dom's fetch, whose network errors carry no runtime code;
// the app runs on Bun's own, saved by the preload under a `Bun` prefix.
const NATIVE = ["fetch", "Headers", "AbortController", "AbortSignal"] as const;
const g = globalThis as unknown as Record<string, unknown>;
const domGlobals = Object.fromEntries(NATIVE.map((k) => [k, g[k]]));

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

describe.skipIf(!dbUp)("discovering a stored MCP connection that fails", () => {
  let tenant = 0n;
  const privateBefore = config.ssrf.allowPrivateTargets;
  const ctx = (): TenantContext => ({
    tenantId: tenant,
    userId: null,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    config.ssrf.allowPrivateTargets = true;
    for (const k of NATIVE) g[k] = g[`Bun${k[0]?.toUpperCase()}${k.slice(1)}`];
    tenant = (
      await suDb.tenant.create({
        data: { name: "MD", slug: `md-${process.pid}` },
      })
    ).id;
  });

  afterAll(async () => {
    config.ssrf.allowPrivateTargets = privateBefore;
    for (const k of NATIVE) g[k] = domGlobals[k];
    if (tenant) await suDb.tenant.delete({ where: { id: tenant } });
    await app?.$disconnect();
    await su?.$disconnect();
  });

  test("a closed port answers 502 unreachable", async () => {
    const c = await createMcpConnection(
      ctx(),
      {
        name: "closed-port",
        transport: "streamableHttp",
        url: "http://127.0.0.1:9/mcp",
      },
      appDb,
    );
    const err = await discoverMcpTools(ctx(), BigInt(c.id), appDb).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(502);
    expect((err as AppError).translationKey).toBe(
      "errors.mcpDiscoveryUnreachable",
    );
  });
});
