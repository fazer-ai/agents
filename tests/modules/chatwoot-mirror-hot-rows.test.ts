import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { seedChatwootInstance } from "../utils/chatwoot";

// The inbox and contact rows every delivery of a busy inbox names: an unchanged one is not written,
// and nothing holds their locks while a delivery waits on its conversation.

// A write is detected by the row's `xmin`: every UPDATE, including an `ON CONFLICT DO UPDATE` that
// sets the same values, leaves a new tuple version. The statistics counters flush asynchronously and
// would make these tests timing-dependent; the xmin is exact.

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
let instanceId = 0n;

const T0 = 1_790_000_000; // a fixed source instant, in Chatwoot's epoch seconds

interface EventSpec {
  convId: number;
  messageId: number;
  at: number; // source position (last_activity_at and updated_at)
  inboxId?: number;
  inboxName?: string;
  channel?: string;
  contact?: {
    id: number;
    name?: string;
    email?: string;
    phone?: string;
    identifier?: string;
    city?: string;
    plan?: string;
  };
}

function event(spec: EventSpec): NormalizedChatwootEvent {
  const inboxId = spec.inboxId ?? 31;
  const contact = spec.contact ?? { id: 7_000 + spec.convId };
  const sender: Record<string, unknown> = { id: contact.id, type: "contact" };
  if (contact.name !== undefined) sender.name = contact.name;
  if (contact.email !== undefined) sender.email = contact.email;
  if (contact.phone !== undefined) sender.phone_number = contact.phone;
  if (contact.identifier !== undefined) sender.identifier = contact.identifier;
  if (contact.city !== undefined)
    sender.additional_attributes = { city: contact.city };
  if (contact.plan !== undefined)
    sender.custom_attributes = { plan: contact.plan };
  const n = normalizeChatwootEvent({
    event: "message_created",
    id: spec.messageId,
    private: false,
    content: "oi",
    message_type: "incoming",
    sender,
    inbox: { id: inboxId, name: spec.inboxName ?? "Atendimento" },
    conversation: {
      id: spec.convId,
      inbox_id: inboxId,
      status: "pending",
      contact_inbox: { id: 9_000 + spec.convId },
      meta: { assignee: null, sender },
      channel: spec.channel ?? "Channel::Whatsapp",
      last_activity_at: spec.at,
      updated_at: spec.at,
    },
  });
  if (!n) throw new Error("payload did not normalize");
  return n;
}

async function inboxRow(chatwootInboxId: number) {
  const rows = await suDb.$queryRaw<
    { xmin: string; name: string; channel_type: string | null }[]
  >`SELECT xmin::text AS xmin, name, channel_type FROM inboxes
    WHERE tenant_id = ${tenantId} AND chatwoot_instance_id = ${instanceId}
      AND chatwoot_inbox_id = ${chatwootInboxId}`;
  return rows;
}

async function contactRow(chatwootContactId: number) {
  const rows = await suDb.$queryRaw<
    {
      xmin: string;
      name: string | null;
      name_at: Date | null;
      email: string | null;
      email_at: Date | null;
    }[]
  >`SELECT xmin::text AS xmin, name, name_at, email, email_at FROM contacts
    WHERE tenant_id = ${tenantId} AND chatwoot_instance_id = ${instanceId}
      AND chatwoot_contact_id = ${chatwootContactId}`;
  return rows;
}

function mirror(n: NormalizedChatwootEvent) {
  return mirrorChatwootEvent(tenantId, instanceId, n, appDb);
}

// A client whose first natural-key read of the inbox answers with `fake(real row)`, the way a read
// taken before a concurrent delivery committed would. Every other call goes through.
function staleInboxRead(
  fake: (
    real: { id: bigint; name: string; channelType: string | null } | null,
  ) => unknown,
) {
  let pending = true;
  // biome-ignore lint/suspicious/noExplicitAny: proxying Prisma's client surface
  const wrap = (target: any): any =>
    new Proxy(target, {
      get(t, prop, recv) {
        if (prop === "$extends")
          return (...a: unknown[]) => wrap(t.$extends(...a));
        if (prop === "$transaction")
          return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
            t.$transaction((tx: unknown) => fn(wrap(tx)), ...rest);
        if (prop !== "inbox") return Reflect.get(t, prop, recv);
        const delegate = Reflect.get(t, prop, recv);
        return new Proxy(delegate, {
          get(d, k, r) {
            const inner = Reflect.get(d, k, r);
            if (k !== "findUnique") return inner;
            return async (args: { where?: Record<string, unknown> }) => {
              const real = await inner.call(d, args);
              if (
                !pending ||
                !args?.where?.tenantId_chatwootInstanceId_chatwootInboxId
              )
                return real;
              pending = false;
              return fake(real);
            };
          },
        });
      },
    });
  return wrap(appDb) as PrismaClient;
}

