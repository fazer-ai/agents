import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { buildToolset, loadAgentConfig } from "@/graph/prepare";
import { buildNativeTools } from "@/graph/tools/native";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { getAgentToolSelections } from "@/modules/agents/service";
import { buildContactFieldsSection } from "@/modules/chatwoot/attributes";
import { ChatwootApiError, ChatwootClient } from "@/modules/chatwoot/client";
import {
  type ContactFieldsConfig,
  readContactFieldsConfig,
} from "@/modules/chatwoot/contact-fields";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { seedChatwootInstance } from "../utils/chatwoot";

// The agent's view of the contact's standard Chatwoot fields and the update_contact tool: the
// per-agent selection, the schema built from it, the write and its refusals, the prompt block, and
// the mirror that feeds the block on both sides of a write.

function recordingClient(fail?: Error) {
  const calls: unknown[][] = [];
  const client = {
    updateContact: async (...args: unknown[]) => {
      // NOTE: The contact id and the fields; the third argument is the queue's fence.
      calls.push(args.slice(0, 2));
      if (fail) throw fail;
      return {};
    },
  } as unknown as ChatwootClient;
  return { client, calls };
}

function fakeContactDb(chatwootContactId: number): PrismaClient {
  const tx = {
    $executeRaw: async () => 0,
    contact: { findUnique: async () => ({ chatwootContactId }) },
  };
  return {
    $extends: () => ({
      $transaction: (fn: (t: unknown) => unknown) => fn(tx),
    }),
  } as unknown as PrismaClient;
}

function toolFor(
  contactFields: ContactFieldsConfig,
  client: ChatwootClient,
  base: PrismaClient = fakeContactDb(321),
  contactDbId = 7n,
  tenant = 1n,
): StructuredToolInterface | undefined {
  return buildNativeTools({
    client,
    conversationId: 42,
    tenantId: tenant,
    contactDbId,
    base,
    contactFields,
  }).find((t) => t.name === "update_contact");
}

// Invoked as the graph does, with a tool_call in scope, so a failure comes back as the ToolMessage
// the flow logger reads (status "error") and not as the bare string a direct call degrades to.
async function call(
  t: StructuredToolInterface,
  args: Record<string, unknown>,
): Promise<ToolMessage> {
  const out = await t.invoke({
    id: "call_1",
    name: "update_contact",
    args,
    type: "tool_call",
  });
  expect(out).toBeInstanceOf(ToolMessage);
  return out as ToolMessage;
}

describe("the per-agent selection", () => {
  test("anything malformed reads as nothing selected", () => {
    for (const settings of [
      undefined,
      null,
      {},
      { contactFields: null },
      { contactFields: [] },
      { contactFields: "name" },
      { contactFields: { context: "name", writable: "name" } },
    ]) {
      expect(readContactFieldsConfig(settings)).toEqual({
        context: [],
        writable: [],
      });
    }
  });

  test("unknown names are dropped, phone and identifier among them, and the order is the catalog's", () => {
    expect(
      readContactFieldsConfig({
        contactFields: {
          context: ["city", "phone_number", "identifier", "name", "city", 3],
          writable: ["city", "phone_number", "identifier"],
        },
      }),
    ).toEqual({ context: ["name", "city"], writable: ["city"] });
  });

  test("a writable field the agent does not see is not writable", () => {
    expect(
      readContactFieldsConfig({
        contactFields: { context: ["name"], writable: ["name", "email"] },
      }),
    ).toEqual({ context: ["name"], writable: ["name"] });
  });
});

