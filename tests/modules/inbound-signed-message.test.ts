import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { integrationsController } from "@/api/v1/integrations.controller";
import type { TenantContext } from "@/lib/tenancy";
import { ensureConversationRef } from "@/modules/integrations/conversation-ref";
import {
  assertIntegrationWritable,
  createIntegrationInstance,
  updateIntegrationInstance,
} from "@/modules/integrations/service";
import {
  type InboundSecretResolution,
  verifyInboundAuth,
} from "@/modules/webhooks/inbound/auth";
import * as inbound from "@/modules/webhooks/inbound/service";
import { receiveInbound } from "@/modules/webhooks/inbound/service";
import { signatureCoversBody } from "@/modules/webhooks/inbound/signed-message";
import { dbProbeFailed } from "@/tests/db-gate";

// Gateways that sign a manifest instead of the body. The reference signers below follow the
// providers' own documentation, not this codebase: Mercado Pago signs
// `id:<data.id from the query>;request-id:<x-request-id>;ts:<ts>;` (a segment whose value is absent
// is left out) and sends `x-signature: ts=<ts>,v1=<hex>`; Stripe signs `<t>.<raw body>` and sends
// `Stripe-Signature: t=<t>,v1=<hex>[,v1=<hex>]`.

const SECRET = "mp-app-secret";
const hmac = (secret: string, msg: string) =>
  createHmac("sha256", secret).update(msg).digest("hex");

function mpManifest(p: { dataId?: string; requestId?: string; ts: string }) {
  let m = "";
  if (p.dataId !== undefined) m += `id:${p.dataId.toLowerCase()};`;
  if (p.requestId !== undefined) m += `request-id:${p.requestId};`;
  return `${m}ts:${p.ts};`;
}

const MP_MESSAGE =
  "[[id:{{query.data.id|lower}};]][[request-id:{{header.x-request-id}};]]ts:{{sig.ts}};";
const MP_CONFIG = {
  signatureHeader: "x-signature",
  signature: {
    format: "parts",
    signaturePart: "v1",
    timestampPart: "ts",
    message: MP_MESSAGE,
  },
};

const filled = (value: unknown): InboundSecretResolution => ({
  state: "filled",
  value,
});
const lookup =
  (h: Record<string, string>) =>
  (n: string): string | null =>
    h[n.toLowerCase()] ?? null;

