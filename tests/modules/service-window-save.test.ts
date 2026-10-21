import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { AppError } from "@/lib/errors";
import { createAgent, updateAgent } from "@/modules/agents/service";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentSettingsSet } from "@/modules/mcp/write";
import {
  assertServiceWindowTemplatesUsable,
  assertSettingsServiceWindow,
} from "@/modules/service-window/save";
import { parseTemplateDefinition } from "@/modules/service-window/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// The save judges a template choice against the inbox's synced templates (name, language and
// parameter counts), refuses the appointment's placeholders outside reminders, and never re-judges a
// block the write leaves as it was.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;

const TEMPLATES = [
  {
    name: "chatwoot_test",
    language: "pt_BR",
    category: "UTILITY",
    status: "APPROVED",
    components: [
      {
        type: "BODY",
        text: "Olá, {{1}}. Sua {{2}} em {{3}} leva {{4}} minutos.",
      },
      {
        type: "BUTTONS",
        buttons: [
          { type: "URL", text: "Feedback", url: "https://x.test/{{1}}" },
        ],
      },
    ],
  },
  {
    name: "rascunho",
    language: "pt_BR",
    status: "PENDING",
    components: [{ type: "BODY", text: "Oi" }],
  },
];

let tenantId = 0n;
let agentId = 0n;
let requests = 0;
const ctx = () => ({ tenantId, userId: null, role: "TENANT_ADMIN" as const });
const deps = {
  makeClient: async () =>
    ({
      listTemplateDefinitions: async () => {
        requests++;
        return TEMPLATES.filter((t) => t.status === "APPROVED").map((t) =>
          parseTemplateDefinition(t),
        );
      },
    }) as unknown as ChatwootClient,
};

const ok = {
  name: "chatwoot_test",
  language: "pt_BR",
  params: ["{{primeiro_nome}}", "visita", "loja", "5"],
  buttonParams: ["abc"],
};

async function refusal(p: Promise<unknown>): Promise<AppError | null> {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
}

