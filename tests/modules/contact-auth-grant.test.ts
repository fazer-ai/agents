import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { authorizeContact } from "@/modules/contact-auth/service";
import {
  CONTACT_AUTH_DEFAULTS,
  type ContactAuthConfig,
} from "@/modules/contact-auth/settings";
import { clearContactAuthState } from "@/modules/contact-auth/state";
import { seedChatwootInstance } from "../utils/chatwoot";

// ── REUSING A POSITIVE VERDICT ACROSS MESSAGES, AND GETTING BACK OUT OF IT (issue #189) ──
//
// The gate asks the operator's endpoint on EVERY incoming message, which is the right default and
// the reason `docs/contact-auth.md` can promise that a revocation lands on the contact's next
// message. Two operators asked for the other shape: an endpoint that is expensive or rate-limited
// (a burst of five WhatsApp messages is five identical lookups against a core banking API), and a
// gate that is an UNLOCK rather than a lookup (the customer sends an access code once and should
// stay served afterwards, without the endpoint having to remember them).
//
// `mode: "once"` stores the positive verdict per contact and reuses it. Everything below is about
// the way back out, because stored state with no exit is the failure mode this feature could have:
//
//   TTL       the grant expires, and the policy's current TTL is part of what it was granted under.
//   IDENTITY  the mirror's phone/email/identifier is what the endpoint answered ABOUT.
//   POLICY    url, credential and the unlock opt-in decide who answered and what was asked.
//   DENIAL    a fresh refusal drops whatever was stored, so a re-ask can only ever un-grant.
//
// Nothing here polls or sleeps for a verdict: the endpoint double counts its own calls, so "the
// endpoint was not asked" is a number rather than a timing.

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

// TEST-NET-3: passes the SSRF check without a DNS lookup, and the injected fetch answers before any
// socket could be opened.
const AUTH_URL = "https://203.0.113.9:9443/check";
const OTHER_URL = "https://203.0.113.9:9443/check-v2";
const PHONE = "+5511955554444";

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let otherAgentId = 0n;
let contactId = 0n;
let namelessContactId = 0n;

function cfg(over: Partial<ContactAuthConfig> = {}): ContactAuthConfig {
  return {
    ...CONTACT_AUTH_DEFAULTS,
    enabled: true,
    url: AUTH_URL,
    mode: "once",
    ...over,
  };
}

