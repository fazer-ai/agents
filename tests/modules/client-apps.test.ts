import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  createClientApp,
  deleteClientApp,
  getClientApp,
  listClientApps,
  ROTATION_GRACE_MS,
  resolveClientApp,
  revokeClientAppSecret,
  rotateClientAppSecret,
  updateClientApp,
} from "@/modules/client-apps/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { clientAppUpdate } from "@/modules/mcp/write-client-apps";
import { dbProbeFailed } from "@/tests/db-gate";

// The applications that embed an agent through the client channel's SDK, read and written through
// the runtime role (RLS on) and checked in the real tables: the key the app's server signs with is
// shown once and stored encrypted, at most two keys verify at a time, and the lookup by public id,
// made before any tenant context, returns only the keys that still verify.

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

let tenantId = 0n;
let otherTenantId = 0n;
let agentId = 0n;
let ctx: TenantContext;
let otherCtx: TenantContext;

const ORIGINS = ["https://app.exemplo.com"];

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (e) {
    if (e instanceof AppError) return { status: e.statusCode };
    throw e;
  }
  throw new Error("expected a refusal");
}

describe.skipIf(!dbUp)("client apps", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "CAP", slug: `cap-${process.pid}` },
      })
    ).id;
    otherTenantId = (
      await suDb.tenant.create({
        data: { name: "CAP2", slug: `cap2-${process.pid}` },
      })
    ).id;
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Copiloto",
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-6-luna" },
        },
      })
    ).id;
    ctx = { tenantId, userId: null, role: "TENANT_ADMIN" };
    otherCtx = { tenantId: otherTenantId, userId: null, role: "TENANT_ADMIN" };
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.tenant.deleteMany({
        where: { id: { in: [tenantId, otherTenantId] } },
      });
    }
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  test("creating an app mints its first key, shown once and stored encrypted", async () => {
    const { app: created, secret } = await createClientApp(
      ctx,
      agentId,
      { name: "Sinete", allowedOrigins: ORIGINS },
      appDb,
    );
    expect(created.publicId).toStartWith("app_");
    expect(created.anonymousEnabled).toBe(false);
    expect(created.secrets.map((s) => s.kid)).toEqual([secret.kid]);
    expect(JSON.stringify(created)).not.toContain(secret.secret);
    const stored = await suDb.clientAppSecret.findUniqueOrThrow({
      where: { kid: secret.kid },
    });
    expect(stored.secret).not.toContain(secret.secret);
    const audit = await suDb.auditLog.findMany({
      where: { tenantId, target: created.id },
      select: { action: true, after: true },
    });
    expect(audit.map((a) => a.action)).toEqual(["client_app.create"]);
    expect(JSON.stringify(audit)).not.toContain(secret.secret);
  });

  test("an origin is stored as the browser sends it, and anything else is refused", async () => {
    const { app: created } = await createClientApp(
      ctx,
      agentId,
      {
        name: "Origens",
        allowedOrigins: [
          "https://App.Exemplo.com/",
          "https://app.exemplo.com",
          "http://localhost:3048",
          "https://app.exemplo.com:443",
        ],
      },
      appDb,
    );
    expect(created.allowedOrigins).toEqual([
      "https://app.exemplo.com",
      "http://localhost:3048",
    ]);
    for (const bad of [
      "http://app.exemplo.com",
      "https://app.exemplo.com/painel",
      "https://*.exemplo.com",
      "app.exemplo.com",
      "https://app.exemplo.com?x=1",
    ]) {
      expect(
        await refusal(() =>
          createClientApp(
            ctx,
            agentId,
            { name: "x", allowedOrigins: [bad] },
            appDb,
          ),
        ),
      ).toEqual({ status: 422 });
    }
  });

  test("another tenant's agent and another tenant's app are not found", async () => {
    expect(
      await refusal(() =>
        createClientApp(
          otherCtx,
          agentId,
          { name: "x", allowedOrigins: ORIGINS },
          appDb,
        ),
      ),
    ).toEqual({ status: 404 });
    const { app: created } = await createClientApp(
      ctx,
      agentId,
      { name: "Dono", allowedOrigins: ORIGINS },
      appDb,
    );
    const id = BigInt(created.id);
    expect(await listClientApps(otherCtx, agentId, appDb)).toEqual([]);
    for (const run of [
      () => getClientApp(otherCtx, id, appDb),
      () => updateClientApp(otherCtx, id, { name: "roubado" }, appDb),
      () => deleteClientApp(otherCtx, id, appDb),
      () => rotateClientAppSecret(otherCtx, id, appDb),
    ])
      expect(await refusal(run)).toEqual({ status: 404 });
    expect((await getClientApp(ctx, id, appDb)).name).toBe("Dono");
  });

  test("rotating keeps the previous key for the grace window, and at most two keys verify", async () => {
    const { app: created, secret: first } = await createClientApp(
      ctx,
      agentId,
      { name: "Troca", allowedOrigins: ORIGINS },
      appDb,
    );
    const id = BigInt(created.id);
    const t0 = new Date();
    const { secret: second } = await rotateClientAppSecret(ctx, id, appDb, t0);
    const afterOne = await resolveClientApp(created.publicId, appDb, t0);
    expect([...(afterOne?.keys.keys() ?? [])].sort()).toEqual(
      [first.kid, second.kid].sort(),
    );
    expect(afterOne?.keys.get(first.kid)).toBe(first.secret);

    const t1 = new Date(t0.getTime() + 1000);
    const { app: rotated, secret: third } = await rotateClientAppSecret(
      ctx,
      id,
      appDb,
      t1,
    );
    expect(rotated.secrets.map((s) => s.kid)).toEqual([third.kid, second.kid]);
    const afterTwo = await resolveClientApp(created.publicId, appDb, t1);
    expect([...(afterTwo?.keys.keys() ?? [])].sort()).toEqual(
      [second.kid, third.kid].sort(),
    );

    const past = new Date(t1.getTime() + ROTATION_GRACE_MS + 1);
    const later = await resolveClientApp(created.publicId, appDb, past);
    expect([...(later?.keys.keys() ?? [])]).toEqual([third.kid]);
  });

  test("rotations of one app racing each other still leave one current key and at most two that verify", async () => {
    const { app: created } = await createClientApp(
      ctx,
      agentId,
      { name: "Corrida", allowedOrigins: ORIGINS },
      appDb,
    );
    const id = BigInt(created.id);
    const now = new Date();
    await Promise.all(
      Array.from({ length: 6 }, () =>
        rotateClientAppSecret(ctx, id, appDb, now),
      ),
    );
    const rows = await suDb.clientAppSecret.findMany({
      where: { appId: id },
      select: { expiresAt: true },
    });
    const valid = await resolveClientApp(created.publicId, appDb, now);
    expect({
      current: rows.filter((r) => r.expiresAt === null).length,
      verifying: valid?.keys.size,
    }).toEqual({ current: 1, verifying: 2 });
  });

  test("a key past its grace is not found to revoke, as it is absent from the listing", async () => {
    const { app: created, secret: first } = await createClientApp(
      ctx,
      agentId,
      { name: "Vencida", allowedOrigins: ORIGINS },
      appDb,
    );
    const id = BigInt(created.id);
    const t0 = new Date();
    await rotateClientAppSecret(ctx, id, appDb, t0);
    const past = new Date(t0.getTime() + ROTATION_GRACE_MS + 1);
    expect(
      await refusal(() =>
        revokeClientAppSecret(ctx, id, first.kid, appDb, past),
      ),
    ).toEqual({ status: 404 });
    expect(
      await suDb.auditLog.count({
        where: {
          tenantId,
          target: created.id,
          action: "client_app.secret_revoke",
        },
      }),
    ).toBe(0);
  });

  test("saving an app with nothing changed writes no audit row", async () => {
    const { app: created } = await createClientApp(
      ctx,
      agentId,
      { name: "Igual", allowedOrigins: ORIGINS },
      appDb,
    );
    const id = BigInt(created.id);
    await updateClientApp(
      ctx,
      id,
      { name: "Igual", allowedOrigins: ORIGINS, anonymousEnabled: false },
      appDb,
    );
    await updateClientApp(ctx, id, {}, appDb);
    await updateClientApp(ctx, id, { name: "Outro" }, appDb);
    const actions = await suDb.auditLog.findMany({
      where: { tenantId, target: created.id, action: "client_app.update" },
      select: { after: true },
    });
    expect(actions.map((a) => (a.after as { name: string }).name)).toEqual([
      "Outro",
    ]);
  });

  test("revoking a key ends it now, the current one included", async () => {
    const { app: created, secret } = await createClientApp(
      ctx,
      agentId,
      { name: "Revoga", allowedOrigins: ORIGINS },
      appDb,
    );
    const id = BigInt(created.id);
    const after = await revokeClientAppSecret(ctx, id, secret.kid, appDb);
    expect(after.secrets).toEqual([]);
    expect((await resolveClientApp(created.publicId, appDb))?.keys.size).toBe(
      0,
    );
    expect(
      await refusal(() => revokeClientAppSecret(ctx, id, secret.kid, appDb)),
    ).toEqual({ status: 404 });
  });

  test("the public id resolves before any tenant context, and an unknown one resolves to nothing", async () => {
    const { app: created } = await createClientApp(
      ctx,
      agentId,
      { name: "Busca", allowedOrigins: ORIGINS, anonymousEnabled: true },
      appDb,
    );
    const resolved = await resolveClientApp(created.publicId, appDb);
    expect(resolved).toMatchObject({
      tenantId,
      agentId,
      allowedOrigins: ORIGINS,
      anonymousEnabled: true,
    });
    expect(await resolveClientApp("app_nao-existe", appDb)).toBeNull();
  });

  test("the Turnstile secret is stored encrypted, never returned, and resolved only while the challenge is on", async () => {
    const SECRET = "0x4AAAAAAAsegredo-do-turnstile";
    expect(
      await refusal(() =>
        createClientApp(
          ctx,
          agentId,
          {
            name: "Sem segredo",
            allowedOrigins: ORIGINS,
            turnstileEnabled: true,
            turnstileSiteKey: "0x4AAAAAAAchave",
          },
          appDb,
        ),
      ),
    ).toEqual({ status: 422 });
    const { app: created } = await createClientApp(
      ctx,
      agentId,
      {
        name: "Desafio",
        allowedOrigins: ORIGINS,
        anonymousEnabled: true,
        turnstileEnabled: true,
        turnstileSiteKey: "0x4AAAAAAAchave",
        turnstileSecret: SECRET,
      },
      appDb,
    );
    const id = BigInt(created.id);
    expect(created).toMatchObject({
      turnstileEnabled: true,
      turnstileSiteKey: "0x4AAAAAAAchave",
      turnstileSecretSet: true,
    });
    expect(JSON.stringify(created)).not.toContain(SECRET);
    const stored = await suDb.clientApp.findUniqueOrThrow({ where: { id } });
    expect(stored.turnstileSecret).not.toBeNull();
    expect(stored.turnstileSecret).not.toContain(SECRET);
    expect(
      (await resolveClientApp(created.publicId, appDb))?.turnstileSecret,
    ).toBe(SECRET);

    // Clearing the site key under a challenge that stays on is refused; the stored values stay.
    expect(
      await refusal(() =>
        updateClientApp(ctx, id, { turnstileSiteKey: null }, appDb),
      ),
    ).toEqual({ status: 422 });
    // Replacing the secret is an audited change, and the trail never holds it.
    await updateClientApp(ctx, id, { turnstileSecret: "outro-segredo" }, appDb);
    expect(
      (await resolveClientApp(created.publicId, appDb))?.turnstileSecret,
    ).toBe("outro-segredo");
    const audit = await suDb.auditLog.findMany({
      where: { tenantId, target: created.id },
      select: { action: true, before: true, after: true },
      orderBy: { id: "asc" },
    });
    expect(audit.map((a) => a.action)).toEqual([
      "client_app.create",
      "client_app.update",
    ]);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect(JSON.stringify(audit)).not.toContain("outro-segredo");

    // Off, the lookup carries no secret: the session route asks for no challenge.
    const off = await updateClientApp(
      ctx,
      id,
      { turnstileEnabled: false },
      appDb,
    );
    expect(off.turnstileSecretSet).toBe(true);
    expect(
      (await resolveClientApp(created.publicId, appDb))?.turnstileSecret,
    ).toBeNull();
  });

  test("an update racing one that clears the secret cannot leave the challenge on with no secret", async () => {
    const { app: created } = await createClientApp(
      ctx,
      agentId,
      {
        name: "Corrida",
        allowedOrigins: ORIGINS,
        anonymousEnabled: true,
        turnstileSiteKey: "0x4AAAAAAAchave",
        turnstileSecret: "segredo",
      },
      appDb,
    );
    const id = BigInt(created.id);
    // The other update commits between this one's read and its write: this one checked a row that
    // still had the secret.
    let raced = false;
    const racing = appDb.$extends({
      query: {
        clientApp: {
          async findUnique({ args, query }) {
            const read = await query(args);
            if (!raced) {
              raced = true;
              await suDb.clientApp.update({
                where: { id },
                data: { turnstileSecret: null },
              });
            }
            return read;
          },
        },
      },
    }) as unknown as PrismaClient;
    const refused = await refusal(() =>
      updateClientApp(ctx, id, { turnstileEnabled: true }, racing),
    );
    const stored = await suDb.clientApp.findUniqueOrThrow({ where: { id } });
    expect({
      raced,
      refused,
      enabled: stored.turnstileEnabled,
      secret: stored.turnstileSecret,
    }).toEqual({
      raced: true,
      refused: { status: 422 },
      enabled: false,
      secret: null,
    });
  });

  test("over MCP the challenge toggles and takes its site key, and a preview refuses what the write would", async () => {
    const was = config.clientChannel.enabled;
    config.clientChannel.enabled = true;
    try {
      const principal = {
        userId: 1n,
        tenantId,
        clientId: "c",
        jti: "j",
        role: "TENANT_ADMIN",
        scopes: ["mcp:read", "mcp:write"],
      } as unknown as VerifiedToken;
      const { app: created } = await createClientApp(
        ctx,
        agentId,
        { name: "Pelo MCP", allowedOrigins: ORIGINS, anonymousEnabled: true },
        appDb,
      );
      const on = (dry_run: boolean) =>
        clientAppUpdate(
          principal,
          {
            client_app_id: created.id,
            turnstile_enabled: true,
            turnstile_site_key: "0x4AAAAAAAchave",
            dry_run,
          },
          { base: appDb },
        );
      const noSecretPreview = (await on(true)).ok;
      const noSecretWrite = (await on(false)).ok;
      await updateClientApp(
        ctx,
        BigInt(created.id),
        { turnstileSecret: "segredo" },
        appDb,
      );
      const preview = await on(true);
      const applied = await on(false);
      expect({
        noSecretPreview,
        noSecretWrite,
        preview: preview.ok,
        applied: applied.ok
          ? (applied.data.clientApp as { turnstileEnabled: boolean })
              .turnstileEnabled
          : null,
        resolved: (await resolveClientApp(created.publicId, appDb))
          ?.turnstileSecret,
      }).toEqual({
        noSecretPreview: false,
        noSecretWrite: false,
        preview: true,
        applied: true,
        resolved: "segredo",
      });
    } finally {
      config.clientChannel.enabled = was;
    }
  });

  test("deleting the app takes its keys with it", async () => {
    const { app: created, secret } = await createClientApp(
      ctx,
      agentId,
      { name: "Apaga", allowedOrigins: ORIGINS },
      appDb,
    );
    await deleteClientApp(ctx, BigInt(created.id), appDb);
    expect(await resolveClientApp(created.publicId, appDb)).toBeNull();
    expect(
      await suDb.clientAppSecret.count({ where: { kid: secret.kid } }),
    ).toBe(0);
  });
});