describe("update_contact", () => {
  test("is not built when no field is writable, even with fields in context", () => {
    const { client } = recordingClient();
    expect(
      toolFor({ context: ["name", "email"], writable: [] }, client),
    ).toBeUndefined();
  });

  test("its schema offers exactly the writable fields, and carries no pattern a provider rejects", () => {
    const { client } = recordingClient();
    const t = toolFor(
      { context: ["name", "email", "city"], writable: ["name", "city"] },
      client,
    );
    if (!t) throw new Error("update_contact was not built");
    const json = z.toJSONSchema(t.schema as z.ZodTypeAny) as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(json.properties).sort()).toEqual(["city", "name"]);
    expect(JSON.stringify(json)).not.toContain("\\p{L}");
  });

  test("one PUT with only the fields written, whitespace collapsed, the additional ones nested", async () => {
    const { client, calls } = recordingClient();
    const t = toolFor(
      {
        context: ["name", "email", "city", "country"],
        writable: ["name", "email", "city", "country"],
      },
      client,
    );
    if (!t) throw new Error("update_contact was not built");
    const out = await call(t, {
      name: "  Mariana   Almeida ",
      city: " Recife ",
    });
    expect(out.status).not.toBe("error");
    expect(calls).toEqual([
      [
        321,
        { name: "Mariana Almeida", additional_attributes: { city: "Recife" } },
      ],
    ]);
  });

  test("a name with no letter, a phone-shaped name and a malformed email write nothing and come back as a failure", async () => {
    for (const [args, reason] of [
      [{ name: "!!! ???" }, "at least one letter"],
      [{ name: "+55 (11) 99999-0000" }, "phone number"],
      [{ email: "joana arroba exemplo" }, "not an email"],
      [{ name: "Joana", email: "nope" }, "not an email"],
      [{}, "pass at least one"],
    ] as const) {
      const { client, calls } = recordingClient();
      const t = toolFor(
        { context: ["name", "email"], writable: ["name", "email"] },
        client,
      );
      if (!t) throw new Error("update_contact was not built");
      const out = await call(t, args);
      expect({ args, status: out.status }).toEqual({ args, status: "error" });
      expect(String(out.content)).toContain(reason);
      expect(calls).toEqual([]);
    }
  });

  test("a write Chatwoot refuses is a failed tool line, and the mirror is not touched", async () => {
    let mirrored = 0;
    const tx = {
      $executeRaw: async (sql: TemplateStringsArray) => {
        if (sql.join("").includes("UPDATE contacts")) mirrored += 1;
        return 1;
      },
      contact: { findUnique: async () => ({ chatwootContactId: 321 }) },
    };
    const base = {
      $extends: () => ({
        $transaction: (fn: (t: unknown) => unknown) => fn(tx),
      }),
    } as unknown as PrismaClient;
    const { client, calls } = recordingClient(
      new ChatwootApiError(422, "contacts/321"),
    );
    const t = toolFor(
      { context: ["email"], writable: ["email"] },
      client,
      base,
    );
    if (!t) throw new Error("update_contact was not built");
    const out = await call(t, { email: "joana@exemplo.com" });
    expect(out.status).toBe("error");
    expect(String(out.content)).toContain("422");
    expect(calls).toHaveLength(1);
    expect(mirrored).toBe(0);
  });

  test("a server error is not dressed up as a refusal", async () => {
    const { client } = recordingClient(
      new ChatwootApiError(503, "contacts/321"),
    );
    const t = toolFor({ context: ["name"], writable: ["name"] }, client);
    if (!t) throw new Error("update_contact was not built");
    await expect(call(t, { name: "Joana" })).rejects.toThrow("503");
  });
});

test("two writes to one contact in the same turn go out one after the other", async () => {
  const events: string[] = [];
  let first = true;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    const tag = Object.keys(body).sort().join("+");
    events.push(`start ${tag}`);
    if (first) {
      first = false;
      await new Promise((r) => setTimeout(r, 40));
    }
    events.push(`end ${tag}`);
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new ChatwootClient(
    {
      baseUrl: "https://chat.example.com",
      accountId: 5,
      adminToken: "admin",
      botToken: "bot",
    },
    fetchImpl,
  );
  const t = toolFor(
    { context: ["name", "city"], writable: ["name", "city"] },
    client,
  );
  if (!t) throw new Error("update_contact was not built");
  await Promise.all([call(t, { city: "Recife" }), call(t, { name: "Joana" })]);
  expect(events).toEqual([
    "start additional_attributes",
    "end additional_attributes",
    "start name",
    "end name",
  ]);
});

