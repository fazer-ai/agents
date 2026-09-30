import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadAgentConfig } from "@/graph/prepare";
import { buildCodeTool } from "@/graph/tools/code";
import { buildHttpTool } from "@/graph/tools/http";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { mirroredContactIdentifier } from "@/modules/chatwoot/contact-identifier";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { normalizeToolShapes } from "@/modules/tool-definitions/normalize";
import { seedChatwootInstance } from "../utils/chatwoot";

// The Chatwoot contact `identifier`, from the webhook through the contact mirror to the variables
// an HTTP tool's placeholders and a code tool's `context` read.

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
const CONV_ID = 8100;
const CONTACT_ID = 5100;

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

async function toolContext(convId = CONV_ID): Promise<Record<string, string>> {
  const loaded = await runScopedOn(appDb, ctx(tenantId), (db) =>
    loadAgentConfig(db, {
      tenantId,
      instanceId,
      conversationId: convId,
      agentId,
      threadId: `${tenantId}:${instanceId}:${convId}`,
    }),
  );
  if (!loaded) throw new Error("agent config did not load");
  return loaded.httpToolContext;
}

// `identifier` is left out of the contact when the argument is undefined, the way the normalizer
// leaves out a field the payload does not state.
function event(
  at: number,
  identifier: string | null | undefined,
  opts: { convId?: number; contactId?: number } = {},
): NormalizedChatwootEvent {
  return {
    event: "conversation_updated",
    conversationId: opts.convId ?? CONV_ID,
    contactInboxId: null,
    inboxId: null,
    status: "pending",
    assigneeType: null,
    assigneeId: null,
    assigneeName: null,
    contact: {
      id: opts.contactId ?? CONTACT_ID,
      name: "Joana",
      ...(identifier !== undefined ? { identifier } : {}),
    },
    inboxName: null,
    channel: null,
    lastActivityAt: at,
  };
}

describe.skipIf(!dbUp)("contact_identifier in the tool context", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CI", slug: `ci-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
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

  test("follows the mirrored identifier: stated, absent, cleared, and an older event after the clear", async () => {
    const t0 = Math.floor(Date.now() / 1000);

    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(t0, "cli-4821"),
      appDb,
    );
    expect((await toolContext()).contact_identifier).toBe("cli-4821");

    // A payload that does not state the identifier keeps the stored one.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(t0 + 60, undefined),
      appDb,
    );
    expect((await toolContext()).contact_identifier).toBe("cli-4821");

    // A stated null clears it, and the key is ABSENT, like contact_email for a contact without one.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(t0 + 120, null),
      appDb,
    );
    expect(Object.hasOwn(await toolContext(), "contact_identifier")).toBe(
      false,
    );

    // An event Chatwoot built before the clear, delivered after it, does not bring it back.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(t0 + 90, "cli-4821"),
      appDb,
    );
    expect(Object.hasOwn(await toolContext(), "contact_identifier")).toBe(
      false,
    );
  });

  test("an identifier that is only whitespace is absent, as the contact authorization gate reads it", async () => {
    const convId = CONV_ID + 1;
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(Math.floor(Date.now() / 1000), "   ", {
        convId,
        contactId: CONTACT_ID + 1,
      }),
      appDb,
    );
    expect(Object.hasOwn(await toolContext(convId), "contact_identifier")).toBe(
      false,
    );
  });

  test("the identifier is trimmed the way the contact authorization gate reads it", async () => {
    const convId = CONV_ID + 2;
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(Math.floor(Date.now() / 1000), " cli-77 ", {
        convId,
        contactId: CONTACT_ID + 2,
      }),
      appDb,
    );
    expect((await toolContext(convId)).contact_identifier).toBe("cli-77");
  });

  test("an HTTP tool sends it in the header and the query, and a code tool reads it", async () => {
    const convId = CONV_ID + 3;
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(Math.floor(Date.now() / 1000), "cli-9001", {
        convId,
        contactId: CONTACT_ID + 3,
      }),
      appDb,
    );
    const context = await toolContext(convId);
    const sent = await callHttpTool(context);
    expect(sent.headers["X-Customer"]).toBe("cli-9001");
    expect(new URL(sent.url).searchParams.get("id")).toBe("cli-9001");
    expect(await callCodeTool(context)).toEqual({ id: "cli-9001" });
  });

  test("a contact without one gets what a contact without an e-mail gets", async () => {
    const convId = CONV_ID + 4;
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      event(Math.floor(Date.now() / 1000), null, {
        convId,
        contactId: CONTACT_ID + 4,
      }),
      appDb,
    );
    const context = await toolContext(convId);
    const sent = await callHttpTool(context);
    expect(sent.headers["X-Customer"]).toBe(sent.headers["X-Email"]);
    expect(sent.url).not.toContain("contact_identifier");
    expect(Object.values(sent.headers).join(" ")).not.toContain("{{");
    expect(await callCodeTool(context)).toEqual({ id: null });
  });
});

async function callHttpTool(context: Record<string, string>) {
  let url = "";
  let headers: Record<string, string> = {};
  const tool = buildHttpTool(
    {
      name: "lookup",
      method: "GET",
      urlTemplate: "https://8.8.8.8/v1/customers",
      allowedHosts: ["8.8.8.8"],
      query: { id: "{{contact_identifier}}" },
      headers: {
        "X-Customer": "{{contact_identifier}}",
        "X-Email": "{{contact_email}}",
      },
      inputSchema: {},
      credentialRef: null,
    },
    {
      resolveCredential: async () => null,
      context,
      fetchImpl: (async (u: string, init: RequestInit) => {
        url = u;
        headers = init.headers as Record<string, string>;
        return new Response('{"ok":true}', {
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    },
  );
  await tool.invoke({});
  return { url, headers };
}

async function callCodeTool(context: Record<string, string>) {
  const tool = buildCodeTool(
    {
      name: "who",
      description: "d",
      inputSchema: {},
      code: "return { id: context.contact_identifier ?? null };",
    },
    { context },
  );
  return JSON.parse(String(await tool.invoke({})).replace(/^Result: /, ""));
}

describe("contact_identifier as a tool template name", () => {
  test("a single-brace {contact_identifier} is rewritten and raises no unknown-placeholder warning", () => {
    const { shapes, warnings } = normalizeToolShapes({
      headers: { "X-Customer": "{contact_identifier}" },
    });
    expect(shapes.headers).toEqual({ "X-Customer": "{{contact_identifier}}" });
    expect(warnings.join("\n")).not.toContain("contact_identifier");
  });
});

describe("mirroredContactIdentifier", () => {
  test("null for a bag without a usable identifier, the trimmed string otherwise", () => {
    expect(mirroredContactIdentifier({ identifier: "   " })).toBeNull();
    expect(mirroredContactIdentifier({ identifier: "" })).toBeNull();
    expect(mirroredContactIdentifier({ identifier: 42 })).toBeNull();
    expect(mirroredContactIdentifier({})).toBeNull();
    expect(mirroredContactIdentifier(null)).toBeNull();
    expect(mirroredContactIdentifier(["cli-1"])).toBeNull();
    expect(mirroredContactIdentifier({ identifier: " cli-1 " })).toBe("cli-1");
  });
});
