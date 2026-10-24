import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  occurrenceMonitorCreate,
  occurrenceMonitorDelete,
  occurrencesSet,
} from "@/modules/mcp/write-occurrences";
import { ensureAllOccurrenceRounds } from "@/modules/occurrences/arm";
import {
  createMonitor,
  deleteMonitor,
  duplicateMonitor,
  getOccurrencesSettings,
  listMonitors,
  MONITORS_MAX,
  renameMonitor,
  requireMonitor,
  resolveMonitor,
  updateMonitorConfig,
  updateOccurrencesSettings,
} from "@/modules/occurrences/monitors";
import { occurrenceRoundHandler } from "@/modules/occurrences/round";
import type { OccurrenceField } from "@/modules/occurrences/settings";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";

// Several occurrence monitors per account (docs/occurrences.md, "Monitors"): what the account-level
// rules refuse (the cap, a taken name, two monitors writing one Chatwoot attribute on one inbox), what
// duplicating and deleting take with them, one round job per monitor on its own cadence, and the paths
// that name no monitor answering for the first.

let appDb: PrismaClient;
let suDb: PrismaClient;
let dbUp = true;
if (!process.env.TEST_APP_DATABASE_URL) dbUp = false;
else {
  appDb = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.TEST_APP_DATABASE_URL,
    }),
  });
  suDb = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.TEST_MIGRATION_DATABASE_URL,
    }),
  });
  try {
    await suDb.$queryRaw`SELECT 1`;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

const FIELDS: OccurrenceField[] = [
  {
    key: "evento",
    name: "Evento",
    description: "O evento.",
    attribute: true,
  },
  {
    key: "motivo",
    name: "Motivo",
    description: "Por que escreveu.",
    attribute: false,
  },
];

const created: bigint[] = [];
let seq = 0;

// An account with two inboxes an agent receives and a key for the model.
async function account() {
  seq += 1;
  const slug = `occ-mon-${process.pid}-${seq}`;
  const t = await suDb.tenant.create({ data: { name: slug, slug } });
  created.push(t.id);
  const dep = await suDb.chatwootDeployment.create({
    data: {
      tenantId: t.id,
      baseUrl: `https://chat.${slug}.example.com`,
      adminToken: encryptJson("ADMIN"),
    },
  });
  const inst = await suDb.chatwootInstance.create({
    data: {
      tenantId: t.id,
      deploymentId: dep.id,
      accountId: 1,
      serverKey: `https://chat.${slug}.example.com`,
      accountName: slug,
    },
  });
  const agent = await suDb.agent.create({
    data: { tenantId: t.id, name: "Gi", systemPrompt: "x" },
  });
  const inbox = (n: number, name: string) =>
    suDb.inbox.create({
      data: {
        tenantId: t.id,
        chatwootInstanceId: inst.id,
        chatwootInboxId: n,
        name,
        agentId: agent.id,
      },
    });
  const sac = await inbox(1, "SAC");
  const produtor = await inbox(2, "Produtor");
  const key = await suDb.vaultEntry.create({
    data: { tenantId: t.id, name: "openai", secret: encryptJson("sk-x") },
  });
  const ctx: TenantContext = {
    tenantId: t.id,
    userId: null,
    role: "TENANT_ADMIN",
  };
  const on = (inboxIds: bigint[], fields = FIELDS) => ({
    enabled: true,
    inboxIds: inboxIds.map(String),
    fields,
    reasonField: "motivo",
    referenceField: "evento",
    model: {
      provider: "openai" as const,
      model: "gpt-test",
      credentialRef: `vault:${key.id}`,
      baseURL: null,
    },
  });
  const principal: VerifiedToken = {
    userId: 1n,
    tenantId: t.id,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  };
  const jobs = () =>
    suDb.schedulerJob.findMany({
      where: { tenantId: t.id, kind: "OCCURRENCE_ROUND", status: "PENDING" },
      select: { dedupeKey: true, payload: true },
      orderBy: { dedupeKey: "asc" },
    });
  return { tenantId: t.id, ctx, sac, produtor, on, principal, jobs };
}

describe.skipIf(!dbUp)("occurrence monitors", () => {
  beforeAll(() => {
    seq = 0;
  });
  afterAll(async () => {
    await suDb.tenant.deleteMany({ where: { id: { in: created } } });
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  test("a new monitor is off with the default configuration, under a name the account has no other of", async () => {
    const a = await account();
    const m = await createMonitor(a.ctx, { name: "  Produtor  " }, appDb);
    expect(m).toMatchObject({
      name: "Produtor",
      enabled: false,
      inboxIds: [],
      lastRun: null,
      openThemes: 0,
      runs: 0,
    });
    await expect(
      createMonitor(a.ctx, { name: "Produtor" }, appDb),
    ).rejects.toMatchObject({ statusCode: 409 });
    for (const name of ["", "   ", "x".repeat(81)])
      await expect(createMonitor(a.ctx, { name }, appDb)).rejects.toMatchObject(
        { statusCode: 422 },
      );
    const audit = await suDb.auditLog.findFirstOrThrow({
      where: { tenantId: a.tenantId, action: "occurrence_monitor.created" },
    });
    expect(audit.target).toBe(`occurrence_monitor:${m.id}`);
  });

  test(`an account holds at most ${MONITORS_MAX}: creating, duplicating and the MCP are refused past it`, async () => {
    const a = await account();
    for (let i = 0; i < MONITORS_MAX; i += 1)
      await createMonitor(a.ctx, { name: `M${i}` }, appDb);
    // Translated by the console's locale, like every refusal with a key.
    await expect(
      createMonitor(a.ctx, { name: "Onze" }, appDb),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationKey: "errors.occurrenceMonitorLimit",
      translationParams: { max: MONITORS_MAX },
    });
    const first = (await listMonitors(a.ctx, appDb))[0];
    await expect(
      duplicateMonitor(a.ctx, BigInt(first?.id ?? 0), {}, appDb),
    ).rejects.toMatchObject({ statusCode: 422 });
    for (const dry_run of [undefined, false]) {
      const res = await occurrenceMonitorCreate(
        a.principal,
        { name: "Onze", ...(dry_run === undefined ? {} : { dry_run }) },
        { base: appDb },
      );
      expect(JSON.stringify(res)).toContain(`at most ${MONITORS_MAX}`);
    }
    expect(await listMonitors(a.ctx, appDb)).toHaveLength(MONITORS_MAX);
  });

  test("duplicating copies the configuration only, off and with no inboxes, under a numbered name", async () => {
    const a = await account();
    await updateOccurrencesSettings(
      a.ctx,
      { ...a.on([a.sac.id]), businessContext: "Ingressos" },
      appDb,
    );
    const source = await resolveMonitor(a.ctx, undefined, appDb);
    await suDb.occurrenceTheme.create({
      data: {
        tenantId: a.tenantId,
        monitorId: source?.id as bigint,
        title: "Ingresso",
      },
    });
    const copy = await duplicateMonitor(a.ctx, source?.id as bigint, {}, appDb);
    expect(copy).toMatchObject({
      name: "Ocorrências (2)",
      enabled: false,
      inboxIds: [],
      openThemes: 0,
      runs: 0,
    });
    const full = await requireMonitor(a.ctx, BigInt(copy.id), appDb);
    expect(full.config).toEqual({
      ...(source?.config as object),
      enabled: false,
      inboxIds: [],
    } as never);
    expect(
      (await duplicateMonitor(a.ctx, source?.id as bigint, {}, appDb)).name,
    ).toBe("Ocorrências (3)");
    // The copy has no round: it is off.
    expect((await a.jobs()).map((j) => j.dedupeKey)).toEqual([
      `occurrences:${source?.id}`,
    ]);
  });

  test("each monitor in the list carries its own newest round and counts", async () => {
    const a = await account();
    const one = BigInt((await createMonitor(a.ctx, { name: "Um" }, appDb)).id);
    const two = BigInt(
      (await createMonitor(a.ctx, { name: "Dois" }, appDb)).id,
    );
    const at = (h: number) => new Date(Date.UTC(2026, 9, 20, h));
    for (const [monitorId, h, status] of [
      [one, 1, "ok"],
      [one, 3, "failed"],
      [one, 2, "ok"],
      [two, 5, "ok"],
    ] as const)
      await suDb.occurrenceRun.create({
        data: { tenantId: a.tenantId, monitorId, startedAt: at(h), status },
      });
    const [first, second] = await listMonitors(a.ctx, appDb);
    expect(first).toMatchObject({
      name: "Um",
      runs: 3,
      lastRun: { startedAt: at(3).toISOString(), status: "failed" },
    });
    expect(second).toMatchObject({
      name: "Dois",
      runs: 1,
      lastRun: { startedAt: at(5).toISOString(), status: "ok" },
    });
  });

  test("renaming keeps the name unique and leaves the configuration alone", async () => {
    const a = await account();
    const one = await createMonitor(a.ctx, { name: "Um" }, appDb);
    await createMonitor(a.ctx, { name: "Dois" }, appDb);
    await expect(
      renameMonitor(a.ctx, BigInt(one.id), { name: "Dois" }, appDb),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (await renameMonitor(a.ctx, BigInt(one.id), { name: "Três" }, appDb))
        .name,
    ).toBe("Três");
  });

  test("deleting takes the monitor's rows and its round, says how many, and leaves the other monitor whole", async () => {
    const a = await account();
    const keep = await createMonitor(a.ctx, { name: "Fica" }, appDb);
    const gone = await createMonitor(a.ctx, { name: "Sai" }, appDb);
    for (const m of [keep, gone])
      await updateMonitorConfig(
        a.ctx,
        BigInt(m.id),
        a.on([m === keep ? a.sac.id : a.produtor.id]),
        appDb,
      );
    for (const m of [keep, gone]) {
      const monitorId = BigInt(m.id);
      await suDb.occurrenceTheme.create({
        data: { tenantId: a.tenantId, monitorId, title: `Tema ${m.name}` },
      });
      await suDb.occurrenceRun.create({
        data: { tenantId: a.tenantId, monitorId, status: "ok" },
      });
    }
    const preview = await occurrenceMonitorDelete(
      a.principal,
      { monitor_id: gone.id },
      { base: appDb },
    );
    expect(JSON.stringify(preview)).toContain('"openThemes":1');
    expect(await listMonitors(a.ctx, appDb)).toHaveLength(2);
    expect(await deleteMonitor(a.ctx, BigInt(gone.id), appDb)).toEqual({
      deleted: true,
      openThemes: 1,
      runs: 1,
    });
    expect(
      await suDb.occurrenceTheme.count({
        where: { monitorId: BigInt(gone.id) },
      }),
    ).toBe(0);
    expect(
      await suDb.occurrenceRun.count({ where: { monitorId: BigInt(gone.id) } }),
    ).toBe(0);
    expect((await a.jobs()).map((j) => j.dedupeKey)).toEqual([
      `occurrences:${keep.id}`,
    ]);
    expect((await listMonitors(a.ctx, appDb)).map((m) => m.name)).toEqual([
      "Fica",
    ]);
    // A round claimed when the monitor goes is retired too, so its reschedule is never written.
    const claimed = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId: a.tenantId, dedupeKey: `occurrences:${keep.id}` },
    });
    await suDb.schedulerJob.update({
      where: { id: claimed.id },
      data: { status: "CLAIMED" },
    });
    await deleteMonitor(a.ctx, BigInt(keep.id), appDb);
    const retired = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: claimed.id },
    });
    expect(retired.status).toBe("DONE");
    expect(retired.claimSeq).toBe(claimed.claimSeq + 1);
    await expect(
      deleteMonitor(a.ctx, BigInt(gone.id), appDb),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("two monitors never write one Chatwoot attribute on one inbox, and the refusal names the other", async () => {
    const a = await account();
    await updateOccurrencesSettings(a.ctx, a.on([a.sac.id]), appDb);
    const second = await createMonitor(a.ctx, { name: "Produtor" }, appDb);
    const id = BigInt(second.id);
    const refusal =
      'the monitor "Ocorrências" already writes the Chatwoot attribute "evento" on the inbox "SAC"';
    await expect(
      updateMonitorConfig(a.ctx, id, a.on([a.produtor.id, a.sac.id]), appDb),
    ).rejects.toThrow(refusal);
    const preview = await occurrencesSet(
      a.principal,
      { monitor_id: second.id, ...a.on([a.sac.id]) },
      { base: appDb },
    );
    expect(JSON.stringify(preview)).toContain(refusal.replaceAll('"', '\\"'));
    // The same inbox without the copy to Chatwoot, or another inbox with it, is fine.
    const plain = FIELDS.map((f) => ({ ...f, attribute: false }));
    expect(
      (await updateMonitorConfig(a.ctx, id, a.on([a.sac.id], plain), appDb))
        .enabled,
    ).toBe(true);
    expect(
      (await updateMonitorConfig(a.ctx, id, a.on([a.produtor.id]), appDb))
        .inboxIds,
    ).toEqual([String(a.produtor.id)]);
  });

  test("each monitor has its own round, on its own cadence, and switching one off leaves the other's", async () => {
    const a = await account();
    await updateOccurrencesSettings(
      a.ctx,
      { ...a.on([a.sac.id]), cadenceMinutes: 10 },
      appDb,
    );
    const first = await resolveMonitor(a.ctx, undefined, appDb);
    const second = await createMonitor(a.ctx, { name: "Produtor" }, appDb);
    const plain = FIELDS.map((f) => ({ ...f, attribute: false }));
    await updateMonitorConfig(
      a.ctx,
      BigInt(second.id),
      { ...a.on([a.produtor.id], plain), cadenceMinutes: 60 },
      appDb,
    );
    expect(await a.jobs()).toEqual(
      [first?.id, BigInt(second.id)]
        .map((id) => ({
          dedupeKey: `occurrences:${id}`,
          payload: { monitorId: String(id) },
        }))
        .sort((x, y) => x.dedupeKey.localeCompare(y.dedupeKey)),
    );
    expect(
      (await requireMonitor(a.ctx, BigInt(second.id), appDb)).config
        .cadenceMinutes,
    ).toBe(60);
    expect((await getOccurrencesSettings(a.ctx, appDb)).cadenceMinutes).toBe(
      10,
    );
    await updateOccurrencesSettings(a.ctx, { enabled: false }, appDb);
    expect((await a.jobs()).map((j) => j.dedupeKey)).toEqual([
      `occurrences:${second.id}`,
    ]);
    // At boot, only a monitor that is on is armed.
    await suDb.schedulerJob.deleteMany({
      where: { tenantId: a.tenantId, kind: "OCCURRENCE_ROUND" },
    });
    await ensureAllOccurrenceRounds(appDb);
    expect((await a.jobs()).map((j) => j.dedupeKey)).toEqual([
      `occurrences:${second.id}`,
    ]);
  });

  test("an id of another account's monitor, or of none, is a 404", async () => {
    const a = await account();
    const b = await account();
    const theirs = await createMonitor(b.ctx, { name: "Deles" }, appDb);
    for (const id of [BigInt(theirs.id), 999_999_999n]) {
      await expect(requireMonitor(a.ctx, id, appDb)).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(
        updateMonitorConfig(a.ctx, id, { cadenceMinutes: 30 }, appDb),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(deleteMonitor(a.ctx, id, appDb)).rejects.toMatchObject({
        statusCode: 404,
      });
    }
    expect((await requireMonitor(b.ctx, BigInt(theirs.id), appDb)).name).toBe(
      "Deles",
    );
  });

  test("the paths that name no monitor answer for the first, and a refused first save creates none", async () => {
    const a = await account();
    // No monitor: the defaults, and a write the block refuses leaves the account without one.
    expect((await getOccurrencesSettings(a.ctx, appDb)).enabled).toBe(false);
    await expect(
      updateOccurrencesSettings(a.ctx, { enabled: true }, appDb),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      updateOccurrencesSettings(a.ctx, { inboxIds: ["999999999"] }, appDb),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(await listMonitors(a.ctx, appDb)).toEqual([]);
    // The first save creates it, and the next save is the same monitor's.
    await updateOccurrencesSettings(a.ctx, { cadenceMinutes: 20 }, appDb);
    await updateOccurrencesSettings(a.ctx, { cadenceMinutes: 25 }, appDb);
    const monitors = await listMonitors(a.ctx, appDb);
    expect(monitors.map((m) => m.name)).toEqual(["Ocorrências"]);
    // A monitor created later is not the first.
    const later = await createMonitor(a.ctx, { name: "Depois" }, appDb);
    await updateMonitorConfig(
      a.ctx,
      BigInt(later.id),
      { cadenceMinutes: 90 },
      appDb,
    );
    expect((await getOccurrencesSettings(a.ctx, appDb)).cadenceMinutes).toBe(
      25,
    );
  });

  test("a round job that names no monitor, or one that is gone or off, runs nothing", async () => {
    const a = await account();
    const m = await createMonitor(a.ctx, { name: "Desligado" }, appDb);
    for (const payload of [{}, { monitorId: "999999999" }, { monitorId: m.id }])
      expect(
        await occurrenceRoundHandler(
          { tenantId: a.tenantId, payload } as unknown as ClaimedJob,
          appDb,
        ),
      ).toEqual({ outcome: "done" });
    expect(
      await suDb.occurrenceRun.count({ where: { tenantId: a.tenantId } }),
    ).toBe(0);
  });
});