describe("the prompt block", () => {
  test("lists the selected fields in catalog order, flags the empty ones and the writable ones", () => {
    const section = buildContactFieldsSection(
      { name: "Joana", email: null, city: "Recife" },
      { context: ["name", "email", "city"], writable: ["email"] },
    );
    expect(section).toContain('<field key="name" value="Joana"/>');
    expect(section).toContain(
      '<field key="email" writable="yes" filled="no"/>',
    );
    expect(section).toContain('<field key="city" value="Recife"/>');
    expect(section).toContain("update_contact");
  });

  test("a stored value is data: escaped, and a {{var}} in it stays literal", () => {
    const section = buildContactFieldsSection(
      { name: 'Jo "<b>" {{nome_contato}}' },
      { context: ["name"], writable: [] },
    ) as string;
    expect(section).toContain("{{nome_contato}}");
    expect(section).toContain("&quot;&lt;b&gt;&quot;");
    expect(section).toContain("NÃO tem ferramenta");
  });

  test("nothing selected, no block", () => {
    expect(
      buildContactFieldsSection(
        { name: "Joana" },
        { context: [], writable: [] },
      ),
    ).toBeNull();
  });
});

describe("the normalizer", () => {
  const payload = (sender: Record<string, unknown>) =>
    normalizeChatwootEvent({
      event: "conversation_updated",
      id: 1,
      status: "pending",
      inbox_id: 2,
      meta: { sender: { id: 9, name: "Joana", ...sender } },
    });

  test("reads the four additional fields, a missing one as null", () => {
    expect(
      payload({
        additional_attributes: {
          city: "Recife",
          company_name: "ACME",
          country_code: "BR",
          social_profiles: {},
        },
      })?.contact?.additionalAttributes,
    ).toEqual({
      company_name: "ACME",
      city: "Recife",
      country: null,
      description: null,
    });
  });

  test("a payload without the bag states nothing about them", () => {
    expect(payload({})?.contact?.additionalAttributes).toBeUndefined();
  });
});

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
let agentId = 0n;
const CONV_ID = 8200;
const CONTACT_ID = 5200;

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

function event(
  at: number,
  contact: Partial<NonNullable<NormalizedChatwootEvent["contact"]>>,
): NormalizedChatwootEvent {
  return {
    event: "conversation_updated",
    conversationId: CONV_ID,
    contactInboxId: null,
    inboxId: null,
    status: "pending",
    assigneeType: null,
    assigneeId: null,
    assigneeName: null,
    contact: { id: CONTACT_ID, ...contact },
    inboxName: null,
    channel: null,
    lastActivityAt: at,
  };
}

async function contactRow() {
  return suDb.contact.findFirstOrThrow({
    where: { tenantId, chatwootContactId: CONTACT_ID },
    select: {
      id: true,
      name: true,
      email: true,
      attributes: true,
      additionalAttributes: true,
      nameAt: true,
    },
  });
}

