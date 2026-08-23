import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { authorizeContact } from "@/modules/contact-auth/service";
import type { ContactAuthConfig } from "@/modules/contact-auth/settings";
import { seedChatwootInstance } from "../utils/chatwoot";

// `timeoutMs` says it covers every step that waits. The credential is resolved BEFORE the request,
// and for a managed-OAuth entry that resolution refreshes a token over the network under a ceiling
// of its own (10s in the vault module). Timed from inside the request, a gate set to one second
// could hold the webhook for eleven — the webhook turn sits behind this call, so the budget has to
// start where the waiting starts.

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
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

let tenantId = 0n;
let contactDbId = 0n;

const cfg = (over: Partial<ContactAuthConfig> = {}): ContactAuthConfig => ({
  enabled: true,
  url: "https://ops.example.com/authorize",
  credentialRef: "vault:1",
  timeoutMs: 1000,
  noticeCooldownSeconds: 60,
  includeMessageText: false,
  denyMessage: null,
  handoffEnabled: true,
  handoffTeamId: null,
  handoffTeamInstanceId: null,
  ...over,
});

describe.skipIf(!dbUp)("the gate's time budget", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CAB", slug: `cab-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, { tenantId, accountId: 1 });
    const c = await suDb.contact.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootContactId: 91,
        phone: "+5511988887777",
      },
      select: { id: true },
    });
    contactDbId = c.id;
  });

  afterAll(async () => {
    if (tenantId) await suDb.tenant.delete({ where: { id: tenantId } });
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a credential refresh that hangs spends the gate's budget, not its own", async () => {
    let fetched = 0;
    const started = Date.now();
    const verdict = await authorizeContact({
      tenantId,
      agentId: 1n,
      contactDbId,
      conversationId: 5001,
      inboxId: 71,
      channelType: "Channel::Whatsapp",
      messageText: null,
      requestKey: "inbox",
      cfg: cfg({ timeoutMs: 1000 }),
      base: appDb,
      // Never settles: the vault's own ceiling is ten seconds, so without the gate's deadline
      // covering this step the call below would sit here for all ten.
      resolveCredential: () => new Promise(() => {}),
      fetchImpl: (async () => {
        fetched += 1;
        return new Response('{"authorized":true}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    // A budget spent before the endpoint was asked is a timeout, not an unreadable credential: the
    // operator's key may be fine and merely slower than the gate.
    expect(verdict).toMatchObject({ outcome: "error", reason: "timeout" });
    expect(fetched).toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("the request inherits what the credential already spent", async () => {
    let fetched = 0;
    const started = Date.now();
    const verdict = await authorizeContact({
      tenantId,
      agentId: 1n,
      contactDbId,
      conversationId: 5002,
      inboxId: 71,
      channelType: "Channel::Whatsapp",
      messageText: null,
      requestKey: "inbox2",
      cfg: cfg({ timeoutMs: 1200 }),
      base: appDb,
      // Slow but not fatal: most of the budget goes here, and the rest belongs to the request.
      resolveCredential: async () => {
        await new Promise((r) => setTimeout(r, 700));
        return { value: "k", kind: null, paramName: null };
      },
      // Answers headers and then stalls, which under one shared budget is a timeout well before
      // the request would have had a fresh 1200ms of its own.
      fetchImpl: (async (_i: RequestInfo | URL, init?: RequestInit) => {
        fetched += 1;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () =>
                  controller.error(new DOMException("aborted", "AbortError")),
                { once: true },
              );
            },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
      assertSafe: async (u: string) => new URL(u),
    });
    expect(verdict).toMatchObject({ outcome: "error", reason: "timeout" });
    expect(fetched).toBe(1);
    // The whole call fits in the configured budget plus slack, NOT 700ms + a fresh 1200ms.
    expect(Date.now() - started).toBeLessThan(1_800);
  });
});