describe.skipIf(!dbUp)("service-window templates at save", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SW", slug: `sw-save-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 5,
      baseUrl: "https://chat.sw-save.example",
      adminToken: encryptJson("ADMIN"),
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Lembretes",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        settings: {},
      },
    });
    agentId = agent.id;
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootInboxId: 18,
        name: "Validação WhatsApp",
        agentId,
      },
    });
  });

  afterAll(async () => {
    if (!dbUp) return;
    for (const table of [
      "audit_events",
      "inboxes",
      "agents",
      "chatwoot_instances",
      "chatwoot_deployments",
      "tenants",
    ]) {
      await suDb
        .$executeRawUnsafe(
          table === "tenants"
            ? `DELETE FROM tenants WHERE id = ${tenantId}`
            : `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        )
        .catch(() => {});
    }
    await suDb.$disconnect();
  });

  const check = (settings: unknown, stored: unknown = {}) =>
    assertServiceWindowTemplatesUsable(
      ctx(),
      agentId,
      settings,
      stored,
      deps,
      suDb,
    );

  test("a choice that matches the synced template passes", async () => {
    expect(
      await refusal(check({ serviceWindow: { templates: { followup: ok } } })),
    ).toBeNull();
  });

  test("a template the inbox does not have, or only has unapproved, is refused", async () => {
    for (const name of ["nao_existe", "rascunho"]) {
      const e = await refusal(
        check({
          serviceWindow: { templates: { followup: { ...ok, name } } },
        }),
      );
      expect(e?.statusCode).toBe(422);
      expect(e?.translationKey).toBe("errors.serviceWindowTemplateNotFound");
      expect(e?.message).toContain("serviceWindow.templates.followup");
    }
  });

  test("a language the template does not have is refused, naming the ones it has", async () => {
    const e = await refusal(
      check({
        serviceWindow: {
          templates: { followup: { ...ok, language: "en_US" } },
        },
      }),
    );
    expect(e?.translationKey).toBe("errors.serviceWindowTemplateLanguage");
    expect(e?.translationParams?.available).toBe("pt_BR");
  });

  test("a parameter count that differs from the template is refused, per component", async () => {
    const body = await refusal(
      check({
        serviceWindow: {
          templateName: "chatwoot_test",
          templateParams: ["a"],
          templateButtonParams: ["abc"],
        },
      }),
    );
    expect(body?.translationKey).toBe("errors.serviceWindowTemplateBodyCount");
    const button = await refusal(
      check({
        serviceWindow: {
          reminderTemplates: { "24": { ...ok, buttonParams: [] } },
        },
      }),
    );
    expect(button?.translationKey).toBe(
      "errors.serviceWindowTemplateButtonNeedsSuffix",
    );
  });

  test("a choice the write leaves as it was is not re-judged, and an untouched block reads nothing", async () => {
    const stored = {
      serviceWindow: { templates: { followup: { ...ok, name: "retirado" } } },
    };
    requests = 0;
    expect(await refusal(check(stored, stored))).toBeNull();
    expect(requests).toBe(0);
    expect(
      await refusal(
        check(
          { serviceWindow: { ...stored.serviceWindow, windowHours: 12 } },
          stored,
        ),
      ),
    ).toBeNull();
    expect(requests).toBe(0);
  });

  test("the appointment's placeholders are refused outside reminders, through the save itself", async () => {
    const e = await refusal(
      updateAgent(
        ctx(),
        agentId,
        {
          settings: {
            serviceWindow: {
              templates: {
                followup: {
                  ...ok,
                  params: ["{{data_agendamento}}", "b", "c", "d"],
                },
              },
            },
          },
        },
        suDb,
      ),
    );
    expect(e?.translationKey).toBe("errors.serviceWindowAppointmentVar");
    expect(e?.translationParams?.where).toBe(
      "serviceWindow.templates.followup",
    );
    const row = await suDb.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { settings: true },
    });
    expect(row.settings).toEqual({});
  });

  test("MCP refuses a malformed choice before its merge would drop it, in the preview and the apply", async () => {
    const principal: VerifiedToken = {
      userId: 1n,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
      clientId: "c",
      jti: "j",
    };
    for (const dry_run of [true, false]) {
      const r = await agentSettingsSet(
        principal,
        {
          agent_id: String(agentId),
          serviceWindow: { templates: { followup: { name: "" } } },
          dry_run,
        },
        { base: suDb },
      );
      expect(r.ok ? "" : r.error).toContain("serviceWindow.templates.followup");
    }
    const row = await suDb.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { settings: true },
    });
    expect(row.settings).toEqual({});
  });

  test("creating an agent applies the same rules", async () => {
    const e = await refusal(
      createAgent(
        ctx(),
        {
          name: "Criado com variável de agendamento",
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          settings: {
            serviceWindow: {
              templateName: "chatwoot_test",
              templateParams: ["{{data_agendamento}}", "b", "c", "d"],
            },
          },
        },
        suDb,
      ),
    );
    expect(e?.translationKey).toBe("errors.serviceWindowAppointmentVar");
  });

  test("MCP takes a partial patch of a stored choice, the name coming from what is stored", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: { settings: { serviceWindow: { templates: { followup: ok } } } },
    });
    try {
      const r = await agentSettingsSet(
        {
          userId: 1n,
          tenantId,
          role: "TENANT_ADMIN",
          scopes: ["mcp:read", "mcp:write"],
          clientId: "c",
          jti: "j",
        },
        {
          agent_id: String(agentId),
          serviceWindow: {
            templates: {
              followup: { params: ["{{nome_contato}}", "x", "y", "z"] },
            },
          },
          dry_run: true,
        },
        { base: suDb },
      );
      expect(r.ok ? "ok" : r.error).toBe("ok");
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: {} },
      });
    }
  });

  test("a stale editor gets the 409 its conflict flow handles before any template is judged", async () => {
    const e = await refusal(
      updateAgent(
        ctx(),
        agentId,
        {
          settings: {
            serviceWindow: {
              templates: { followup: { ...ok, name: "nao_existe" } },
            },
          },
        },
        suDb,
        { expectedUpdatedAt: new Date(0), chatwoot: deps },
      ),
    );
    expect(e?.statusCode).toBe(409);
    const fresh = await refusal(
      updateAgent(
        ctx(),
        agentId,
        {
          settings: {
            serviceWindow: {
              templates: { followup: { ...ok, name: "nao_existe" } },
            },
          },
        },
        suDb,
        { chatwoot: deps },
      ),
    );
    expect(fresh?.translationKey).toBe("errors.serviceWindowTemplateNotFound");
  });

  test("an approved document is not a kind: it travels as an attachment", () => {
    expect(() =>
      assertSettingsServiceWindow(
        { serviceWindow: { templates: { document_approval: ok } } },
        {},
      ),
    ).toThrow(AppError);
  });

  test("a kind the product does not have is refused", () => {
    expect(() =>
      assertSettingsServiceWindow(
        { serviceWindow: { templates: { lembrete: ok } } },
        {},
      ),
    ).toThrow(AppError);
  });

  test("a reminder offset that is not a number of hours is refused", () => {
    expect(() =>
      assertSettingsServiceWindow(
        { serviceWindow: { reminderTemplates: { amanha: ok } } },
        {},
      ),
    ).toThrow(AppError);
    expect(() =>
      assertSettingsServiceWindow(
        { serviceWindow: { reminderTemplates: { "24": { nome: "x" } } } },
        {},
      ),
    ).toThrow(AppError);
  });
});
