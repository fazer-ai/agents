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
import { encryptJson } from "@/api/lib/crypto";
import {
  clearContactAuthGrantState,
  contactAuthPolicyHash,
  dropContactAuthGrant,
  knownContactCount,
  setMaxTrackedContactsForTest,
  setRefusalProtectionForTest,
  unconfirmedWriteCount,
  writeContactAuthGrant,
} from "@/modules/contact-auth/grants";
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
//   POLICY    url, credential, the unlock opt-in and the TTL decide who answered and what was asked.
//             A MATCH rule, not a revocation: nudging a field and putting it back clears nothing,
//             which is asserted below rather than left to be discovered.
//   DENIAL    a fresh refusal drops whatever was stored, so a re-ask can only ever un-grant. Under
//             EVERY mode, which is not symmetry for its own sake: grants outlive a switch to
//             `perMessage`, so a refusal arriving while the switch is off has to reach them.
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
let credentialRef = "";
let credentialId = 0n;
const spareContacts: bigint[] = [];

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

// A client whose GRANT statements misbehave and whose every other statement works: the transient
// database trouble that separates "nobody stored a verdict" from "we could not find out", and the
// saturated pool that separates a slow gate from a slow endpoint. The seam is `params.base`, which
// `runScopedOn` turns into `$extends(...).$transaction(...)`, so the wrapper has to follow it down to
// the transaction client the module actually calls. Binding to `target` rather than forwarding the
// proxy as the receiver keeps Prisma's own accessors (several are getters closing over the client)
// working.
//
// The hook is handed the REAL delegate, and a hook that wants the statement to happen must call it:
// forwarding to the outer client instead runs unscoped, and under RLS an unscoped statement matches
// ZERO rows — a "slow delete" that deletes nothing and a read that always comes back empty, both of
// which make a test pass while measuring the opposite of what it says.
function baseWithGrantHook(
  real: PrismaClient,
  hook: (
    method: string,
    // biome-ignore lint/suspicious/noExplicitAny: the delegate surface is not expressible here
    delegate: any,
    model?: string,
    // biome-ignore lint/suspicious/noExplicitAny: same
  ) => ((...args: any[]) => unknown) | undefined,
): PrismaClient {
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
                          m === "contactAuthGrant" || m === "vaultEntry"
                            ? wrap(tx[m], (call) => hook(call, tx[m], m))
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
    const cred = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "auth-key",
        kind: "bearer_token",
        secret: encryptJson("AUTH-SECRET"),
      },
      select: { id: true },
    });
    credentialId = cred.id;
    credentialRef = `vault:${cred.id}`;
    for (let i = 0; i < 3; i++) {
      spareContacts.push(
        (
          await suDb.contact.create({
            data: {
              tenantId,
              chatwootInstanceId: instanceId,
              chatwootContactId: 6200 + i,
              phone: `+55119000000${i}`,
            },
          })
        ).id,
      );
    }
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.contactAuthGrant.deleteMany({ where: { tenantId } });
    await suDb.vaultEntry.deleteMany({ where: { tenantId } });
    await suDb.contact.deleteMany({ where: { tenantId } });
    await suDb.agent.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } });
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  beforeEach(async () => {
    clearContactAuthState();
    clearContactAuthGrantState();
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
    // The row is still there, and that is on purpose: the mode decides who READS a grant, so an
    // operator flipping back and forth does not lose what the endpoint already answered. What must
    // not survive that trip is a verdict the endpoint has since reversed — the case below.
    expect(await grants()).toHaveLength(1);
  });

  test("a refusal under perMessage drops what once stored", async () => {
    const ep = endpoint(allowed, denied, allowed);
    await ask({ cfg: cfg(), ...ep });
    expect(await grants()).toHaveLength(1);
    // Only `once` GRANTS; every mode UN-GRANTS. Without that asymmetry this round trip serves a
    // refused contact: the grant survives the switch (above), the refusal below cannot touch it,
    // and switching back inside the TTL reuses an allow older than the refusal.
    const denial = await ask({ cfg: cfg({ mode: "perMessage" }), ...ep });
    expect(denial.outcome).toBe("denied");
    expect(await grants()).toHaveLength(0);
    const back = await ask({ cfg: cfg(), ...ep });
    expect(back.outcome).toBe("allowed");
    expect(back.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(3);
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
      base: baseWithGrantHook(appDb, (m) =>
        m === "findUnique"
          ? () => {
              throw new Error("grant read is down");
            }
          : undefined,
      ),
    });
    expect(second.outcome).toBe("denied");
    expect(ep.calls).toHaveLength(2);
    expect(await grants()).toHaveLength(0);
  });

  test("a refusal whose DELETE fails is not forgotten", async () => {
    const ep = endpoint(allowed, denied, allowed);
    await ask({ cfg: cfg(), ...ep });
    expect(await grants()).toHaveLength(1);
    // The refusal arrives with the reuse switched off, which is when a grant is reachable by one at
    // all (under `once` a standing grant is what stops the message from asking in the first place).
    // The delete is the one write that ENDS an authorization, and here the database refuses it.
    const denial = await ask({
      cfg: cfg({ mode: "perMessage" }),
      fetchImpl: ep.fetchImpl,
      base: baseWithGrantHook(appDb, (m) =>
        m === "deleteMany"
          ? () => {
              throw new Error("delete is down");
            }
          : undefined,
      ),
    });
    expect(denial.outcome).toBe("denied");
    // The row is still there, because the delete really did fail...
    expect(await grants()).toHaveLength(1);
    expect(unconfirmedWriteCount()).toBe(1);
    // ...and it is not served when the operator switches the reuse back on. The next check asks the
    // endpoint, and the delete is retried there.
    const after = await ask({ cfg: cfg(), ...ep });
    expect(after.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(3);
    expect(unconfirmedWriteCount()).toBe(0);
  });

  test("a stored-verdict read that hangs spends the gate's budget, not more", async () => {
    const ep = endpoint(allowed);
    const before = Date.now();
    const verdict = await ask({
      cfg: cfg({ timeoutMs: 1000 }),
      fetchImpl: ep.fetchImpl,
      base: baseWithGrantHook(appDb, (m) =>
        m === "findUnique"
          ? async () => {
              await Bun.sleep(5000);
              return null;
            }
          : undefined,
      ),
    });
    const elapsed = Date.now() - before;
    // `timeoutMs` covers every step that waits, and a saturated pool is as capable of holding the
    // webhook as a slow endpoint is. Five seconds of read against a one-second budget: the gate
    // comes back on its own deadline, and it comes back as the fail-closed answer.
    expect(elapsed).toBeLessThan(2500);
    expect(verdict.outcome).toBe("error");
    expect(verdict.reason).toBe("timeout");
  });

  test("an allow in flight cannot outlive a refusal that lands first", async () => {
    // Two checks for one contact, deliberately not coalesced: the unlock flow keys the single-flight
    // by MESSAGE id, so two messages are two questions and two requests. The slow one is released
    // only after the fast one has been refused, which is the order the fence exists for and the one
    // that is otherwise decided by whichever socket answers first.
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const held = new Promise<void>((r) => {
      release = r;
    });
    // Resolved from INSIDE the slow request, so the refusal below is started at a point the first
    // check has provably already reached its endpoint. Ordering by timing instead is how a race test
    // comes to pass for the wrong reason — measured on this very case, which flipped order under the
    // full file and held under `-t`.
    const reached = new Promise<void>((r) => {
      entered = r;
    });
    const calls: string[] = [];
    const slowAllow = (async () => {
      calls.push("slow");
      entered?.();
      await held;
      return allowed();
    }) as unknown as typeof fetch;
    const fastDeny = (async () => {
      calls.push("fast");
      return denied();
    }) as unknown as typeof fetch;

    const slow = ask({ cfg: cfg(), fetchImpl: slowAllow });
    await reached;
    const denial = await ask({ cfg: cfg(), fetchImpl: fastDeny });
    expect(denial.outcome).toBe("denied");
    release?.();
    const late = await slow;

    // The verdict still stands for the message it answered — this is not about withholding a reply.
    expect(late.outcome).toBe("allowed");
    // What must not happen is the storage: an allow from a check that started before the refusal
    // landed is older than it, however late it arrives, and storing it would serve the contact for
    // the whole TTL after the endpoint said no.
    expect(await grants()).toHaveLength(0);
    expect(calls).toEqual(["slow", "fast"]);
  });

  test("a pending refusal is retried under perMessage too", async () => {
    const ep = endpoint(allowed, denied, allowed);
    await ask({ cfg: cfg(), ...ep });
    const failingDelete = baseWithGrantHook(appDb, (m) =>
      m === "deleteMany"
        ? () => {
            throw new Error("delete is down");
          }
        : undefined,
    );
    await ask({
      cfg: cfg({ mode: "perMessage" }),
      fetchImpl: ep.fetchImpl,
      base: failingDelete,
    });
    expect(unconfirmedWriteCount()).toBe(1);
    // `perMessage` reads no grants at all, so a retry living on the read path would never run for
    // the mode where the refusal usually happens — and the entry would sit in memory for the life of
    // the process, for a delete that may well have succeeded on its own.
    await ask({ cfg: cfg({ mode: "perMessage" }), ...ep });
    expect(unconfirmedWriteCount()).toBe(0);
    expect(await grants()).toHaveLength(0);
  });

  test("a retry does not make the old refusal newer than the check retrying it", async () => {
    const ep = endpoint(allowed, denied, allowed);
    await ask({ cfg: cfg(), ...ep });
    await ask({
      cfg: cfg({ mode: "perMessage" }),
      fetchImpl: ep.fetchImpl,
      base: baseWithGrantHook(appDb, (m) =>
        m === "deleteMany"
          ? () => {
              throw new Error("delete is down");
            }
          : undefined,
      ),
    });
    expect(unconfirmedWriteCount()).toBe(1);
    // The retry lands inside THIS check, and it must not stamp the refusal with its own clock: an
    // instant later than this check's own start would make the endpoint's fresh yes read as older
    // than a refusal from before it, and the allow this ask paid for would be thrown away.
    const fresh = await ask({ cfg: cfg(), ...ep });
    expect(fresh.outcome).toBe("allowed");
    expect(await grants()).toHaveLength(1);
    expect(unconfirmedWriteCount()).toBe(0);
  });

  test("a write this process could not confirm leaves nothing servable", async () => {
    const ep = endpoint(allowed, allowed, allowed);
    await ask({ cfg: cfg({ grantTtlSeconds: 3600 }), ...ep });
    // The upsert fails while a row for the SAME contact is on disk, written under a policy the next
    // check will be back on. The statement may well have committed, so "it did not happen" is not a
    // reading this process is entitled to.
    const during = await ask({
      cfg: cfg({ grantTtlSeconds: 1800 }),
      fetchImpl: ep.fetchImpl,
      base: baseWithGrantHook(appDb, (m) =>
        m === "upsert"
          ? () => {
              throw new Error("upsert is down");
            }
          : undefined,
      ),
    });
    expect(during.outcome).toBe("allowed");
    expect(unconfirmedWriteCount()).toBe(1);
    // Back on the original policy, the row on disk matches again — and is still not served, because
    // the unconfirmed write outranks it. The check deletes first and asks.
    const after = await ask({ cfg: cfg({ grantTtlSeconds: 3600 }), ...ep });
    expect(after.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(3);
    expect(unconfirmedWriteCount()).toBe(0);
  });

  test("an allow cannot slip through while a refusal's delete is in flight", async () => {
    const ep = endpoint(allowed, denied, allowed);
    await ask({ cfg: cfg(), ...ep });

    let releaseAllow: (() => void) | undefined;
    const heldAllow = new Promise<void>((r) => {
      releaseAllow = r;
    });
    let deleteStarted: (() => void) | undefined;
    const deleting = new Promise<void>((r) => {
      deleteStarted = r;
    });
    const slowAllow = (async () => {
      await heldAllow;
      return allowed();
    }) as unknown as typeof fetch;

    // The allow is in flight first, so its check started before the refusal's.
    const allowInFlight = ask({ cfg: cfg(), fetchImpl: slowAllow });
    // The refusal's DELETE is entered and held there: the window where the row is already doomed and
    // the database has not been told yet. Nothing about the refusal has "landed" in the old sense.
    const denial = ask({
      cfg: cfg({ mode: "perMessage" }),
      fetchImpl: ep.fetchImpl,
      base: baseWithGrantHook(appDb, (m, delegate) =>
        m === "deleteMany"
          ? async (...args: unknown[]) => {
              deleteStarted?.();
              await Bun.sleep(150);
              return delegate.deleteMany(...args);
            }
          : undefined,
      ),
    });
    await deleting;
    releaseAllow?.();
    const [late] = await Promise.all([allowInFlight, denial]);

    expect(late.outcome).toBe("allowed");
    // Checking `refusedSince` and writing are one step per contact, so the allow cannot pass the
    // check in the gap the delete leaves open. Read and act in two steps and this row comes back.
    expect(await grants()).toHaveLength(0);
  });

  test("an allow that already passed its check cannot revive the row behind a refusal", async () => {
    const ep = endpoint(allowed, allowed, denied);
    await ask({ cfg: cfg(), ...ep });
    await suDb.contactAuthGrant.deleteMany({ where: { tenantId } });

    let upsertStarted: (() => void) | undefined;
    const upserting = new Promise<void>((r) => {
      upsertStarted = r;
    });
    // The other interleaving, and the one a mark-before-delete does NOT close: this allow passes its
    // ordering check while no refusal is known, and only then is slow. Whatever the refusal records
    // afterwards, this write is already past the point that would have read it.
    const allowInFlight = ask({
      cfg: cfg(),
      fetchImpl: ep.fetchImpl,
      base: baseWithGrantHook(appDb, (m, delegate) =>
        m === "upsert"
          ? async (...args: unknown[]) => {
              upsertStarted?.();
              await Bun.sleep(200);
              return delegate.upsert(...args);
            }
          : undefined,
      ),
    });
    await upserting;
    // The refusal runs to completion here, delete included, while that upsert is still in flight.
    await ask({ cfg: cfg({ mode: "perMessage" }), ...ep });
    await allowInFlight;

    // One queue per contact is what makes this hold: the refusal's section waits for the allow's,
    // so the delete is after the write rather than between its check and its write.
    expect(await grants()).toHaveLength(0);
  });

  test("a read that overlaps a refusal's delete does not serve the pre-delete row", async () => {
    const ep = endpoint(allowed, denied, allowed);
    await ask({ cfg: cfg(), ...ep });

    let deleteStarted: (() => void) | undefined;
    const deleting = new Promise<void>((r) => {
      deleteStarted = r;
    });
    const denial = ask({
      cfg: cfg({ mode: "perMessage" }),
      fetchImpl: ep.fetchImpl,
      base: baseWithGrantHook(appDb, (m, delegate) =>
        m === "deleteMany"
          ? async (...args: unknown[]) => {
              deleteStarted?.();
              await Bun.sleep(200);
              return delegate.deleteMany(...args);
            }
          : undefined,
      ),
    });
    await deleting;
    // The read starts while the delete is in flight. Un-serialized it gets a snapshot taken before
    // the row was removed, and a fresh refusal is answered with the verdict it just replaced.
    const reader = await ask({ cfg: cfg(), ...ep });
    await denial;

    expect(reader.reused).toBeFalsy();
    expect(reader.outcome).toBe("allowed");
    expect(ep.calls).toHaveLength(3);
  });

  test("a delete abandoned on the deadline cannot delete the next grant", async () => {
    const ep = endpoint(allowed, denied, allowed, allowed);
    await ask({ cfg: cfg(), ...ep });
    await ask({
      cfg: cfg({ mode: "perMessage" }),
      fetchImpl: ep.fetchImpl,
      base: baseWithGrantHook(appDb, (m) =>
        m === "deleteMany"
          ? () => {
              throw new Error("delete is down");
            }
          : undefined,
      ),
    });
    expect(unconfirmedWriteCount()).toBe(1);

    // The retry runs into a delete that outlives the gate's budget. The caller walks away on time;
    // the STATEMENT does not stop, and it is still on its way to the database.
    const timedOut = await ask({
      cfg: cfg({ timeoutMs: 1000 }),
      fetchImpl: ep.fetchImpl,
      base: baseWithGrantHook(appDb, (m, delegate) =>
        m === "deleteMany"
          ? async (...args: unknown[]) => {
              await Bun.sleep(1500);
              return delegate.deleteMany(...args);
            }
          : undefined,
      ),
    });
    expect(timedOut.outcome).toBe("error");

    // The next message is allowed and its grant is stored. Released from the queue when the CALLER
    // gave up, the straggler would delete this row and cost an endpoint call nobody needed.
    const stored = await ask({ cfg: cfg(), ...ep });
    expect(stored.outcome).toBe("allowed");
    await Bun.sleep(1200);
    expect(await grants()).toHaveLength(1);
  });

  test("a refusal waiting for the queue is still visible to a reader", async () => {
    const ep = endpoint(allowed, allowed, allowed);
    // A committed row under the policy the reader will use.
    await ask({ cfg: cfg(), ...ep });

    // Something else holds this contact's queue: a write under a DIFFERENT policy, whose upsert has
    // not committed yet. The row above is still the visible state, and the queue is busy. (Holding
    // it with a write under the SAME policy would be no test at all: the upsert is inside the
    // transaction, so nothing it writes is visible until the queue is released anyway.)
    let holdingQueue: (() => void) | undefined;
    const held = new Promise<void>((r) => {
      holdingQueue = r;
    });
    const slowWriter = ask({
      cfg: cfg({ grantTtlSeconds: 1800 }),
      fetchImpl: ep.fetchImpl,
      base: baseWithGrantHook(appDb, (m, delegate) =>
        m === "upsert"
          ? async (...args: unknown[]) => {
              holdingQueue?.();
              await Bun.sleep(300);
              return delegate.upsert(...args);
            }
          : undefined,
      ),
    });
    await held;

    // The refusal arrives while that queue is held. Its DELETE has to wait its turn — but the FACT
    // of the refusal must not, or for as long as the turn takes there is nothing for a reader to
    // see, and the reader serves the very row this refusal is about to remove.
    let refused: (() => void) | undefined;
    const denialAnswered = new Promise<void>((r) => {
      refused = r;
    });
    const denial = ask({
      cfg: cfg({ mode: "perMessage" }),
      fetchImpl: (async () => {
        refused?.();
        return denied();
      }) as unknown as typeof fetch,
    });
    await denialAnswered;
    await Bun.sleep(50);

    // The reader's own retry of that refusal queues behind the writer, so it waits — for the writer,
    // not for the network — and comes back having asked the endpoint. Un-marked, it would find a row
    // that still looks valid and serve it without waiting for anything.
    const reader = await ask({ cfg: cfg({ timeoutMs: 2000 }), ...ep });
    expect(reader.reused).toBeFalsy();
    await Promise.all([slowWriter, denial]);
  });

  test("an older refusal landing late takes a newer grant with it, on purpose", async () => {
    const ep = endpoint(allowed);
    await ask({ cfg: cfg(), ...ep });
    expect(await grants()).toHaveLength(1);
    // A refusal whose own check started BEFORE that allow, arriving after it. The row carries no
    // trace of which check wrote it, so this delete cannot spare it — and that is the direction to
    // take: the contact is re-asked on the next message and answered yes again, where sparing it
    // would mean serving a contact whose refusal simply lost a race, for the whole TTL. Asserted as
    // a fact so nobody later "fixes" the asymmetry into the unsafe side without noticing.
    await dropContactAuthGrant(
      appDb,
      { tenantId, agentId, contactId },
      {
        refusedAt: Date.now() - 5000,
      },
    );
    expect(await grants()).toHaveLength(0);
  });

  test("eviction spares a refusal an older check can still lose to", async () => {
    const key = { tenantId, agentId, contactId };
    // A refusal recorded now, with a check for the same contact still in flight against it — the
    // shape of every unlock burst. A check cannot outlive its own budget, so a marker younger than
    // the largest budget is one that an unfinished allow may still have to lose to.
    await dropContactAuthGrant(appDb, key, { refusedAt: Date.now() });
    setMaxTrackedContactsForTest(2);
    for (const contact of spareContacts) {
      await dropContactAuthGrant(
        appDb,
        { tenantId, agentId, contactId: contact },
        { refusedAt: Date.now() - 60_000 },
      );
    }
    // The in-flight allow finally lands. Evicted, its marker is gone and this writes a grant for the
    // full TTL over a refusal that already happened.
    await writeContactAuthGrant(
      appDb,
      key,
      { identityHash: "x", policyHash: "y", context: null, ttlSeconds: 3600 },
      { askedAt: Date.now() - 1000 },
    );
    expect(await grants()).toHaveLength(0);
  });

  test("the overflow a refusal spike leaves behind drains on its own", async () => {
    setMaxTrackedContactsForTest(1);
    setRefusalProtectionForTest(60);
    // Every marker young enough to be protected, so eviction cannot take any of them and the map is
    // over its cap. Nothing else is coming: a spike that stops refusing is exactly the case where no
    // later call arrives to look at this again, and the entries would sit there for the life of the
    // process.
    for (const contact of [contactId, ...spareContacts]) {
      await dropContactAuthGrant(
        appDb,
        { tenantId, agentId, contactId: contact },
        { refusedAt: Date.now() },
      );
    }
    expect(knownContactCount()).toBeGreaterThan(1);
    for (let i = 0; i < 40 && knownContactCount() > 1; i++) {
      await Bun.sleep(25);
    }
    // Back to the cap, without another refusal having arrived.
    expect(knownContactCount()).toBe(1);
  });

  test("an older refusal finishing late does not overwrite a newer one", async () => {
    const key = { tenantId, agentId, contactId };
    const t1 = Date.now() - 3000;
    const t2 = Date.now() - 2000;
    const t3 = Date.now() - 1000;
    // Three overlapping checks, played out through the two writers directly: the newest refusal
    // lands first, the oldest lands after it, and an allow asked between them arrives last.
    await dropContactAuthGrant(appDb, key, { refusedAt: t3 });
    await dropContactAuthGrant(appDb, key, { refusedAt: t1 });
    await writeContactAuthGrant(
      appDb,
      key,
      {
        identityHash: "x",
        policyHash: "y",
        context: null,
        ttlSeconds: 3600,
      },
      { askedAt: t2 },
    );
    // What is remembered is the LATEST refusal known, not the last one recorded, so the allow from
    // t2 is still older than the refusal from t3 and is not stored.
    expect(await grants()).toHaveLength(0);
  });

  test("a grant that expires while its own read is in flight is not served", async () => {
    const ep = endpoint(allowed, allowed);
    await ask({ cfg: cfg(), ...ep });
    await suDb.contactAuthGrant.updateMany({
      where: { tenantId, agentId },
      data: { expiresAt: new Date(Date.now() + 250) },
    });
    // The row is live when the query starts and dead when it comes back. The TTL is a promise about
    // the moment the verdict is SERVED, so the clock that decides is the one read after the await.
    const verdict = await ask({
      cfg: cfg(),
      fetchImpl: ep.fetchImpl,
      base: baseWithGrantHook(appDb, (m, delegate) =>
        m === "findUnique"
          ? async (...args: unknown[]) => {
              const row = await delegate.findUnique(...args);
              await Bun.sleep(500);
              return row;
            }
          : undefined,
      ),
    });
    expect(verdict.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(2);
  });

  test("the retry of an unconfirmed write spends the gate's budget, not more", async () => {
    const ep = endpoint(allowed, denied, allowed);
    await ask({ cfg: cfg(), ...ep });
    const failingDelete = baseWithGrantHook(appDb, (m) =>
      m === "deleteMany"
        ? () => {
            throw new Error("delete is down");
          }
        : undefined,
    );
    await ask({
      cfg: cfg({ mode: "perMessage" }),
      fetchImpl: ep.fetchImpl,
      base: failingDelete,
    });
    expect(unconfirmedWriteCount()).toBe(1);
    // The retry runs BEFORE the answer, so it is inside the budget like the stored-verdict read.
    // Left outside it, a pool in trouble adds the scoped transaction's own maxWait and timeout on
    // top of a gate configured for one second.
    const before = Date.now();
    const verdict = await ask({
      cfg: cfg({ timeoutMs: 1000 }),
      fetchImpl: ep.fetchImpl,
      base: baseWithGrantHook(appDb, (m) =>
        m === "deleteMany"
          ? async () => {
              await Bun.sleep(5000);
              return { count: 0 };
            }
          : undefined,
      ),
    });
    expect(Date.now() - before).toBeLessThan(2500);
    expect(verdict.outcome).toBe("error");
    expect(verdict.reason).toBe("timeout");
  });

  test("a credential rotated or deleted since the grant is not reused", async () => {
    const ep = endpoint(allowed, allowed, allowed);
    const withCred = (over = {}) => cfg({ credentialRef, ...over });
    await ask({ cfg: withCred(), ...ep });
    // Control: the same credential, untouched, and the verdict is reused.
    expect((await ask({ cfg: withCred(), ...ep })).reused).toBe(true);
    expect(ep.calls).toHaveLength(1);

    // `credentialRef` is a stable id, so rotating the secret behind it leaves the policy
    // fingerprint matching a verdict obtained with a key the operator has replaced.
    await suDb.vaultEntry.update({
      where: { id: credentialId },
      data: { secret: encryptJson("ROTATED") },
    });
    const afterRotation = await ask({ cfg: withCred(), ...ep });
    expect(afterRotation.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(2);

    // Deleting it is the sharp case: a fresh check fails closed on an unreadable credential, and a
    // stored verdict skips that check entirely — so a gate the operator disarmed by removing its key
    // would go on serving contacts for the rest of the TTL.
    await suDb.contactAuthGrant.deleteMany({ where: { tenantId } });
    await ask({ cfg: withCred(), ...ep });
    await suDb.vaultEntry.delete({ where: { id: credentialId } });
    const afterDeletion = await ask({ cfg: withCred(), ...ep });
    expect(afterDeletion.reused).toBeFalsy();
    expect(afterDeletion.outcome).toBe("error");
    expect(afterDeletion.reason).toBe("credential_unavailable");
    // Restored for the tests that follow this one in the file.
    const again = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "auth-key-2",
        kind: "bearer_token",
        secret: encryptJson("AUTH-SECRET"),
      },
      select: { id: true },
    });
    credentialId = again.id;
    credentialRef = `vault:${again.id}`;
  });

  test("eviction walks past a delete this process still owes", async () => {
    // The spare contacts are REFUSED, because a refusal is what writes an entry at all: an allow
    // under perMessage stores nothing and remembers nothing, so a version of this test built on
    // allows never fills the map and never evicts anything.
    const ep = endpoint(allowed, denied, denied, denied, denied);
    await ask({ cfg: cfg(), ...ep });
    await ask({
      cfg: cfg({ mode: "perMessage" }),
      fetchImpl: ep.fetchImpl,
      base: baseWithGrantHook(appDb, (m) =>
        m === "deleteMany"
          ? () => {
              throw new Error("delete is down");
            }
          : undefined,
      ),
    });
    expect(unconfirmedWriteCount()).toBe(1);

    // Ordinary traffic from other contacts, against a cap small enough to force eviction. A debt is
    // not an ordinary entry: evicted, the next check of THAT contact skips the retry and serves the
    // positive row the refusal never managed to remove.
    setMaxTrackedContactsForTest(2);
    for (const contact of spareContacts) {
      await ask({ cfg: cfg({ mode: "perMessage" }), contact, ...ep });
    }
    expect(unconfirmedWriteCount()).toBe(1);
  });

  test("a credential revision nobody could read is not a fingerprint", async () => {
    const ep = endpoint(allowed, allowed);
    const blindToTheVault = baseWithGrantHook(appDb, (m, _delegate, model) =>
      model === "vaultEntry" && m === "findUnique"
        ? () => {
            throw new Error("vault read is down");
          }
        : undefined,
    );
    // A verdict obtained while the credential's revision could not be read is a verdict with no
    // fingerprint that can be trusted to change when the credential does. Any constant standing in
    // for "unreadable" REPEATS, so the grant would match the next check made under the same blip —
    // and a rotation between the two would go unnoticed. Nothing is stored...
    const first = await ask({
      cfg: cfg({ credentialRef }),
      fetchImpl: ep.fetchImpl,
      base: blindToTheVault,
    });
    expect(first.outcome).toBe("allowed");
    expect(await grants()).toHaveLength(0);
    // ...and nothing is served, so the endpoint is asked again.
    const second = await ask({
      cfg: cfg({ credentialRef }),
      fetchImpl: ep.fetchImpl,
      base: blindToTheVault,
    });
    expect(second.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(2);
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

  test("the TTL changing re-asks", async () => {
    const ep = endpoint(allowed, allowed);
    await ask({ cfg: cfg({ grantTtlSeconds: 3600 }), ...ep });
    const second = await ask({ cfg: cfg({ grantTtlSeconds: 1800 }), ...ep });
    expect(second.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(2);
  });

  // A POLICY CHANGE IS A MATCH RULE, NOT A CLEAR. Stated as a fact, because the tempting reading of
  // the four re-ask cases above is "so nudging a field is how I drop the stored verdicts", and it is
  // not. The fingerprint is a pure function of the policy: change a field and the grants stop
  // matching, put it back and they match again.
  test("a fingerprint restored is a fingerprint that matches again", () => {
    const before = contactAuthPolicyHash(cfg({ grantTtlSeconds: 3600 }));
    const nudged = contactAuthPolicyHash(cfg({ grantTtlSeconds: 1800 }));
    const restored = contactAuthPolicyHash(cfg({ grantTtlSeconds: 3600 }));
    expect(nudged).not.toBe(before);
    expect(restored).toBe(before);
  });

  test("nudging a field and putting it back clears nothing", async () => {
    const ep = endpoint(allowed, allowed);
    await ask({ cfg: cfg({ grantTtlSeconds: 3600 }), ...ep });
    // The round trip as an operator would perform it: two saves, and no message in between. Nothing
    // read a grant while the nudged value stood, so nothing happened to any of them, and the very
    // next message is served from the verdict the nudge was supposed to have dropped.
    const after = await ask({ cfg: cfg({ grantTtlSeconds: 3600 }), ...ep });
    expect(after.reused).toBe(true);
    expect(ep.calls).toHaveLength(1);
  });

  test("a message DURING the nudge moves the grant, it does not drop it", async () => {
    const ep = endpoint(allowed, allowed, allowed);
    await ask({ cfg: cfg({ grantTtlSeconds: 3600 }), ...ep });
    // A contact who writes while the nudged value stands is re-asked, and that ask REPLACES the row
    // with one written under the nudged policy — so restoring the original value invalidates it in
    // turn. Either way the operator does not get a clear: they get a grant under whichever policy
    // was in force when the contact last wrote.
    const during = await ask({ cfg: cfg({ grantTtlSeconds: 1800 }), ...ep });
    expect(during.reused).toBeFalsy();
    expect(await grants()).toHaveLength(1);
    const restored = await ask({ cfg: cfg({ grantTtlSeconds: 3600 }), ...ep });
    expect(restored.reused).toBeFalsy();
    expect(ep.calls).toHaveLength(3);
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