describe("a signed message other than the body", () => {
  const TS = "1704908010";
  const BODY = '{"type":"payment","data":{"id":"999"}}';
  const mpHeaders = (sig: string, extra: Record<string, string> = {}) =>
    lookup({ "x-signature": `ts=${TS},v1=${sig}`, ...extra });
  const verify = (p: {
    config: Record<string, unknown>;
    headers: (n: string) => string | null;
    query?: Record<string, string>;
    secret?: string;
    body?: string;
    now?: number;
  }) =>
    verifyInboundAuth({
      strategy: "HMAC_SHA256",
      secret: filled(p.secret ?? SECRET),
      rawBody: p.body ?? BODY,
      getHeader: p.headers,
      getQuery: lookup(p.query ?? {}),
      config: p.config,
      now: p.now,
    });

  test("a Mercado Pago notification signed as the docs describe is accepted", () => {
    const sig = hmac(
      SECRET,
      mpManifest({ dataId: "999", requestId: "req-1", ts: TS }),
    );
    expect(
      verify({
        config: MP_CONFIG,
        headers: mpHeaders(sig, { "x-request-id": "req-1" }),
        query: { "data.id": "999", type: "payment" },
      }),
    ).toEqual({ ok: true });
  });

  test("a wrong secret and a data.id swapped in the query are both a mismatch", () => {
    const sig = hmac(
      SECRET,
      mpManifest({ dataId: "999", requestId: "req-1", ts: TS }),
    );
    expect(
      verify({
        config: MP_CONFIG,
        headers: mpHeaders(sig, { "x-request-id": "req-1" }),
        query: { "data.id": "999" },
        secret: "another-secret",
      }),
    ).toEqual({ ok: false, reason: "credential_mismatch" });
    expect(
      verify({
        config: MP_CONFIG,
        headers: mpHeaders(sig, { "x-request-id": "req-1" }),
        query: { "data.id": "1000" },
      }),
    ).toEqual({ ok: false, reason: "credential_mismatch" });
  });

  test("an absent optional value leaves its segment out, and an uppercase id is lowered", () => {
    const sig = hmac(SECRET, mpManifest({ dataId: "ABC123", ts: TS }));
    expect(
      verify({
        config: MP_CONFIG,
        headers: mpHeaders(sig),
        query: { "data.id": "ABC123" },
      }),
    ).toEqual({ ok: true });
  });

  test("a value the message requires outside a [[group]] is refused when absent", () => {
    const config = {
      ...MP_CONFIG,
      signature: {
        ...MP_CONFIG.signature,
        message: "id:{{query.data.id}};ts:{{sig.ts}};",
      },
    };
    const sig = hmac(SECRET, `id:;ts:${TS};`);
    expect(verify({ config, headers: mpHeaders(sig) })).toEqual({
      ok: false,
      reason: "signed_value_missing",
    });
  });

  test("a header with no signature part is refused before any comparison", () => {
    expect(
      verify({
        config: MP_CONFIG,
        headers: lookup({ "x-signature": `ts=${TS}` }),
        query: { "data.id": "999" },
      }),
    ).toEqual({ ok: false, reason: "signature_part_missing" });
  });

  test("with a maximum age, a timestamp too far either way is refused and a fresh one in milliseconds passes", () => {
    const withAge = {
      ...MP_CONFIG,
      signature: { ...MP_CONFIG.signature, maxAgeSeconds: 300 },
    };
    const sig = hmac(SECRET, mpManifest({ dataId: "999", ts: TS }));
    const tsMs = Number(TS) * 1000;
    expect(
      verify({
        config: withAge,
        headers: mpHeaders(sig),
        query: { "data.id": "999" },
        now: tsMs + 301_000,
      }),
    ).toEqual({ ok: false, reason: "timestamp_stale" });
    expect(
      verify({
        config: withAge,
        headers: mpHeaders(sig),
        query: { "data.id": "999" },
        now: tsMs + 299_000,
      }),
    ).toEqual({ ok: true });
    expect(
      verify({
        config: withAge,
        headers: mpHeaders(sig),
        query: { "data.id": "999" },
        now: tsMs - 301_000,
      }),
    ).toEqual({ ok: false, reason: "timestamp_stale" });

    const msTs = "1742505638683";
    const msSig = hmac(SECRET, mpManifest({ dataId: "999", ts: msTs }));
    expect(
      verify({
        config: withAge,
        headers: lookup({ "x-signature": `ts=${msTs},v1=${msSig}` }),
        query: { "data.id": "999" },
        now: Number(msTs) + 10_000,
      }),
    ).toEqual({ ok: true });
    expect(
      verify({
        config: withAge,
        headers: lookup({ "x-signature": `ts=yesterday,v1=${msSig}` }),
        query: { "data.id": "999" },
        now: Number(msTs),
      }),
    ).toEqual({ ok: false, reason: "timestamp_unusable" });
  });

  test("a Stripe-style signature over `<t>.<body>` passes on any of its v1 values", () => {
    const t = "1700000000";
    const good = hmac(SECRET, `${t}.${BODY}`);
    const stale = hmac("rotated-out", `${t}.${BODY}`);
    expect(
      verify({
        config: {
          signatureHeader: "stripe-signature",
          signature: {
            format: "parts",
            signaturePart: "v1",
            timestampPart: "t",
            message: "{{sig.t}}.{{body}}",
          },
        },
        headers: lookup({
          "stripe-signature": `t=${t},v1=${stale},v1=${good},v0=xyz`,
        }),
      }),
    ).toEqual({ ok: true });
  });

  test("a hex signature over a message other than the body", () => {
    const sig = hmac(SECRET, `abc|${BODY}`);
    expect(
      verify({
        config: { signature: { message: "{{query.k}}|{{body}}" } },
        headers: lookup({ "x-webhook-signature": `sha256=${sig}` }),
        query: { k: "abc" },
      }),
    ).toEqual({ ok: true });
  });

  test("a value that contains the text after it is refused, so a boundary cannot move", () => {
    const config = {
      signatureHeader: "x-sig",
      signature: { message: "{{header.x-t}}.{{body}}" },
    };
    // "1.2" + "." + "3" and "1" + "." + "2.3" are the same bytes under the same signature.
    const sig = hmac(SECRET, "1.2.3");
    const as = (t: string, body: string) =>
      verify({ config, body, headers: lookup({ "x-sig": sig, "x-t": t }) });
    expect(as("1", "2.3")).toEqual({ ok: true });
    expect(as("1.2", "3")).toEqual({
      ok: false,
      reason: "signed_value_ambiguous",
    });
    // An overlap is caught too: "xa" before "aa" reads as "x" before "aa" + "a".
    const overlap = {
      signatureHeader: "x-sig",
      signature: { message: "{{header.x-t}}aa{{body}}" },
    };
    expect(
      verify({
        config: overlap,
        body: "B",
        headers: lookup({ "x-sig": hmac(SECRET, "xaaaB"), "x-t": "xa" }),
      }),
    ).toEqual({ ok: false, reason: "signed_value_ambiguous" });
  });

  test("a stored signature config the writer would refuse fails closed, never throws", () => {
    for (const signature of [
      "{{body}}",
      { message: "{{nope}}" },
      { format: "parts", message: "{{body}}" },
      { message: "{{header.bad name}}" },
    ]) {
      expect(
        verify({
          config: { signature },
          headers: lookup({ "x-webhook-signature": hmac(SECRET, BODY) }),
        }),
      ).toEqual({ ok: false, reason: "signature_config_unusable" });
    }
  });
});