// The endpoint double: a FIFO of canned answers plus the count of times it was reached. The count
// IS the assertion in most cases below — "reused" means this number did not move.
function endpoint(...responses: Array<() => Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = responses.shift();
    if (!next) throw new Error("endpoint double: no response queued");
    return next();
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const allowed = (context?: Record<string, unknown>) =>
  new Response(
    JSON.stringify({ authorized: true, ...(context ? { context } : {}) }),
    { status: 200 },
  );
const denied = () => new Response('{"authorized":false}', { status: 200 });
const broken = () => new Response("boom", { status: 500 });

// A client whose GRANT READ fails and whose every other statement works: the transient database blip
// that separates "nobody stored a verdict" from "we could not find out". The seam is `params.base`,
// which `runScopedOn` turns into `$extends(...).$transaction(...)`, so the wrapper has to follow it
// down to the transaction client the module actually calls. Binding to `target` rather than
// forwarding the proxy as the receiver keeps Prisma's own accessors (several are getters closing
// over the client) working.
function baseWithFailingGrantRead(real: PrismaClient): PrismaClient {
  const wrap = <T extends object>(obj: T, patch: (p: string) => unknown) =>
    new Proxy(obj, {
      get(target, prop, receiver) {
        if (typeof prop === "string") {
          const replacement = patch(prop);
          if (replacement !== undefined) return replacement;
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  // biome-ignore lint/suspicious/noExplicitAny: Prisma's extension surface is not expressible here
  const anyReal = real as any;
  return wrap(real, (prop) =>
    prop === "$extends"
      ? // biome-ignore lint/suspicious/noExplicitAny: same
        (...args: any[]) => {
          const extended = anyReal.$extends(...args);
          return wrap(extended, (p) =>
            p === "$transaction"
              ? // biome-ignore lint/suspicious/noExplicitAny: same
                (fn: any, opts: any) =>
                  extended.$transaction(
                    // biome-ignore lint/suspicious/noExplicitAny: same
                    (tx: any) =>
                      fn(
                        wrap(tx, (m) =>
                          m === "contactAuthGrant"
                            ? wrap(tx.contactAuthGrant, (call) =>
                                call === "findUnique"
                                  ? () => {
                                      throw new Error("grant read is down");
                                    }
                                  : undefined,
                              )
                            : undefined,
                        ),
                      ),
                    opts,
                  )
              : undefined,
          );
        }
      : undefined,
  ) as PrismaClient;
}

let seq = 0;
async function ask(params: {
  cfg: ContactAuthConfig;
  fetchImpl: typeof fetch;
  agent?: bigint;
  contact?: bigint;
  base?: PrismaClient;
}) {
  seq += 1;
  return authorizeContact({
    tenantId,
    agentId: params.agent ?? agentId,
    contactDbId: params.contact ?? contactId,
    conversationId: 5100,
    inboxId: 51,
    channelType: "Channel::Whatsapp",
    messageText: "oi",
    // A fresh key every time: single-flight coalesces concurrent askings of the SAME question, and
    // what is under test here is a sequence of different messages.
    requestKey: `msg:${seq}`,
    cfg: params.cfg,
    base: params.base ?? appDb,
    fetchImpl: params.fetchImpl,
  });
}

async function grants(agent: bigint = agentId) {
  return suDb.contactAuthGrant.findMany({
    where: { tenantId, agentId: agent },
    orderBy: { id: "asc" },
  });
}

describe.skipIf(!dbUp)("contact authorization: reusing a verdict", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CAG", slug: `cag-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 61,
      baseUrl: "https://203.0.113.31:9",
    });
    instanceId = inst.id;
    const base = {
      tenantId,
      systemPrompt: "Você é prestativa.",
      modelConfig: { provider: "openai", model: "gpt-4o-mini" },
    };
    agentId = (
      await suDb.agent.create({ data: { ...base, name: "Atendente" } })
    ).id;
    otherAgentId = (
      await suDb.agent.create({ data: { ...base, name: "Segunda" } })
    ).id;
    contactId = (
      await suDb.contact.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootContactId: 6161,
          name: "Cliente",
          phone: PHONE,
        },
      })
    ).id;
    namelessContactId = (
      await suDb.contact.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootContactId: 6162,
          name: "Anônimo",
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.contactAuthGrant.deleteMany({ where: { tenantId } });
    await suDb.contact.deleteMany({ where: { tenantId } });
    await suDb.agent.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } });
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  beforeEach(async () => {
    clearContactAuthState();
    await suDb.contactAuthGrant.deleteMany({ where: { tenantId } });
    await suDb.contact.update({
      where: { id: contactId },
      data: { phone: PHONE, email: null, attributes: {} },
    });
  });

  test("perMessage asks the endpoint again, which is the premise", async () => {
    const ep = endpoint(allowed, allowed);
    const first = await ask({ cfg: cfg({ mode: "perMessage" }), ...ep });
    const second = await ask({ cfg: cfg({ mode: "perMessage" }), ...ep });
    expect([first.outcome, second.outcome]).toEqual(["allowed", "allowed"]);
    expect(ep.calls).toHaveLength(2);
    // And nothing is stored under the default, so switching the mode on later cannot inherit a
    // grant nobody asked to keep.
    expect(await grants()).toHaveLength(0);
  });

  test("once asks once and reuses the verdict on the next message", async () => {
    const ep = endpoint(allowed);
    const first = await ask({ cfg: cfg(), ...ep });
    const second = await ask({ cfg: cfg(), ...ep });
    expect([first.outcome, second.outcome]).toEqual(["allowed", "allowed"]);
    expect(ep.calls).toHaveLength(1);
    expect(first.reused).toBeFalsy();
    expect(second.reused).toBe(true);
  });

  test("the stored grant holds no identity in the clear", async () => {
    const ep = endpoint(allowed);
    await ask({ cfg: cfg(), ...ep });
    const [row] = await grants();
    expect(row).toBeDefined();
    // The row is keyed by a fingerprint of the identity, never by the identity: the phone the
    // endpoint was asked about must not be readable from a table whose whole job is bookkeeping.
    // Read as the WHOLE row rendered to text, not column by column, so a column added later is
    // covered by this without anyone remembering to add it here.
    const [dumped] = await suDb.$queryRaw<Array<{ row: string }>>`
      SELECT contact_auth_grants::text AS row FROM contact_auth_grants
       WHERE tenant_id = ${tenantId}`;
    expect(dumped?.row).toBeDefined();
    expect(dumped?.row).not.toContain(PHONE);
    // …and the digits alone, since a stored number could have been normalized on the way in.
    expect(dumped?.row).not.toContain(PHONE.replace(/\D/g, ""));
  });

  test("the endpoint's context survives the reuse", async () => {
    const ep = endpoint(() => allowed({ plan: "premium", seats: 12 }));
    const first = await ask({ cfg: cfg(), ...ep });
    const second = await ask({ cfg: cfg(), ...ep });
    expect(first.context).toEqual(second.context);
    expect(second.context).toEqual([
      { key: "plan", value: "premium" },
      { key: "seats", value: "12" },
    ]);
  });

  test("a denial is never stored, so an unlock is never made sticky", async () => {
    const ep = endpoint(denied, denied);
    const first = await ask({ cfg: cfg(), ...ep });
    const second = await ask({ cfg: cfg(), ...ep });
    expect([first.outcome, second.outcome]).toEqual(["denied", "denied"]);
    expect(ep.calls).toHaveLength(2);
    expect(await grants()).toHaveLength(0);
  });

  test("an endpoint failure is not a grant either", async () => {
    const ep = endpoint(broken, allowed);
    const first = await ask({ cfg: cfg(), ...ep });
    expect(first.outcome).toBe("error");
    expect(await grants()).toHaveLength(0);
    const second = await ask({ cfg: cfg(), ...ep });
    expect(second.outcome).toBe("allowed");
    expect(ep.calls).toHaveLength(2);
  });

  test("a contact with nothing to identify them stores nothing", async () => {
    const ep = endpoint();
    const verdict = await ask({
      cfg: cfg(),
      contact: namelessContactId,
      ...ep,
    });
    expect(verdict.outcome).toBe("no_identity");
    expect(ep.calls).toHaveLength(0);
    expect(await grants()).toHaveLength(0);
  });

  test("the identity moving under the grant re-asks", async () => {
    const ep = endpoint(allowed, allowed);
    await ask({ cfg: cfg(), ...ep });
    // The mirror learns a new phone for this contact: whoever the endpoint answered about is not
    // necessarily who is writing now.
    await suDb.contact.update({
      where: { id: contactId },
      data: { phone: "+5511900001111" },
    });
    const second = await ask({ cfg: cfg(), ...ep });
    expect(second.outcome).toBe("allowed");
    expect(second.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(2);
  });

  test("a fresh denial drops the stored grant", async () => {
    const ep = endpoint(allowed, denied);
    await ask({ cfg: cfg(), ...ep });
    expect(await grants()).toHaveLength(1);
    await suDb.contact.update({
      where: { id: contactId },
      data: { phone: "+5511900002222" },
    });
    const second = await ask({ cfg: cfg(), ...ep });
    expect(second.outcome).toBe("denied");
    // Re-asking can only ever take a grant away: what is stored describes an identity the endpoint
    // has just refused, and leaving it would serve the next message from a verdict already reversed.
    expect(await grants()).toHaveLength(0);
  });

  test("switching the mode back to perMessage ignores what is stored", async () => {
    const ep = endpoint(allowed, allowed);
    await ask({ cfg: cfg(), ...ep });
    expect(await grants()).toHaveLength(1);
    // The operator turning the reuse off is the plainest revocation there is, and it must not have
    // to wait for the TTL: the grants are still on disk, and every message asks again from here.
    const second = await ask({ cfg: cfg({ mode: "perMessage" }), ...ep });
    expect(second.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(2);
    // And that ask writes nothing, so turning the reuse back on later starts from a fresh question.
    expect(await grants()).toHaveLength(1);
  });

  test("a fresh refusal drops a grant the read could not see", async () => {
    const ep = endpoint(allowed, denied);
    await ask({ cfg: cfg(), ...ep });
    expect(await grants()).toHaveLength(1);
    // The database refusing the READ is not the database refusing everything: the ask goes ahead
    // (fail-closed towards asking), and the refusal it comes back with has to drop a grant that is
    // otherwise still valid — without this, one transient blip plus a revocation would keep serving
    // a refused contact for the rest of the TTL.
    const second = await ask({
      cfg: cfg(),
      fetchImpl: ep.fetchImpl,
      base: baseWithFailingGrantRead(appDb),
    });
    expect(second.outcome).toBe("denied");
    expect(ep.calls).toHaveLength(2);
    expect(await grants()).toHaveLength(0);
  });

  test("the endpoint changing re-asks", async () => {
    const ep = endpoint(allowed, allowed);
    await ask({ cfg: cfg(), ...ep });
    const second = await ask({ cfg: cfg({ url: OTHER_URL }), ...ep });
    expect(second.reused).toBeFalsy();
    expect(ep.calls).toEqual([`${AUTH_URL}`, `${OTHER_URL}`]);
  });

  test("the unlock opt-in changing re-asks", async () => {
    const ep = endpoint(allowed, allowed);
    await ask({ cfg: cfg(), ...ep });
    // An operator turning the unlock on is changing the QUESTION, not just its payload: the stored
    // verdict answered a lookup, and what is being asked now is whether a code was sent.
    const second = await ask({ cfg: cfg({ includeMessageText: true }), ...ep });
    expect(second.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(2);
  });

  test("the TTL changing re-asks, which is the operator's lever", async () => {
    const ep = endpoint(allowed, allowed);
    await ask({ cfg: cfg({ grantTtlSeconds: 3600 }), ...ep });
    const second = await ask({ cfg: cfg({ grantTtlSeconds: 1800 }), ...ep });
    expect(second.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(2);
  });

  test("an expired grant re-asks", async () => {
    const ep = endpoint(allowed, allowed);
    await ask({ cfg: cfg(), ...ep });
    await suDb.contactAuthGrant.updateMany({
      where: { tenantId, agentId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const second = await ask({ cfg: cfg(), ...ep });
    expect(second.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(2);
    // The re-ask replaces the row rather than adding one beside it.
    expect(await grants()).toHaveLength(1);
  });

  test("the TTL the grant was written under is what expires it", async () => {
    const ep = endpoint(allowed);
    const before = Date.now();
    await ask({ cfg: cfg({ grantTtlSeconds: 3600 }), ...ep });
    const [row] = await grants();
    expect(row?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 3600_000);
    expect(row?.expiresAt.getTime()).toBeLessThan(Date.now() + 3601_000);
  });

  test("a grant belongs to ONE agent", async () => {
    const ep = endpoint(allowed, allowed);
    await ask({ cfg: cfg(), ...ep });
    // Two agents can point at different endpoints with different credentials, so a verdict one of
    // them was given says nothing about the other.
    const second = await ask({ cfg: cfg(), agent: otherAgentId, ...ep });
    expect(second.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(2);
    expect(await grants(otherAgentId)).toHaveLength(1);
  });
});