describe.skipIf(!dbUp)("the mirror and the write-through", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "UC", slug: `uc-${process.pid}` },
    });
    tenantId = t.id;
    instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 1,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      })
    ).id;
    const keyId = (
      await suDb.vaultEntry.create({
        data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
        select: { id: true },
      })
    ).id;
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Agente",
          systemPrompt: "Você é um assistente.",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${keyId}`,
          },
          settings: {
            contactFields: {
              context: ["name", "email", "city"],
              writable: ["name", "city"],
            },
          },
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (dbUp && tenantId) {
      await suDb.tenant.delete({ where: { id: tenantId } });
    }
    await app?.$disconnect();
    await su?.$disconnect();
  });

  test("the additional fields keep their own position, so out of order neither hides the other", async () => {
    const t0 = Math.floor(Date.now() / 1000) - 3600;
    const extra = (company: string | null, city: string | null) => ({
      company_name: company,
      city,
      country: null,
      description: null,
    });
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(t0, {
        name: "Joana",
        identifier: "cli-1",
        additionalAttributes: extra(null, "Recife"),
      }),
      appDb,
    );
    let row = await contactRow();
    expect(row.attributes).toEqual({ identifier: "cli-1" });
    expect(row.additionalAttributes).toEqual({ city: "Recife" });

    // A newer event about the company alone.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(t0 + 20, { additionalAttributes: extra("ACME", null) }),
      appDb,
    );
    // A clear of the identifier built between the two, delivered late: it still lands.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(t0 + 10, { identifier: null }),
      appDb,
    );
    row = await contactRow();
    expect(row.attributes).toEqual({});
    expect(row.additionalAttributes).toEqual({ company_name: "ACME" });

    // Older than both: changes nothing.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(t0 + 5, {
        identifier: "cli-1",
        additionalAttributes: extra(null, "Recife"),
      }),
      appDb,
    );
    row = await contactRow();
    expect(row.attributes).toEqual({});
    expect(row.additionalAttributes).toEqual({ company_name: "ACME" });
  });

  test("turn prep shows the selected fields and builds the tool over the writable ones", async () => {
    const loaded = await runScopedOn(appDb, ctx(tenantId), (db) =>
      loadAgentConfig(db, {
        tenantId,
        instanceId,
        conversationId: CONV_ID,
        agentId,
        threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
      }),
    );
    if (!loaded) throw new Error("agent config did not load");
    expect(loaded.systemPrompt).toContain(
      '<field key="name" writable="yes" value="Joana"/>',
    );
    expect(loaded.systemPrompt).toContain('<field key="email" filled="no"/>');
    expect(loaded.systemPrompt).toContain(
      '<field key="city" writable="yes" filled="no"/>',
    );
    expect(loaded.contactFieldsConfig).toEqual({
      context: ["name", "email", "city"],
      writable: ["name", "city"],
    });
    let seen: Record<string, unknown> | undefined;
    await buildToolset(
      loaded,
      {
        tenantId,
        instanceId,
        base: appDb,
        client: {} as unknown as ChatwootClient,
        conversationId: CONV_ID,
        threadId: `t-${process.pid}`,
      },
      {
        buildNativeTools: (native) => {
          seen = native as unknown as Record<string, unknown>;
          return [];
        },
      },
    );
    expect(seen?.contactFields).toEqual({
      context: ["name", "email", "city"],
      writable: ["name", "city"],
    });
  });

  test("a write reaches the mirror at once, and a snapshot from before it does not undo it", async () => {
    const row = await contactRow();
    const { client, calls } = recordingClient();
    const t = toolFor(
      { context: ["name", "city"], writable: ["name", "city"] },
      client,
      appDb,
      row.id,
      tenantId,
    );
    if (!t) throw new Error("update_contact was not built");
    const out = await call(t, { name: "Joana Lima", city: "Olinda" });
    expect(out.status).not.toBe("error");
    expect(calls).toEqual([
      [
        CONTACT_ID,
        { name: "Joana Lima", additional_attributes: { city: "Olinda" } },
      ],
    ]);
    const after = await contactRow();
    expect(after.name).toBe("Joana Lima");
    expect(after.additionalAttributes).toEqual({
      company_name: "ACME",
      city: "Olinda",
    });
    expect(after.attributes).toEqual(row.attributes);
    expect(after.nameAt?.getTime() ?? 0).toBeGreaterThan(
      row.nameAt?.getTime() ?? 0,
    );

    // A delivery Chatwoot built a minute before the write, still carrying the old values.
    const before = Math.floor(Date.now() / 1000) - 60;
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(before, {
        name: "Joana",
        additionalAttributes: {
          company_name: "ACME",
          city: null,
          country: null,
          description: null,
        },
      }),
      appDb,
    );
    const later = await contactRow();
    expect(later.name).toBe("Joana Lima");
    expect((later.additionalAttributes as Record<string, unknown>).city).toBe(
      "Olinda",
    );
  });
  test("the grant catalog offers no toggle for update_contact, whose grant is the writable field", async () => {
    const view = await getAgentToolSelections(ctx(tenantId), agentId, appDb);
    const names = view.catalog.native.map((n) => n.name);
    expect(names).toContain("set_custom_attribute");
    expect(names).not.toContain("update_contact");
  });

  test("a tie that disputes one field clears that field only", async () => {
    const at = Math.floor(Date.now() / 1000) + 3600;
    const additional = (city: string) => ({
      company_name: "ACME",
      city,
      country: null,
      description: null,
    });
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(at, {
        identifier: "cli-9",
        additionalAttributes: additional("Natal"),
      }),
      appDb,
    );
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(at, {
        identifier: "cli-9",
        additionalAttributes: additional("Recife"),
      }),
      appDb,
    );
    const row = await contactRow();
    expect(row.attributes).toEqual({ identifier: "cli-9" });
    expect(row.additionalAttributes).toEqual({ company_name: "ACME" });
  });
});