describe("the signature config is refused at the write, naming the field", () => {
  const refusal = (signature: unknown) => {
    try {
      assertIntegrationWritable("GENERIC", {
        config: { signature },
        inboundAuthStrategy: "HMAC_SHA256",
      });
      return null;
    } catch (err) {
      return (err as { field?: string; statusCode?: number }).field ?? "?";
    }
  };

  test("an accepted Mercado Pago config", () => {
    expect(refusal(MP_CONFIG.signature)).toBeNull();
  });

  test("a toolpack does not take a signed message, whose provider signs as its catalog entry knows", () => {
    expect(() =>
      assertIntegrationWritable("ASAAS", {
        config: { signature: { message: "{{body}}" } },
        inboundAuthStrategy: "HMAC_SHA256",
      }),
    ).toThrow(expect.objectContaining({ field: "config.signature" }));
  });

  test.each([
    ["an unknown placeholder", { message: "{{cookie.x}}" }, "message"],
    ["an unusable header name", { message: "{{header.a b}}" }, "message"],
    ["an unclosed optional group", { message: "[[id:{{body}}" }, "message"],
    ["a nested optional group", { message: "[[a[[b]]" }, "message"],
    ["an unknown modifier", { message: "{{body|upper}}" }, "message"],
    [
      "a signature part read under the hex format",
      { message: "{{sig.ts}}" },
      "message",
    ],
    ["parts without a signature part", { format: "parts" }, "signaturePart"],
    ["an unknown format", { format: "base64" }, "format"],
    [
      "a maximum age with no timestamp to measure",
      { format: "parts", signaturePart: "v1", maxAgeSeconds: 60 },
      "maxAgeSeconds",
    ],
    [
      "a maximum age over a timestamp the message does not sign",
      {
        format: "parts",
        signaturePart: "v1",
        timestampPart: "t",
        maxAgeSeconds: 60,
      },
      "maxAgeSeconds",
    ],
    [
      "a maximum age whose message signs another part, not the timestamp",
      {
        format: "parts",
        signaturePart: "v1",
        timestampPart: "t",
        message: "{{sig.nonce}}.{{body}}",
        maxAgeSeconds: 60,
      },
      "maxAgeSeconds",
    ],
    [
      "a maximum age over a timestamp in a [[group]] another value can drop",
      {
        format: "parts",
        signaturePart: "v1",
        timestampPart: "t",
        message: "[[{{sig.t}}.{{header.x-id}}.]]{{body}}",
        maxAgeSeconds: 60,
      },
      "maxAgeSeconds",
    ],
    [
      "a maximum age over a timestamp between two values, whose digits can move into them",
      {
        format: "parts",
        signaturePart: "v1",
        timestampPart: "t",
        message: "{{header.a}}{{sig.t}}{{header.b}}",
        maxAgeSeconds: 60,
      },
      "maxAgeSeconds",
    ],
    [
      "a maximum age over a timestamp with values on both sides, even behind fixed text",
      {
        format: "parts",
        signaturePart: "v1",
        timestampPart: "t",
        message: "{{header.a}}.{{sig.t}}.{{body}}",
        maxAgeSeconds: 60,
      },
      "maxAgeSeconds",
    ],
    [
      "a maximum age over a timestamp whose fixed neighbour ends in a digit",
      {
        format: "parts",
        signaturePart: "v1",
        timestampPart: "t",
        message: "{{body}}v1{{sig.t}}",
        maxAgeSeconds: 60,
      },
      "maxAgeSeconds",
    ],
    [
      "a maximum age over a timestamp signed twice",
      {
        format: "parts",
        signaturePart: "v1",
        timestampPart: "t",
        message: "{{sig.t}}.{{body}}.{{sig.t}}",
        maxAgeSeconds: 60,
      },
      "maxAgeSeconds",
    ],
    [
      "a maximum age that is not a positive whole number",
      {
        format: "parts",
        signaturePart: "v1",
        timestampPart: "ts",
        maxAgeSeconds: 0,
      },
      "maxAgeSeconds",
    ],
    ["not an object", "{{body}}", ""],
  ])("%s", (_, signature, field) => {
    expect(refusal(signature)).toBe(
      field ? `config.signature.${field}` : "config.signature",
    );
  });

  test.each([
    ["at the start, before fixed text", "{{sig.t}}.{{body}}"],
    ["at the end, after fixed text", "{{body}};ts:{{sig.t}};"],
  ])("a maximum age over a timestamp pinned %s is accepted", (_, message) => {
    expect(
      refusal({
        format: "parts",
        signaturePart: "v1",
        timestampPart: "t",
        message,
        maxAgeSeconds: 60,
      }),
    ).toBeNull();
  });
});