describe.skipIf(!dbUp)("the mirror's inbox and contact rows", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "MIRROR-HOT", slug: `mirror-hot-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 72,
      baseUrl: "https://chat.mirror-hot.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("an inbox whose name and channel did not change is not rewritten, sequentially or concurrently", async () => {
    await mirror(event({ convId: 101, messageId: 1, at: T0 }));
    const [before] = await inboxRow(31);
    expect(before?.name).toBe("Atendimento");

    for (let i = 0; i < 5; i++) {
      await mirror(event({ convId: 110 + i, messageId: 10 + i, at: T0 + i }));
    }
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        mirror(event({ convId: 120 + i, messageId: 20 + i, at: T0 + 10 + i })),
      ),
    );

    const after = await inboxRow(31);
    expect(after).toHaveLength(1);
    expect(after[0]?.xmin).toBe(before?.xmin);
    expect(after[0]?.name).toBe("Atendimento");
    expect(after[0]?.channel_type).toBe("Channel::Whatsapp");
  });

  test("a missing inbox created by many deliveries at once ends as one row, and none of them fails", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, i) =>
        mirror(
          event({
            convId: 200 + i,
            messageId: 200 + i,
            at: T0,
            inboxId: 32,
            inboxName: "Nova",
          }),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    const rows = await inboxRow(32);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Nova");
    const linked = await suDb.conversation.count({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: { gte: 200, lt: 216 },
        inbox: { chatwootInboxId: 32 },
      },
    });
    expect(linked).toBe(16);
  });

  test("a rename is written, and a delivery from before it does not undo it", async () => {
    await mirror(
      event({ convId: 301, messageId: 301, at: T0 + 100, inboxId: 33 }),
    );
    await mirror(
      event({
        convId: 302,
        messageId: 302,
        at: T0 + 200,
        inboxId: 33,
        inboxName: "Suporte",
      }),
    );
    const [renamed] = await inboxRow(33);
    expect(renamed?.name).toBe("Suporte");

    await mirror(
      event({
        convId: 303,
        messageId: 303,
        at: T0 + 300,
        inboxId: 33,
        inboxName: "Suporte",
        channel: "Channel::Api",
      }),
    );
    const [moved] = await inboxRow(33);
    expect(moved?.name).toBe("Suporte");
    expect(moved?.channel_type).toBe("Channel::Api");

    // Late: an event positioned before the rename, still carrying the old name and channel.
    await mirror(
      event({
        convId: 304,
        messageId: 304,
        at: T0 + 150,
        inboxId: 33,
        inboxName: "Atendimento",
      }),
    );
    const [late] = await inboxRow(33);
    expect(late?.name).toBe("Suporte");
    expect(late?.channel_type).toBe("Channel::Api");
    expect(late?.xmin).toBe(moved?.xmin);
  });

  test("a newer snapshot accepted over a stale read writes every field it states", async () => {
    // The row holds B/X at T0+20, but this delivery read A/X before that write landed.
    await mirror(
      event({
        convId: 310,
        messageId: 310,
        at: T0 + 10,
        inboxId: 35,
        inboxName: "A",
      }),
    );
    await mirror(
      event({
        convId: 311,
        messageId: 311,
        at: T0 + 20,
        inboxId: 35,
        inboxName: "B",
      }),
    );
    const stale = staleInboxRead((real) => real && { ...real, name: "A" });
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event({
        convId: 312,
        messageId: 312,
        at: T0 + 30,
        inboxId: 35,
        inboxName: "A",
        channel: "Channel::Api",
      }),
      stale,
    );
    const [row] = await inboxRow(35);
    expect(row?.name).toBe("A");
    expect(row?.channel_type).toBe("Channel::Api");
  });

  test("a delivery whose insert lost the race still applies its newer snapshot", async () => {
    await mirror(
      event({
        convId: 320,
        messageId: 320,
        at: T0 + 10,
        inboxId: 36,
        inboxName: "Velha",
      }),
    );
    // This delivery missed the row, as if it read before the other insert committed.
    const missed = staleInboxRead(() => null);
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event({
        convId: 321,
        messageId: 321,
        at: T0 + 20,
        inboxId: 36,
        inboxName: "Nova",
      }),
      missed,
    );
    const rows = await inboxRow(36);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Nova");
  });

  test("an inbox first seen by an event without its name takes the first real name, at any position", async () => {
    const n = normalizeChatwootEvent({
      event: "conversation_status_changed",
      id: 330,
      inbox_id: 37,
      status: "pending",
      contact_inbox: { id: 9_330 },
      meta: { assignee: null, sender: { id: 8_330, type: "contact" } },
      channel: "Channel::Whatsapp",
      last_activity_at: T0 + 50,
      updated_at: T0 + 50,
    });
    if (!n) throw new Error("payload did not normalize");
    expect(n.inboxName).toBeNull();
    await mirror(n);
    const [placeholder] = await inboxRow(37);
    expect(placeholder?.name).toBe("inbox 37");

    // A message positioned before the conversation event, carrying the inbox's real name.
    await mirror(
      event({
        convId: 331,
        messageId: 331,
        at: T0 + 40,
        inboxId: 37,
        inboxName: "Vendas",
      }),
    );
    const [named] = await inboxRow(37);
    expect(named?.name).toBe("Vendas");
  });

  test("a contact snapshot repeated at the same position writes nothing", async () => {
    const contact = {
      id: 501,
      name: "Ana",
      email: "ana@example.test",
      phone: "+5511999990001",
      identifier: "ana-1",
      city: "Recife",
      plan: "ouro",
    };
    await mirror(event({ convId: 401, messageId: 401, at: T0 + 500, contact }));
    const [before] = await contactRow(501);
    expect(before?.name).toBe("Ana");
    for (let i = 0; i < 4; i++) {
      await mirror(
        event({
          convId: 401,
          messageId: 402 + i,
          at: T0 + 500,
          contact,
        }),
      );
    }
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        mirror(
          event({ convId: 410 + i, messageId: 410 + i, at: T0 + 500, contact }),
        ),
      ),
    );
    const [after] = await contactRow(501);
    expect(after?.xmin).toBe(before?.xmin);
    expect(after?.name).toBe("Ana");
    expect(after?.name_at?.getTime()).toBe(before?.name_at?.getTime());
  });

  test("the same value at a newer position still moves the watermark, so a late snapshot cannot overwrite it", async () => {
    const id = 502;
    await mirror(
      event({
        convId: 450,
        messageId: 450,
        at: T0 + 10,
        contact: { id, name: "Ana" },
      }),
    );
    await mirror(
      event({
        convId: 450,
        messageId: 451,
        at: T0 + 30,
        contact: { id, name: "Ana" },
      }),
    );
    const [advanced] = await contactRow(id);
    expect(advanced?.name).toBe("Ana");
    expect(advanced?.name_at?.getTime()).toBe((T0 + 30) * 1000);

    await mirror(
      event({
        convId: 450,
        messageId: 452,
        at: T0 + 20,
        contact: { id, name: "Beatriz" },
      }),
    );
    const [late] = await contactRow(id);
    expect(late?.name).toBe("Ana");
    expect(late?.xmin).toBe(advanced?.xmin);
  });

  test("two values at one position empty the field once, and a third value at that position writes nothing", async () => {
    const id = 505;
    const at = T0 + 60;
    await mirror(
      event({ convId: 470, messageId: 470, at, contact: { id, name: "Ana" } }),
    );
    await mirror(
      event({ convId: 470, messageId: 471, at, contact: { id, name: "Bia" } }),
    );
    const [emptied] = await contactRow(id);
    expect(emptied?.name).toBeNull();
    expect(emptied?.name_at?.getTime()).toBe(at * 1000);

    await mirror(
      event({
        convId: 470,
        messageId: 472,
        at,
        contact: { id, name: "Carla" },
      }),
    );
    const [after] = await contactRow(id);
    expect(after?.name).toBeNull();
    expect(after?.xmin).toBe(emptied?.xmin);
  });

  test("a changed field is written under its own watermark and leaves the other field alone", async () => {
    const id = 503;
    await mirror(
      event({
        convId: 460,
        messageId: 460,
        at: T0 + 30,
        contact: { id, name: "Ana", email: "antigo@example.test" },
      }),
    );
    await mirror(
      event({
        convId: 460,
        messageId: 461,
        at: T0 + 40,
        contact: { id, email: "novo@example.test" },
      }),
    );
    const [row] = await contactRow(id);
    expect(row?.email).toBe("novo@example.test");
    expect(row?.email_at?.getTime()).toBe((T0 + 40) * 1000);
    expect(row?.name).toBe("Ana");
    expect(row?.name_at?.getTime()).toBe((T0 + 30) * 1000);
  });

  test("a delivery waiting on its conversation holds no inbox lock: the rename is visible and another conversation goes through", async () => {
    await mirror(
      event({ convId: 601, messageId: 601, at: T0 + 1000, inboxId: 34 }),
    );
    await mirror(
      event({ convId: 602, messageId: 602, at: T0 + 1000, inboxId: 34 }),
    );
    const threadKey = `${tenantId}:${instanceId}:601`;

    // A separate session holds conversation 601's serialization lock, the way a slow turn would.
    let release: () => void = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    let lockTaken: () => void = () => {};
    const taken = new Promise<void>((r) => {
      lockTaken = r;
    });
    const holder = suDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${threadKey})::bigint)`;
        lockTaken();
        await released;
      },
      { timeout: 30_000 },
    );
    await taken;

    const waiting = mirror(
      event({
        convId: 601,
        messageId: 603,
        at: T0 + 1100,
        inboxId: 34,
        inboxName: "Suporte",
      }),
    );
    try {
      // Give the waiting delivery time to reach the conversation lock.
      await Bun.sleep(400);
      const [visible] = await inboxRow(34);
      expect(visible?.name).toBe("Suporte");

      const other = await Promise.race([
        mirror(
          event({
            convId: 602,
            messageId: 604,
            at: T0 + 1101,
            inboxId: 34,
            inboxName: "Suporte",
          }),
        ).then(() => "done" as const),
        Bun.sleep(3_000).then(() => "blocked" as const),
      ]);
      expect(other).toBe("done");
    } finally {
      release();
      await holder;
      await waiting;
    }
    const [final] = await inboxRow(34);
    expect(final?.name).toBe("Suporte");
  });
});
