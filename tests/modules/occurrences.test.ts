import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { refuseUnknownOccurrenceKeys } from "@/api/v1/occurrences.controller";
import type { TenantContext } from "@/lib/tenancy";
import { runScopedOn } from "@/lib/tenancy";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { occurrencesSet } from "@/modules/mcp/write-occurrences";
import { syncMonitorRound } from "@/modules/occurrences/arm";
import { sysCtx } from "@/modules/occurrences/config";
import {
  KEYLESS_API_KEY,
  resolveMonitorModel,
} from "@/modules/occurrences/model";
import {
  getOccurrencesSettings,
  updateOccurrencesSettings,
} from "@/modules/occurrences/monitors";
import {
  READING_VALUE_MAX,
  readingValue,
  upsertReadings,
} from "@/modules/occurrences/readings";
import { runOccurrenceRound } from "@/modules/occurrences/round";
import { listOccurrenceRuns } from "@/modules/occurrences/runs";
import {
  OCCURRENCES_DEFAULTS,
  type OccurrenceField,
  occurrencesSettingsSchema,
  readOccurrencesConfig,
} from "@/modules/occurrences/settings";
import { dbProbeFailed } from "@/tests/db-gate";
import { until } from "@/tests/utils/poll";

// The occurrence monitor's first layer (docs/occurrences.md): the account's own fields, the inboxes
// and the model it names, the readings as stored, and the round that leaves a row every time it runs.
// The reading step itself is tests/modules/occurrence-reading.test.ts.

const READING = {
  provider: "openai" as const,
  model: "gpt-test",
  credentialRef: "vault:1",
  baseURL: null,
};

const FIELDS: OccurrenceField[] = [
  {
    key: "referencia",
    name: "Referência",
    description: "A que o motivo se refere.",
    attribute: true,
  },
  {
    key: "motivo",
    name: "Motivo",
    description: "Por que o cliente entrou em contato, numa frase curta.",
    attribute: false,
  },
];

