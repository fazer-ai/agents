import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { processAlertBatch } from "@/modules/flowlog/alert-worker";
import {
  type AlertChannelDto,
  createAlertChannel,
  listAlertChannels,
  updateAlertChannel,
} from "@/modules/flowlog/channels";
import {
  createWebhookSubscription,
  listWebhookSubscriptions,
  updateWebhookSubscription,
} from "@/modules/webhooks/outbound/subscriptions";
import { codeOnly } from "@/tests/utils/source-text";
import { outboundUrl } from "../utils/outbound";

// A console form can only send back what the read gave it, so the read projection decides what a
// save is allowed to preserve (issue #435). The alert-channel editor PATCHes its WHOLE form on every
// save and the service reads a null `secretRef` as "clear it", so a field the read never returned is
// not merely uneditable: it is erased by the next save of an operator who opened the dialog to
// rename the channel.
//
// The tests drive the round trip a whole-body client performs — list, build the body from what was
// listed, PATCH — rather than asserting the DTO has a field, because the field is only worth having
// if it survives that trip. On the base the list has no `secretRef` to hand back and the channel
// comes out unsigned.
//
// The console itself now OMITS the key when the operator did not touch the picker, which is a second
// and stronger guarantee: it does not require the stored value to be re-writable, and before #126
// this column accepted any string at all, so plenty of stored values are not. The last test here is
// that fact, measured. The whole-body shape stays covered because REST callers still use it.

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
  userId: 9435n,
  role: "TENANT_ADMIN",
});

// A whole-body PATCH built from what the read returned — the shape any REST caller may send, and the
// one the console sent until this round. Spelled once so the tests below cannot drift apart from each
// other in the file that is measuring them.
function fullBodySave(listed: AlertChannelDto, over: object = {}) {
  return {
    name: listed.name,
    type: listed.type as "discord" | "webhook",
    minLevel: listed.minLevel as "warn" | "error",
    stages: listed.stages,
    secretRef: listed.secretRef ?? null,
    enabled: listed.enabled,
    ...over,
  };
}