describe("which messages authenticate the body byte for byte", () => {
  test.each([
    ["no signature config (the body itself)", undefined, true],
    [
      "{{body}} after a signed timestamp",
      {
        format: "parts",
        signaturePart: "v1",
        timestampPart: "t",
        message: "{{sig.t}}.{{body}}",
      },
      true,
    ],
    ["{{body}} in a [[group]], even alone", { message: "[[{{body}}]]" }, false],
    ["a manifest without {{body}}", { message: "id:{{query.id}};" }, false],
    [
      "{{body}} in a [[group]] an absent header drops",
      { message: "prefix[[{{body}}{{header.x-id}}]]" },
      false,
    ],
    [
      "{{body|lower}}, a projection of the body",
      { message: "{{body|lower}}" },
      false,
    ],
    ["a config the writer would refuse", { message: "{{nope}}" }, false],
    [
      "a header right before {{body}}, with no text between them",
      { message: "{{header.x-t}}{{body}}" },
      false,
    ],
    [
      "{{body}} framed by two headers",
      { message: "{{header.x-prefix}}{{body}}{{header.x-suffix}}" },
      false,
    ],
    [
      "{{body}} before the timestamp instead of after it",
      {
        format: "parts",
        signaturePart: "v1",
        timestampPart: "t",
        message: "{{body}}.{{sig.t}}",
      },
      false,
    ],
    [
      "a droppable [[group]] before {{body}}",
      { message: "[[{{header.x-a}};]]{{header.x-b}};{{body}}" },
      false,
    ],
  ])("%s", (_, signature, covered) => {
    expect(signatureCoversBody(signature)).toBe(covered);
  });
});

// ── through the route, against the database ──
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