describe("the settings block", () => {
  test("off by default, with no field named anywhere", () => {
    expect(readOccurrencesConfig({})).toEqual(OCCURRENCES_DEFAULTS);
    expect(OCCURRENCES_DEFAULTS.enabled).toBe(false);
    expect(OCCURRENCES_DEFAULTS.fields).toEqual([]);
    expect(OCCURRENCES_DEFAULTS.referenceField).toBeNull();
    // Recovering old media costs the inbox agent's providers: never on unless asked.
    expect(OCCURRENCES_DEFAULTS.recoverMedia).toBe(false);
    expect(OCCURRENCES_DEFAULTS.reasonField).toBeNull();
    expect(OCCURRENCES_DEFAULTS.model).toBeNull();
  });

  test("a damaged block reads as the default instead of failing the turn", () => {
    expect(
      readOccurrencesConfig({ occurrences: { enabled: "sim", fields: 3 } }),
    ).toEqual(OCCURRENCES_DEFAULTS);
  });

  test("a key the block does not have is refused, and a stored one does not switch the monitor off", () => {
    const ok = {
      ...OCCURRENCES_DEFAULTS,
      enabled: true,
      inboxIds: ["1"],
      model: READING,
      fields: FIELDS,
      referenceField: "referencia",
      reasonField: "motivo",
    };
    expect(
      occurrencesSettingsSchema.safeParse({ ...ok, digestHour: 9 }).success,
    ).toBe(false);
    // A key the block has, out of its range, is refused by the range.
    expect(
      occurrencesSettingsSchema.safeParse({ ...ok, concentrationShare: 1.5 })
        .success,
    ).toBe(false);
    expect(
      occurrencesSettingsSchema.safeParse({
        ...ok,
        fields: [{ ...FIELDS[0], color: "red" }, FIELDS[1]],
      }).success,
    ).toBe(false);
    // What a later version stored, read by this one: its own keys still hold.
    expect(
      readOccurrencesConfig({
        occurrences: { ...ok, digestHour: 9 },
      }),
    ).toEqual(ok);
  });

  test("a REST body with a key the block does not have is refused before it is cleaned away", () => {
    for (const body of [
      { digestHour: 9 },
      { enabled: false, fields: [{ ...FIELDS[0], color: "red" }] },
      // The names the block had before the reason and the reference.
      { subjectField: "referencia" },
      { problemField: "motivo" },
      { models: { reading: READING } },
    ])
      expect(() => refuseUnknownOccurrenceKeys(body)).toThrow(
        expect.objectContaining({ statusCode: 422 }),
      );
    expect(() =>
      refuseUnknownOccurrenceKeys({ enabled: false, fields: FIELDS }),
    ).not.toThrow();
  });

  test("a model saved with an endpoint its provider drops does not run", async () => {
    const r = await resolveMonitorModel(
      undefined as unknown as Parameters<typeof resolveMonitorModel>[0],
      1n,
      { ...READING, credentialRef: null, baseURL: "https://proxy.example/v1" },
    );
    expect(r).toEqual({
      ok: false,
      reason: "a openai model does not take an endpoint",
    });
  });

  test("a keyless openai-compatible model sends a placeholder key the SDK accepts", async () => {
    const r = await resolveMonitorModel(
      undefined as unknown as Parameters<typeof resolveMonitorModel>[0],
      1n,
      {
        provider: "openai-compatible",
        model: "local-model",
        credentialRef: null,
        baseURL: "http://127.0.0.1:8080/v1",
      },
    );
    expect(r.ok && r.mc.apiKey).toBe(KEYLESS_API_KEY);
  });

  test("refuses what would leave the monitor counting nothing", () => {
    const ok = {
      ...OCCURRENCES_DEFAULTS,
      enabled: true,
      inboxIds: ["1"],
      model: READING,
      fields: FIELDS,
      referenceField: "referencia",
      reasonField: "motivo",
    };
    expect(occurrencesSettingsSchema.safeParse(ok).success).toBe(true);
    // A provider that dials an endpoint keeps one.
    expect(
      occurrencesSettingsSchema.safeParse({
        ...ok,
        model: {
          ...READING,
          provider: "openrouter",
          baseURL: "https://proxy.example/v1",
        },
      }).success,
    ).toBe(true);
    // The reference is optional: without it the monitor still switches on.
    expect(
      occurrencesSettingsSchema.safeParse({ ...ok, referenceField: null })
        .success,
    ).toBe(true);
    const bad = [
      {
        ...ok,
        fields: [{ ...FIELDS[0], key: "__proto__" }, FIELDS[1]],
        referenceField: "__proto__",
      },
      {
        ...ok,
        fields: [{ ...FIELDS[0], key: "constructor" }, FIELDS[1]],
        referenceField: "constructor",
      },
      { ...ok, reasonField: null },
      { ...ok, model: null },
      { ...ok, inboxIds: [] },
      { ...ok, inboxIds: ["1", "1"] },
      { ...ok, inboxIds: ["x"] },
      { ...ok, model: { ...READING, credentialRef: null } },
      // A keyless openai-compatible model with no endpoint anywhere.
      {
        ...ok,
        model: {
          provider: "openai-compatible",
          model: "local-model",
          credentialRef: null,
          baseURL: null,
        },
      },
      // An endpoint openai's adapter drops: the text would go to the vendor, not the proxy.
      { ...ok, model: { ...READING, baseURL: "https://proxy.example/v1" } },
      { ...ok, model: { ...READING, model: "gpt\u0000mini" } },
      { ...ok, model: { ...READING, provider: "nope" } },
      { ...ok, model: { ...READING, temperature: 0 } },
      // The names the block had before.
      { ...ok, subjectField: "referencia" },
      { ...ok, problemField: "motivo" },
      { ...ok, models: { reading: READING } },
      { ...ok, businessContext: "x".repeat(2_001) },
      { ...ok, businessContext: "meio \ud800 contexto" },
      { ...ok, recoverMedia: "true" },
      { ...ok, recoverMedia: null },
      { ...ok, referenceField: "inexistente" },
      // The reason and the reference are two fields, not one.
      { ...ok, reasonField: "referencia" },
      { ...ok, fields: [FIELDS[0], FIELDS[0], FIELDS[1]] },
      {
        ...ok,
        fields: [{ ...FIELDS[0], name: "Referência\u0000" }, FIELDS[1]],
      },
      {
        ...ok,
        fields: [
          FIELDS[0],
          { ...FIELDS[1], description: "meio \ud800 caractere" },
        ],
      },
      { ...ok, fields: [{ ...FIELDS[0], key: "Referência Nova" }, FIELDS[1]] },
      {
        ...ok,
        fields: Array.from({ length: 11 }, (_, i) => ({
          ...FIELDS[1],
          key: `f${i}`,
        })),
      },
      { ...ok, cadenceMinutes: 4 },
      { ...ok, cadenceMinutes: 1441 },
    ];
    for (const b of bad)
      expect(occurrencesSettingsSchema.safeParse(b).success).toBe(false);
    // Off, an incomplete block is a draft and saves.
    expect(
      occurrencesSettingsSchema.safeParse({
        ...ok,
        enabled: false,
        reasonField: null,
        inboxIds: [],
        model: null,
      }).success,
    ).toBe(true);
  });
});