describe.skipIf(!dbUp)(
  "an alert channel's signing secret across a save",
  () => {
    beforeAll(async () => {
      if (!su) return;
      const t = await su.tenant.create({
        data: { name: "ACS", slug: `acs-${process.pid}` },
      });
      tenantId = t.id;
      const sec = await su.vaultEntry.create({
        data: {
          tenantId,
          name: "alert-hmac",
          kind: "generic",
          secret: encryptJson("signing-secret"),
        },
        select: { id: true },
      });
      secretId = sec.id;
    });

    afterAll(async () => {
      if (su && tenantId) {
        for (const table of [
          "audit_logs",
          "alert_channels",
          "webhook_subscriptions",
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
      await su?.$disconnect();
      await app?.$disconnect();
    });

    async function seedSigned(name: string) {
      return await createAlertChannel(
        ctx(),
        {
          name,
          type: "webhook",
          url: outboundUrl("/hook"),
          secretRef: `vault:${secretId}`,
        },
        appDb,
      );
    }

    const clearChannelAudit = async () =>
      await (su as PrismaClient).$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
      );

    const listed = async (id: bigint) =>
      (await listAlertChannels(ctx(), appDb)).find((c) => c.id === String(id));

    test("the read hands back the ref it stored, not only that one exists", async () => {
      const created = await seedSigned("read");
      const row = await listed(BigInt(created.id));
      expect(row?.secretRef).toBe(`vault:${secretId}`);
      // `hasSecret` stays: it is the published v1 shape and the MCP tool's own description names it.
      // Both come off the same column, so they cannot disagree — this asserts that, rather than
      // trusting it.
      expect(row?.hasSecret).toBe(row?.secretRef !== null);
    });

    test("renaming from the console leaves the channel signed", async () => {
      const created = await seedSigned("rename");
      const before = await listed(BigInt(created.id));
      if (!before) throw new Error("seeded channel not listed");

      await updateAlertChannel(
        ctx(),
        BigInt(created.id),
        fullBodySave(before, { name: "renamed" }),
        appDb,
      );

      const after = await listed(BigInt(created.id));
      expect(after?.name).toBe("renamed");
      // The issue's effect, on the server side of it: the endpoint keeps receiving signed deliveries.
      expect(after?.secretRef).toBe(`vault:${secretId}`);
      expect(after?.hasSecret).toBe(true);
    });

    test("an operator who clears the picker still unsigns the channel", async () => {
      const created = await seedSigned("clear");
      const before = await listed(BigInt(created.id));
      if (!before) throw new Error("seeded channel not listed");

      // Blank means "no secret" because the field arrived filled — which is the same sentence the
      // webhooks page already prints under its own picker. Handing the ref back must not cost the
      // operator the only way to take it away.
      await updateAlertChannel(
        ctx(),
        BigInt(created.id),
        fullBodySave(before, { secretRef: null }),
        appDb,
      );

      const after = await listed(BigInt(created.id));
      expect(after?.secretRef).toBe(null);
      expect(after?.hasSecret).toBe(false);
    });

    test("a channel that never had a secret round-trips as unsigned", async () => {
      const created = await createAlertChannel(
        ctx(),
        { name: "plain", type: "webhook", url: outboundUrl("/plain") },
        appDb,
      );
      const before = await listed(BigInt(created.id));
      if (!before) throw new Error("seeded channel not listed");
      expect(before.secretRef).toBe(null);

      await updateAlertChannel(
        ctx(),
        BigInt(created.id),
        fullBodySave(before, { name: "plain renamed" }),
        appDb,
      );
      const after = await listed(BigInt(created.id));
      expect(after?.name).toBe("plain renamed");
      expect(after?.secretRef).toBe(null);
    });

    test("the receiver keeps getting a signed delivery after the save", async () => {
      // The issue's effect where the operator's endpoint actually sees it. Everything above reads our
      // own column back; this reads the request that leaves the installation, which is the only place
      // "the channel is unsigned" is a fact about the outside world. A receiver that verifies starts
      // rejecting alerts, and a receiver that does not keeps accepting them from anyone with the URL.
      const created = await seedSigned("dispatch");
      const before = await listed(BigInt(created.id));
      if (!before) throw new Error("seeded channel not listed");
      await updateAlertChannel(
        ctx(),
        BigInt(created.id),
        fullBodySave(before, { name: "dispatch renamed" }),
        appDb,
      );

      const [stamp] = await (su as PrismaClient).$queryRaw<{ now: Date }[]>`
      SELECT now() AS now`;
      await (su as PrismaClient).alertDelivery.create({
        data: {
          tenantId,
          channelId: BigInt(created.id),
          stage: "generate",
          level: "error",
          summary: "boom",
          createdAt: (stamp as { now: Date }).now,
        },
      });

      const sent: Record<string, string>[] = [];
      await processAlertBatch({
        base: appDb,
        tenantId,
        coalesceWindowMs: 0,
        fetchImpl: (async (_u: unknown, init?: RequestInit) => {
          sent.push({ ...((init?.headers ?? {}) as Record<string, string>) });
          return new Response(null, { status: 204 });
        }) as unknown as typeof fetch,
        now: () => Date.now(),
      });

      expect(sent.length).toBe(1);
      // Both spellings go out on every delivery during the compatibility window (docs/api-and-fleet.md),
      // and the legacy one is what a receiver configured before the brand rename verifies — so the
      // assertion names the pair rather than the survivor.
      expect(
        (sent[0]?.["x-fazerai-signature"] ?? "").startsWith("sha256="),
      ).toBe(true);
      expect(
        (sent[0]?.["x-secretaria-signature"] ?? "").startsWith("sha256="),
      ).toBe(true);
    });

    test("a legacy ref that still names an entry comes back canonical", async () => {
      // `alert_channels.secret_ref` was guarded on both writers in one commit (#126); before it the
      // schema was `z.string().min(1).max(128)` and the value went in verbatim, so rows hold `vault: 7`
      // and `vault:0007`. Every resolver in the system reads those (`readVaultRefId` parses the id with
      // BigInt); `requireVaultRef` refuses them, because a column takes one spelling. The read therefore
      // hands back the spelling that can go back IN, not the one that is stored.
      const created = await seedSigned("legacy");
      await (su as PrismaClient).$executeRawUnsafe(
        `UPDATE alert_channels SET secret_ref = 'vault: ${secretId}' WHERE id = ${created.id}`,
      );
      const before = await listed(BigInt(created.id));
      expect(before?.secretRef).toBe(`vault:${secretId}`);

      await updateAlertChannel(
        ctx(),
        BigInt(created.id),
        fullBodySave(before as AlertChannelDto, { name: "legacy renamed" }),
        appDb,
      );
      const after = await listed(BigInt(created.id));
      expect(after?.name).toBe("legacy renamed");
      expect(after?.secretRef).toBe(`vault:${secretId}`);
    });

    test("a legacy value that names nothing is never handed out, and omitting is what saves it", async () => {
      // The other half, and the one the console's omission exists for. That same unguarded window
      // accepted a BARE NAME, or any text at all — an API caller who read the field name as "the
      // secret" and typed one in. Such a value cannot be projected: an audit row and a REST read are
      // seen by every tenant admin, and `alert_channel_list` by any principal with `mcp:read`.
      const created = await seedSigned("opaque");
      await (su as PrismaClient).$executeRawUnsafe(
        `UPDATE alert_channels SET secret_ref = 'alert-hmac' WHERE id = ${created.id}`,
      );
      const before = await listed(BigInt(created.id));
      expect(before?.secretRef).toBe(null);
      // …and the channel is still reported as configured, which it is. The two fields answer different
      // questions and this is the row where that stops being a redundancy.
      expect(before?.hasSecret).toBe(true);

      // A whole-body client now echoes the projected null, which CLEARS it. That is the shape the
      // console used to send and the reason it now omits the key instead.
      await updateAlertChannel(
        ctx(),
        BigInt(created.id),
        fullBodySave(before as AlertChannelDto, { name: "echoed" }),
        appDb,
      );
      expect((await listed(BigInt(created.id)))?.hasSecret).toBe(false);

      // The console's own shape, on a fresh row: the key is absent, so nothing can be lost.
      const kept = await seedSigned("opaque kept");
      await (su as PrismaClient).$executeRawUnsafe(
        `UPDATE alert_channels SET secret_ref = 'alert-hmac' WHERE id = ${kept.id}`,
      );
      const listedKept = await listed(BigInt(kept.id));
      const { secretRef: _omitted, ...withoutSecret } = fullBodySave(
        listedKept as AlertChannelDto,
        { name: "kept renamed" },
      );
      await updateAlertChannel(ctx(), BigInt(kept.id), withoutSecret, appDb);
      const after = await listed(BigInt(kept.id));
      expect(after?.name).toBe("kept renamed");
      expect(after?.hasSecret).toBe(true);
    });

    test("no reader of a channel ever emits the raw column", async () => {
      // The promise `docs/logs.md` and the MCP tool description both make, checked against every
      // projection this service has rather than against the one the finding named: the DTO, and the
      // audit row that is append-only and cannot be corrected later.
      const created = await seedSigned("never-emitted");
      const planted = "s3cr3t-hmac-value";
      await (su as PrismaClient).$executeRawUnsafe(
        `UPDATE alert_channels SET secret_ref = '${planted}' WHERE id = ${created.id}`,
      );
      await clearChannelAudit();
      await updateAlertChannel(
        ctx(),
        BigInt(created.id),
        { name: "renamed" },
        appDb,
      );

      const dto = JSON.stringify(await listAlertChannels(ctx(), appDb));
      expect(dto.includes(planted)).toBe(false);
      const trail = JSON.stringify(
        await (su as PrismaClient).auditLog.findMany({ where: { tenantId } }),
        (_k, v) => (typeof v === "bigint" ? String(v) : v),
      );
      expect(trail.includes(planted)).toBe(false);
      // …and the row still says the secret was there, so the redaction did not buy silence.
      expect(trail.includes('"secretRefOpaque":true')).toBe(true);
    });

    test("clearing a secret the row cannot name still writes a row", async () => {
      // What the marker is FOR. Redacted, an opaque legacy value reads as null on both sides of a
      // clear, `projectionMoved` sees nothing, and the one save that removed a signing secret leaves
      // no trace — the same silence `hasSecret` had before #397 put the ref on the projection.
      const created = await seedSigned("opaque cleared");
      await (su as PrismaClient).$executeRawUnsafe(
        `UPDATE alert_channels SET secret_ref = 'alert-hmac' WHERE id = ${created.id}`,
      );
      await clearChannelAudit();
      await updateAlertChannel(
        ctx(),
        BigInt(created.id),
        { secretRef: null },
        appDb,
      );
      const rows = await (su as PrismaClient).auditLog.findMany({
        where: { tenantId, action: "alert_channel.update" },
      });
      expect(rows.length).toBe(1);
      expect(rows[0]?.before).toMatchObject({
        secretRef: null,
        secretRefOpaque: true,
      });
      expect(rows[0]?.after).toMatchObject({
        secretRef: null,
        secretRefOpaque: false,
      });
    });

    test("the sibling family answers the same round trip the same way", async () => {
      // Not redundant with the webhooks page's own coverage: this is the comparison the fix is
      // ADOPTING, driven through the sibling service so it is the behaviour being cited and not a
      // sentence about it.
      const created = await createWebhookSubscription(
        ctx(),
        {
          url: outboundUrl("/sub"),
          events: ["conversation.created"],
          secretRef: `vault:${secretId}`,
        },
        appDb,
      );
      const before = (await listWebhookSubscriptions(ctx(), appDb)).find(
        (s) => s.id === created.id,
      );
      if (!before) throw new Error("seeded subscription not listed");
      await updateWebhookSubscription(
        ctx(),
        BigInt(created.id),
        {
          url: before.url,
          events: before.events,
          secretRef: before.secretRef ?? null,
          enabled: before.enabled,
        },
        appDb,
      );
      const after = (await listWebhookSubscriptions(ctx(), appDb)).find(
        (s) => s.id === created.id,
      );
      expect(after?.secretRef).toBe(`vault:${secretId}`);

      // …and the same column, with the same history, on the family this fix cites as the norm. Both
      // `secretRef` columns were guarded on all their writers in the SAME commit and both projections
      // predate it, so citing the sibling as correct while it echoed the raw column would have made
      // the citation false.
      const planted = "s3cr3t-sub-value";
      await (su as PrismaClient).$executeRawUnsafe(
        `UPDATE webhook_subscriptions SET secret_ref = '${planted}' WHERE id = ${created.id}`,
      );
      const opaque = (await listWebhookSubscriptions(ctx(), appDb)).find(
        (x) => x.id === created.id,
      );
      expect(opaque?.secretRef).toBe(null);
      expect(JSON.stringify(opaque).includes(planted)).toBe(false);
    });
  },
);

// ── the invariant, one layer above the site the issue measured ──
//
// A write field declared `.nullish()` is THREE-valued — absent leaves it, null clears it, a value
// sets it — and only two of those are reachable from a form that sends its whole body. "Leave it" is
// spelled by sending back what the read returned, so a three-valued field the read projection hides
// makes the clear the only thing the form can express, on every save, whether or not the operator
// meant it.
//
// The rule is a PURE function over one file's text so it can be driven with source that is not in
// the tree. Written only as a sweep it passed every mutation: deleting the projection check, dropping
// either guard and reading raw text all left the tree green, because a fence over a clean tree
// reports nothing either way. The sweep below is the ledger; the tests under it are the proof that
// the ledger is looking at anything.
interface ThreeValued {
  // Every three-valued field this file declares…
  declared: string[];
  // …and the ones its own DTO does not hand back.
  hidden: string[];
}

// An entity service is a module with both a Prisma `SELECT` and a `toDto`. That excludes an inbound
// PARSER like `integrations/mappers.ts`, which declares five `.nullish()` fields because the vendor
// sends null and not because anything round-trips through a form.
function threeValuedFields(source: string): ThreeValued {
  // Through the scanner, so a comment NAMING one of these shapes is not counted as one.
  const src = codeOnly(source);
  // Fresh literals rather than one shared `none`: the caller gets arrays it could sort in place.
  const none = (): ThreeValued => ({ declared: [], hidden: [] });
  if (!src.includes("const SELECT = {")) return none();
  if (!src.includes("function toDto(")) return none();

  // `.nullish()` binds to the field immediately before it, however many lines of chained validators
  // sit in between (`appointment` on tool definitions spans nine).
  const declared = new Set<string>();
  for (const chunk of src.split(".nullish()").slice(0, -1)) {
    const name = [...chunk.matchAll(/(\w+):\s*z\s*\./g)].at(-1)?.[1];
    if (name) declared.add(name);
  }
  const dto = src.match(/export interface \w+Dto \{([\s\S]*?)\n\}/)?.[1];
  return {
    declared: [...declared],
    hidden: [...declared].filter(
      (f) => !dto || !new RegExp(`\\b${f}\\??:`).test(dto),
    ),
  };
}

// A service reduced to the four things the rule reads. Written out rather than sliced from a real
// file so the negative cases below are reachable at all: no file in the tree has a hidden field any
// more, which is exactly why the rule needs source that is not in the tree.
const service = (
  dtoBody: string,
  schema = "secretRef: z.string().nullish(),",
) =>
  `
export interface ThingDto {
  id: string;
${dtoBody}
}
const SELECT = { id: true, secretRef: true } as const;
function toDto(row: Row): ThingDto {
  return { id: row.id };
}
const updateSchema = z.object({ name: z.string(), ${schema} }).strict();
`;

describe("three-valued write fields", () => {
  test("a field the DTO hides is reported", () => {
    const found = threeValuedFields(service("  hasSecret: boolean;"));
    expect(found.declared.join(",")).toBe("secretRef");
    expect(found.hidden.join(",")).toBe("secretRef");
  });

  test("the same field projected is not", () => {
    const found = threeValuedFields(service("  secretRef: string | null;"));
    expect(found.declared.join(",")).toBe("secretRef");
    expect(found.hidden.join(",")).toBe("");
  });

  test("a module with no read projection is not an entity service", () => {
    const parser = `const SELECT = { id: true } as const;
const inbound = z.object({ status: z.string().nullish() });`;
    expect(threeValuedFields(parser).declared.join(",")).toBe("");
  });

  test("nor is one with no SELECT", () => {
    const mapper = `function toDto(r: Row) { return { id: r.id }; }
const inbound = z.object({ status: z.string().nullish() });`;
    expect(threeValuedFields(mapper).declared.join(",")).toBe("");
  });

  test("a comment naming the shape is prose, not a declaration", () => {
    // The #424 failure from the other side: a NOTE warning against the shape read as the shape.
    const commented = service(
      "  secretRef: string | null;",
      "// NOTE: never add another `foo: z.string().nullish()` here\n  bar: z.string(),",
    );
    expect(threeValuedFields(commented).declared.join(",")).toBe("");
  });

  test("the last field before the chain is the one it binds to", () => {
    // `appointment` on tool definitions puts nine lines of validators between the name and the call;
    // reading the FIRST `x: z.` of the chunk would report `name` instead.
    const chained = service(
      "  appointment: Record<string, unknown> | null;",
      `appointment: z
    .record(z.string(), z.unknown())
    .nullish()
    .refine((v) => v == null),`,
    );
    expect(threeValuedFields(chained).declared.join(",")).toBe("appointment");
  });

  test("every one of them in src/modules is readable back from its own DTO", async () => {
    const { Glob } = await import("bun");
    const missing: string[] = [];
    const seen: string[] = [];

    for await (const rel of new Glob("**/*.ts").scan("src/modules")) {
      const path = `src/modules/${rel}`;
      const found = threeValuedFields(await Bun.file(path).text());
      for (const field of found.declared) seen.push(`${path}:${field}`);
      for (const field of found.hidden) missing.push(`${path}:${field}`);
    }

    // Anti-vacuity: a sweep that reaches nothing passes for the wrong reason, and the file this
    // round is about is the one it must be able to see. Four services declare such a field today and
    // a fifth is measured on arrival without touching this file.
    expect(seen).toContain("src/modules/flowlog/channels.ts:secretRef");
    expect(missing.sort().join("\n")).toBe("");
  });
});