describe.skipIf(!dbUp)("a manifest-signed notification end to end", () => {
  let tenantId = 0n;
  let instanceId = 0n;
  let routeToken = "";
  const ctx = (): TenantContext => ({
    tenantId,
    userId: null,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SIGMSG", slug: `sigmsg-${process.pid}` },
    });
    tenantId = t.id;
    const v = await suDb.vaultEntry.create({
      data: { tenantId, name: "mp-secret", secret: encryptJson(SECRET) },
      select: { id: true },
    });
    const g = await createIntegrationInstance(
      ctx(),
      {
        catalogType: "GENERIC",
        name: "Mercado Pago",
        inboundAuthStrategy: "HMAC_SHA256",
        inboundSecretRef: `vault:${v.id}`,
        config: MP_CONFIG,
      },
      appDb,
    );
    instanceId = g.id;
    routeToken = g.routeToken as string;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "inbound_deliveries",
        "integration_external_refs",
        "integration_instances",
        "vault_entries",
        "audit_logs",
      ]) {
        await suDb
          .$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => {});
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("the query string of the URL reaches the signature, and a body the manifest does not sign is not acted on", async () => {
    const minted = await ensureConversationRef({
      tenantId,
      integrationInstanceId: instanceId,
      threadId: `${tenantId}:1:77`,
      base: appDb,
    });
    if (!minted.ok) throw new Error("mint");
    const body = JSON.stringify({
      event_id: "pay-1:approved",
      conversation_ref: minted.ref,
      text: "Pagamento aprovado",
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = hmac(
      SECRET,
      mpManifest({ dataId: "123456", requestId: "req-9", ts }),
    );
    // The route's own database is the app's; the receptor runs for real on the test one, and
    // the detached dispatch (not what this measures) is held.
    const real = inbound.receiveInbound;
    const spies = [
      spyOn(inbound, "receiveInbound").mockImplementation((p) =>
        real({ ...p, base: appDb }),
      ),
      spyOn(inbound, "processInboundDelivery").mockResolvedValue("skipped"),
    ];
    const send = (b: string) =>
      integrationsController.handle(
        new Request(
          `http://localhost/v1/integrations/inbound/${routeToken}?data.id=123456&type=payment`,
          {
            method: "POST",
            body: b,
            headers: {
              "content-type": "application/json",
              "x-signature": `ts=${ts},v1=${sig}`,
              "x-request-id": "req-9",
            },
          },
        ),
      );
    // The same signed notification replayed with another unsigned body: still one problem, so
    // still one FAILED row (keyed on the body, each variation filed its own row and dead-letter).
    const replayed = JSON.stringify({
      event_id: "pay-1:approved",
      conversation_ref: minted.ref,
      text: "Outro corpo, mesma assinatura",
    });
    const [res, replay] = await (async () => {
      try {
        return [await send(body), await send(replayed)];
      } finally {
        for (const s of spies) s.mockRestore();
      }
    })();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ack: true, outcome: "invalid" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ack: true, outcome: "invalid" });
    const rows = await suDb.inboundDelivery.findMany({
      where: { integrationInstanceId: instanceId },
      select: { dedupeKey: true, status: true, payload: true },
    });
    expect(rows.filter((r) => r.dedupeKey === "pay-1:approved")).toEqual([]);
    expect(
      rows.filter(
        (r) =>
          r.status === "FAILED" &&
          Bun.deepEquals(r.payload, {
            reason: "invalid",
            issues: "body not covered by the signed message",
          }),
      ),
    ).toHaveLength(1);
  });

  test("a message that covers the body and a query parameter queues the event", async () => {
    const v = await suDb.vaultEntry.create({
      data: { tenantId, name: "qb-secret", secret: encryptJson(SECRET) },
      select: { id: true },
    });
    const g = await createIntegrationInstance(
      ctx(),
      {
        catalogType: "GENERIC",
        name: "Query and body",
        inboundAuthStrategy: "HMAC_SHA256",
        inboundSecretRef: `vault:${v.id}`,
        config: { signature: { message: "{{query.order}}.{{body}}" } },
      },
      appDb,
    );
    const minted = await ensureConversationRef({
      tenantId,
      integrationInstanceId: g.id,
      threadId: `${tenantId}:1:78`,
      base: appDb,
    });
    if (!minted.ok) throw new Error("mint");
    const body = JSON.stringify({
      event_id: "order-7:paid",
      conversation_ref: minted.ref,
      text: "Pedido pago",
    });
    const r = await receiveInbound({
      routeToken: g.routeToken as string,
      rawBody: body,
      getHeader: lookup({ "x-webhook-signature": hmac(SECRET, `7.${body}`) }),
      getQuery: lookup({ order: "7" }),
      base: appDb,
    });
    expect(r.outcome).toBe("queued");
  });

  test("a body signed only inside a [[group]] the sender can drop is not acted on", async () => {
    const v = await suDb.vaultEntry.create({
      data: { tenantId, name: "grp-secret", secret: encryptJson(SECRET) },
      select: { id: true },
    });
    const g = await createIntegrationInstance(
      ctx(),
      {
        catalogType: "GENERIC",
        name: "Droppable body",
        inboundAuthStrategy: "HMAC_SHA256",
        inboundSecretRef: `vault:${v.id}`,
        config: { signature: { message: "prefix[[{{body}}{{header.x-id}}]]" } },
      },
      appDb,
    );
    const minted = await ensureConversationRef({
      tenantId,
      integrationInstanceId: g.id,
      threadId: `${tenantId}:1:79`,
      base: appDb,
    });
    if (!minted.ok) throw new Error("mint");
    // A signature over "prefix" alone, the message rendered when x-id is left out, now
    // travelling with a body the sender wrote.
    const r = await receiveInbound({
      routeToken: g.routeToken as string,
      rawBody: JSON.stringify({
        event_id: "forged:1",
        conversation_ref: minted.ref,
        text: "Pagamento aprovado",
      }),
      getHeader: lookup({ "x-webhook-signature": hmac(SECRET, "prefix") }),
      getQuery: lookup({}),
      base: appDb,
    });
    expect(r.outcome).toBe("invalid");
    const rows = await suDb.inboundDelivery.findMany({
      where: { integrationInstanceId: g.id },
      select: { dedupeKey: true },
    });
    expect(rows.map((x) => x.dedupeKey)).not.toContain("forged:1");
  });

  test("a toolpack row stored with a manifest-only signature does not act on the body either", async () => {
    const v = await suDb.vaultEntry.create({
      data: { tenantId, name: "asaas-secret", secret: encryptJson(SECRET) },
      select: { id: true },
    });
    const created = await createIntegrationInstance(
      ctx(),
      {
        catalogType: "ASAAS",
        name: "Asaas antigo",
        inboundAuthStrategy: "HMAC_SHA256",
        inboundSecretRef: `vault:${v.id}`,
      },
      appDb,
    );
    // The signature written straight to the row: the writer refuses this shape now, and a row from
    // before the refusal is what the receptor still has to answer about.
    await suDb.integrationInstance.update({
      where: { id: created.id },
      data: { config: { signature: { message: "{{query.id}}" } } },
    });
    const r = await receiveInbound({
      routeToken: created.routeToken as string,
      rawBody: JSON.stringify({
        event: "PAYMENT_RECEIVED",
        payment: { id: "pay_1", externalReference: "forged", value: 999 },
      }),
      getHeader: lookup({ "x-webhook-signature": hmac(SECRET, "evt-1") }),
      getQuery: lookup({ id: "evt-1" }),
      base: appDb,
    });
    expect(r.outcome).toBe("invalid");
  });

  test("the same notification with another data.id in the URL is the uniform 401", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = hmac(SECRET, mpManifest({ dataId: "123456", ts }));
    await expect(
      receiveInbound({
        routeToken,
        rawBody: "{}",
        getHeader: lookup({ "x-signature": `ts=${ts},v1=${sig}` }),
        getQuery: lookup({ "data.id": "654321" }),
        base: appDb,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("an update with an unusable message is refused and the stored config is kept", async () => {
    await expect(
      updateIntegrationInstance(
        ctx(),
        instanceId,
        { config: { ...MP_CONFIG, signature: { message: "{{nope}}" } } },
        appDb,
      ),
    ).rejects.toMatchObject({ field: "config.signature.message" });
    const row = await suDb.integrationInstance.findUniqueOrThrow({
      where: { id: instanceId },
      select: { config: true },
    });
    expect(row.config).toEqual(MP_CONFIG);
  });
});