describe("a reading's value as stored", () => {
  test("collapsed, capped without splitting a character, and storable", () => {
    expect(readingValue("  pix   não\n confirma ")).toBe("pix não confirma");
    const long = `${"a".repeat(READING_VALUE_MAX - 1)}😀`;
    expect(readingValue(long)).toBe("a".repeat(READING_VALUE_MAX - 1));
    expect(readingValue("a\u0000b\ud800")).toBe("ab\ufffd");
  });
});

let appDb: PrismaClient;
let suDb: PrismaClient;
let dbUp = true;

if (!process.env.TEST_APP_DATABASE_URL) {
  dbUp = false;
} else {
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

describe.skipIf(!dbUp)("against the database", () => {
  let tenantId = 0n;
  let otherTenantId = 0n;
  let agentId = 0n;
  let inboxId = 0n;
  let foreignInboxId = 0n;
  // An inbox of this account that no agent receives.
  let silentInboxId = 0n;
  let keyRef = "";
  let conversationId = 0n;
  const reading = () => ({ ...READING, credentialRef: keyRef });
  const ctx = (): TenantContext => ({
    tenantId,
    userId: null,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    const mk = async (slug: string) => {
      const t = await suDb.tenant.create({
        data: { name: slug, slug: `${slug}-${process.pid}` },
      });
      const dep = await suDb.chatwootDeployment.create({
        data: {
          tenantId: t.id,
          baseUrl: `https://chat.${slug}-${process.pid}.example.com`,
          adminToken: encryptJson("ADMIN"),
        },
      });
      const inst = await suDb.chatwootInstance.create({
        data: {
          tenantId: t.id,
          deploymentId: dep.id,
          accountId: 1,
          serverKey: `https://chat.${slug}-${process.pid}.example.com`,
          accountName: slug,
        },
      });
      const agent = await suDb.agent.create({
        data: { tenantId: t.id, name: "Observador", systemPrompt: "x" },
      });
      const inbox = await suDb.inbox.create({
        data: {
          tenantId: t.id,
          chatwootInstanceId: inst.id,
          chatwootInboxId: 11,
          name: "SAC",
          agentId: agent.id,
        },
      });
      const silent = await suDb.inbox.create({
        data: {
          tenantId: t.id,
          chatwootInstanceId: inst.id,
          chatwootInboxId: 12,
          name: "Só gente",
        },
      });
      const key = await suDb.vaultEntry.create({
        data: { tenantId: t.id, name: "openai", secret: encryptJson("sk-x") },
      });
      const conv = await suDb.conversation.create({
        data: {
          tenantId: t.id,
          chatwootInstanceId: inst.id,
          chatwootConversationId: 501,
          inboxId: inbox.id,
          threadId: `occ-${slug}-${process.pid}`,
          status: "open",
        },
      });
      return {
        tenantId: t.id,
        agentId: agent.id,
        inboxId: inbox.id,
        silentInboxId: silent.id,
        keyRef: `vault:${key.id}`,
        conversationId: conv.id,
      };
    };
    const mine = await mk("occ");
    const theirs = await mk("occ-other");
    tenantId = mine.tenantId;
    agentId = mine.agentId;
    inboxId = mine.inboxId;
    silentInboxId = mine.silentInboxId;
    keyRef = mine.keyRef;
    conversationId = mine.conversationId;
    otherTenantId = theirs.tenantId;
    foreignInboxId = theirs.inboxId;
  });

  afterAll(async () => {
    await suDb.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  // The account's first monitor, which the paths that name none created on the first save.
  const firstKey = async () => ({
    tenantId,
    monitorId: (
      await suDb.occurrenceMonitor.findFirstOrThrow({ where: { tenantId } })
    ).id,
  });

  const pendingRounds = () =>
    suDb.schedulerJob.count({
      where: { tenantId, kind: "OCCURRENCE_ROUND", status: "PENDING" },
    });

  test("switching it on arms the round; switching it off removes it", async () => {
    expect((await getOccurrencesSettings(ctx(), appDb)).enabled).toBe(false);
    expect(await pendingRounds()).toBe(0);
    const on = await updateOccurrencesSettings(
      ctx(),
      {
        enabled: true,
        inboxIds: [String(inboxId)],
        model: reading(),
        fields: FIELDS,
        referenceField: "referencia",
        reasonField: "motivo",
        cadenceMinutes: 10,
      },
      appDb,
    );
    expect(on.enabled).toBe(true);
    expect(on.cadenceMinutes).toBe(10);
    expect(await pendingRounds()).toBe(1);
    await updateOccurrencesSettings(ctx(), { enabled: false }, appDb);
    expect(await pendingRounds()).toBe(0);
    // The fields stay: switching off is not forgetting the setup.
    expect((await getOccurrencesSettings(ctx(), appDb)).fields).toEqual(FIELDS);
  });

  test("recoverMedia saves on its own and changes nothing else in the block", async () => {
    const before = await getOccurrencesSettings(ctx(), appDb);
    expect(before.recoverMedia).toBe(false);
    const saved = await updateOccurrencesSettings(
      ctx(),
      { recoverMedia: true },
      appDb,
    );
    expect(saved).toEqual({ ...before, recoverMedia: true });
    expect((await getOccurrencesSettings(ctx(), appDb)).recoverMedia).toBe(
      true,
    );
  });

  test("the business context is stored and returned exactly as sent, its cap on the raw length", async () => {
    // At the cap, ending in a space, and with spaces before: nothing is trimmed.
    const text = `  ${"x".repeat(1_997)} `;
    expect(text.length).toBe(2_000);
    const saved = await updateOccurrencesSettings(
      ctx(),
      { businessContext: text },
      appDb,
    );
    expect(saved.businessContext).toBe(text);
    expect((await getOccurrencesSettings(ctx(), appDb)).businessContext).toBe(
      text,
    );
    // One over, counted with its spaces, is refused, and what was saved stays.
    await expect(
      updateOccurrencesSettings(ctx(), { businessContext: `${text} ` }, appDb),
    ).rejects.toThrow();
    expect((await getOccurrencesSettings(ctx(), appDb)).businessContext).toBe(
      text,
    );
  });

  test("an older save's reconcile never cancels the round a newer save armed", async () => {
    await updateOccurrencesSettings(ctx(), { enabled: false }, appDb);
    expect(await pendingRounds()).toBe(0);
    // The older save's reconcile has read the block (off) and is about to act on it.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let readIt: () => void = () => {};
    const read = new Promise<void>((r) => {
      readIt = r;
    });
    const { id: monitorId } = await suDb.occurrenceMonitor.findFirstOrThrow({
      where: { tenantId },
    });
    const older = syncMonitorRound(tenantId, monitorId, appDb, async () => {
      readIt();
      await held;
    });
    await read;
    // A newer save switches it on while the older one is still deciding.
    const newer = updateOccurrencesSettings(
      ctx(),
      {
        enabled: true,
        inboxIds: [String(inboxId)],
        model: reading(),
        fields: FIELDS,
        referenceField: "referencia",
        reasonField: "motivo",
      },
      appDb,
    );
    // The newer save is then either waiting for the reconcile lock, or (without it) has armed.
    await until(
      "the newer save to wait for the lock or arm",
      async () =>
        (
          await appDb.$queryRaw<{ n: bigint }[]>`
            SELECT count(*) AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
        )[0]?.n || (await pendingRounds()) === 1,
    );
    release();
    await Promise.all([older, newer]);
    expect(await pendingRounds()).toBe(1);
    await updateOccurrencesSettings(ctx(), { enabled: false }, appDb);
    expect(await pendingRounds()).toBe(0);
  });

  test("a pool of one connection still arms the round: the reconcile writes in its own transaction", async () => {
    const one = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.TEST_APP_DATABASE_URL,
        max: 1,
      }),
    });
    try {
      await updateOccurrencesSettings(
        ctx(),
        {
          enabled: true,
          inboxIds: [String(inboxId)],
          model: reading(),
          fields: FIELDS,
          referenceField: "referencia",
          reasonField: "motivo",
        },
        one,
      );
      expect(await pendingRounds()).toBe(1);
      await updateOccurrencesSettings(ctx(), { enabled: false }, one);
      expect(await pendingRounds()).toBe(0);
    } finally {
      await one.$disconnect();
    }
  }, 30_000);

  test("refuses a key the block does not have, and leaves the block as it was", async () => {
    const before = await getOccurrencesSettings(ctx(), appDb);
    await expect(
      updateOccurrencesSettings(
        ctx(),
        { cadenceMinutes: 30, digestHour: 9 } as never,
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(await getOccurrencesSettings(ctx(), appDb)).toEqual(before);
  });

  test("occurrences_set takes the fleet's tenant selector as transport, not as a setting", async () => {
    const principal: VerifiedToken = {
      userId: 1n,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
      clientId: "c",
      jti: "j",
    };
    const res = await occurrencesSet(
      principal,
      { cadenceMinutes: 30, tenant: "the-fleet-pick", dry_run: true },
      { base: appDb },
    );
    expect(res).toMatchObject({ ok: true });
  });

  test("saves an inbox no agent receives, which the sweep reads from Chatwoot", async () => {
    const before = (await getOccurrencesSettings(ctx(), appDb)).inboxIds;
    const res = await updateOccurrencesSettings(
      ctx(),
      { inboxIds: [String(silentInboxId)] },
      appDb,
    );
    expect(res.inboxIds).toEqual([String(silentInboxId)]);
    await updateOccurrencesSettings(ctx(), { inboxIds: before }, appDb);
  });

  test("refuses an inbox of another account, a credential that is not a key, and an incomplete block switched on", async () => {
    for (const patch of [
      {
        enabled: true,
        inboxIds: [String(foreignInboxId)],
        model: reading(),
      },
      {
        enabled: true,
        inboxIds: [String(inboxId)],
        model: reading(),
        reasonField: null,
      },
    ])
      await expect(
        updateOccurrencesSettings(ctx(), patch, appDb),
      ).rejects.toMatchObject({ statusCode: 422 });
    // A credential this account does not have is refused before anything is written.
    await expect(
      updateOccurrencesSettings(
        ctx(),
        {
          enabled: true,
          inboxIds: [String(inboxId)],
          model: { ...READING, credentialRef: "vault:999999999" },
        },
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    // An openai-compatible model with no endpoint of its own, on a credential with none either,
    // could never read; with its own endpoint it saves.
    const compatible = {
      provider: "openai-compatible" as const,
      model: "local-model",
      credentialRef: keyRef,
      baseURL: null,
    };
    await expect(
      updateOccurrencesSettings(ctx(), { model: compatible }, appDb),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect((await getOccurrencesSettings(ctx(), appDb)).enabled).toBe(false);
    expect(await pendingRounds()).toBe(0);
  });

  test("a credential carrying an endpoint its provider drops is refused on save and does not run", async () => {
    const proxy = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "proxy",
        secret: encryptJson("sk-proxy"),
        baseUrl: "https://proxy.example/v1",
      },
    });
    const step = {
      ...READING,
      credentialRef: `vault:${proxy.id}`,
      baseURL: null,
    };
    await expect(
      updateOccurrencesSettings(ctx(), { model: step }, appDb),
    ).rejects.toMatchObject({ statusCode: 422 });
    // A block saved before this check does not run either: openai would drop the endpoint.
    expect(await resolveMonitorModel(appDb, tenantId, step)).toEqual({
      ok: false,
      reason: "the credential carries an endpoint a openai model does not take",
    });
    // The same credential on a provider that dials it is fine.
    expect(
      (
        await resolveMonitorModel(appDb, tenantId, {
          ...step,
          provider: "openrouter",
        })
      ).ok,
    ).toBe(true);
  });

  test("the model's endpoint reaches the audit trail as its scheme and host only", async () => {
    await updateOccurrencesSettings(
      ctx(),
      {
        model: {
          provider: "openai-compatible",
          model: "local-model",
          credentialRef: null,
          baseURL: "https://user:s3cret@llm.example.com/v1/k-pathkey?key=q-k3y",
        },
      },
      appDb,
    );
    const row = await suDb.auditLog.findFirstOrThrow({
      where: { tenantId, action: "occurrence_monitor.updated" },
      orderBy: { id: "desc" },
    });
    const kept = JSON.stringify([row.before, row.after]);
    expect(kept).toContain("https://llm.example.com/");
    for (const secret of ["s3cret", "pathkey", "q-k3y", "user:"])
      expect(kept).not.toContain(secret);
    await updateOccurrencesSettings(ctx(), { model: null }, appDb);
  });

  test("the model's credential is stored as the account's `vault:<id>`, and a save that leaves the model out keeps it", async () => {
    const spelled = await updateOccurrencesSettings(
      ctx(),
      { model: { ...READING, credentialRef: ` ${keyRef} ` } },
      appDb,
    );
    expect(spelled.model?.credentialRef).toBe(keyRef);
    const other = await updateOccurrencesSettings(
      ctx(),
      { cadenceMinutes: 25 },
      appDb,
    );
    expect(other.model).toEqual({ ...READING, credentialRef: keyRef });
    await updateOccurrencesSettings(ctx(), { model: null }, appDb);
  });

  test("switched on without a reference, the monitor saves and arms its round", async () => {
    await updateOccurrencesSettings(
      ctx(),
      {
        enabled: true,
        inboxIds: [String(inboxId)],
        model: reading(),
        fields: [FIELDS[1] as OccurrenceField],
        referenceField: null,
        reasonField: "motivo",
      },
      appDb,
    );
    expect(await pendingRounds()).toBe(1);
    const saved = await getOccurrencesSettings(ctx(), appDb);
    expect(saved.referenceField).toBeNull();
    await updateOccurrencesSettings(
      ctx(),
      { enabled: false, fields: FIELDS },
      appDb,
    );
    expect(await pendingRounds()).toBe(0);
  });

  test("a new value moves last_read_at and keeps first_read_at", async () => {
    const later = new Date();
    const first = new Date(later.getTime() - 3_600_000);
    await upsertReadings(
      appDb,
      await firstKey(),
      conversationId,
      { motivo: "cobrança em dobro" },
      first,
    );
    await suDb.conversationReading.update({
      where: {
        monitorId_conversationId_field: {
          monitorId: (await firstKey()).monitorId,
          conversationId,
          field: "motivo",
        },
      },
      data: { firstReadAt: first },
    });
    await upsertReadings(
      appDb,
      await firstKey(),
      conversationId,
      { motivo: "cobrado duas vezes no cartão" },
      later,
    );
    const row = await suDb.conversationReading.findUnique({
      where: {
        monitorId_conversationId_field: {
          monitorId: (await firstKey()).monitorId,
          conversationId,
          field: "motivo",
        },
      },
    });
    expect(row?.value).toBe("cobrado duas vezes no cartão");
    expect(row?.firstReadAt.toISOString()).toBe(first.toISOString());
    expect(row?.lastReadAt.toISOString()).toBe(later.toISOString());
  });

  test("an inbox that lost its agent stays on the list, does not block the next save, and saves again once taken off", async () => {
    const lonely = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: (
          await suDb.conversation.findUniqueOrThrow({
            where: { id: conversationId },
          })
        ).chatwootInstanceId,
        chatwootInboxId: 13,
        name: "Perdeu o agente",
        agentId,
      },
    });
    await updateOccurrencesSettings(
      ctx(),
      {
        enabled: true,
        inboxIds: [String(inboxId), String(lonely.id)],
        model: reading(),
        fields: FIELDS,
        referenceField: "referencia",
        reasonField: "motivo",
      },
      appDb,
    );
    await suDb.inbox.update({
      where: { id: lonely.id },
      data: { agentId: null },
    });
    const saved = await updateOccurrencesSettings(
      ctx(),
      { cadenceMinutes: 20 },
      appDb,
    );
    expect(saved.inboxIds).toContain(String(lonely.id));
    // Taken off and put back, it saves too: the sweep reads it from Chatwoot.
    await updateOccurrencesSettings(
      ctx(),
      { inboxIds: [String(inboxId)] },
      appDb,
    );
    expect(
      (
        await updateOccurrencesSettings(
          ctx(),
          { inboxIds: [String(inboxId), String(lonely.id)] },
          appDb,
        )
      ).inboxIds,
    ).toContain(String(lonely.id));
    const off = await updateOccurrencesSettings(
      ctx(),
      { enabled: false, cadenceMinutes: 15 },
      appDb,
    );
    expect(off.enabled).toBe(false);
    expect(await pendingRounds()).toBe(0);
  });

  test("a block saved before the monitor named its inboxes and model reads as an off draft that keeps its fields", async () => {
    const legacy = {
      enabled: true,
      agentId: String(agentId),
      fields: FIELDS,
      referenceField: "referencia",
      reasonField: "motivo",
      assignmentModel: "gpt-mini",
    };
    const read = readOccurrencesConfig({ occurrences: legacy });
    expect(read.enabled).toBe(false);
    expect(read.fields).toEqual(FIELDS);
    expect(read.referenceField).toBe("referencia");
    expect(read.inboxIds).toEqual([]);
    // A block still under the names it had before the migration renamed them reads as an off draft
    // too, never as a monitor running on a field it cannot name.
    const unmigrated = readOccurrencesConfig({
      occurrences: {
        enabled: true,
        inboxIds: [String(inboxId)],
        fields: FIELDS,
        subjectField: "referencia",
        problemField: "motivo",
        models: { reading: READING },
      },
    });
    expect(unmigrated.enabled).toBe(false);
    expect(unmigrated.fields).toEqual(FIELDS);
  });

  test("readings and runs are invisible to another account", async () => {
    const seen = await runScopedOn(appDb, sysCtx(otherTenantId), (db) =>
      db.conversationReading.count(),
    );
    expect(seen).toBe(0);
  });

  test("every round leaves a row with what it read and how long it took", async () => {
    const cfg = readOccurrencesConfig({
      occurrences: {
        ...OCCURRENCES_DEFAULTS,
        inboxIds: [String(inboxId)],
        fields: FIELDS,
        referenceField: "referencia",
        reasonField: "motivo",
      },
    });
    // A reading written outside a round is not this round's: `readings` counts the conversations the
    // round's own reading step read, and here it read none.
    await upsertReadings(appDb, await firstKey(), conversationId, {
      referencia: "Loja Centro",
    });
    const summary = await runOccurrenceRound(await firstKey(), cfg, {
      base: appDb,
    });
    expect(summary.status).toBe("ok");
    expect(summary.readings).toBe(0);
    const runs = await listOccurrenceRuns(
      ctx(),
      (await firstKey()).monitorId,
      5,
      appDb,
    );
    expect(runs[0]).toMatchObject({ status: "ok", readings: 0, error: null });
    expect(runs[0]?.finishedAt).not.toBeNull();
    const theirs = await runScopedOn(appDb, sysCtx(otherTenantId), (db) =>
      db.occurrenceRun.count(),
    );
    expect(theirs).toBe(0);
  });
});
