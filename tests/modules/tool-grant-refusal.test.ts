import { describe, expect, test } from "bun:test";
import { translateWithLocale } from "@/api/lib/i18n";
import { AppError } from "@/lib/errors";
import { replaceAgentToolSelections } from "@/modules/agents/service";

// What a caller is told when a tool grant is refused.
//
// Twelve throw sites shared ONE key, `errors.invalidToolGrant`, and that key was in neither locale
// catalog — so `translateWithLocale` fell back to `message` and every one of them answered a pt-BR
// caller in English (issue #256). One key for twelve refusals could only ever have been a generic
// sentence anyway, which would have thrown away what each of them says.
//
// The six keys below are the six DIFFERENT questions those twelve sites ask, and the split is by
// what the caller has to change: an id they did not send, an id that is not a number, a source they
// already granted, a tool name that does not exist, a source that does not exist, and a tool that
// exists but not for that integration.
//
// Asserted THROUGH the translation rather than on the error object, for the same reason
// document-error-reason.test.ts is: the defect lived in that step, and an assertion on
// `error.message` passes with or without the fix because `message` was always English.

const ctx = { tenantId: 1n, role: "TENANT_ADMIN" as const, userId: 1n };

async function refusal(input: unknown[]): Promise<AppError> {
  try {
    await replaceAgentToolSelections(
      ctx as never,
      1n,
      input as never,
      // Never reached: normalizeGrants runs before the scoped transaction opens, which is what lets
      // this whole table run without a database.
      undefined as never,
    );
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("expected a refusal, got none");
}

function shown(err: AppError, locale: "en" | "pt-BR"): string {
  if (!err.translationKey) return err.message;
  return translateWithLocale(
    locale,
    err.translationKey,
    err.message,
    err.translationParams,
  );
}

describe("a refused tool grant says WHICH rule refused it", () => {
  const cases: Array<{
    what: string;
    input: unknown[];
    key: string;
    params: Record<string, string>;
    ptContains: string;
  }> = [
    {
      what: "an id the caller never sent",
      input: [{ source: "HTTP" }],
      key: "errors.toolGrantIdRequired",
      params: { field: "toolDefinitionId" },
      ptContains: "obrigatório",
    },
    {
      what: "an id that is not a number",
      input: [{ source: "MCP", mcpServerConnectionId: "0x11" }],
      key: "errors.toolGrantIdInvalid",
      params: { field: "mcpServerConnectionId" },
      ptContains: "id numérico",
    },
    {
      what: "a source granted twice",
      input: [{ source: "NATIVE" }, { source: "NATIVE" }],
      key: "errors.toolGrantDuplicate",
      params: { source: "NATIVE" },
      ptContains: "já tem uma concessão",
    },
    {
      what: "a tool name that does not exist",
      input: [{ source: "NATIVE", enabledTools: ["send_carrier_pigeon"] }],
      key: "errors.toolGrantUnknownTool",
      params: { tool: "send_carrier_pigeon" },
      ptContains: "desconhecida",
    },
    {
      what: "a source that does not exist",
      input: [{ source: "TELEPATHY" }],
      key: "errors.toolGrantUnknownSource",
      params: { source: "TELEPATHY" },
      ptContains: "Origem de ferramenta desconhecida",
    },
  ];

  for (const c of cases) {
    test(`${c.what} is named by its own key`, async () => {
      const err = await refusal(c.input);
      expect(err.statusCode).toBe(400);
      expect(err.translationKey).toBe(c.key as never);
      expect(err.translationParams).toMatchObject(c.params);
    });

    test(`${c.what} is answered in the caller's language`, async () => {
      const err = await refusal(c.input);
      const pt = shown(err, "pt-BR");
      expect(pt).toContain(c.ptContains);
      // The value the caller has to change survives the translation. Interpolation rather than a
      // generic sentence is the whole reason these carry params.
      for (const v of Object.values(c.params)) expect(pt).toContain(v);
      expect(pt).not.toBe(shown(err, "en"));
    });
  }

  // The negative case, and the design decision behind the split: two refusals that a single key
  // would have merged must not answer with the same sentence. This is what "one key for twelve
  // sites" cost, stated as an assertion.
  test("the six problems do not collapse into one sentence", async () => {
    const seen = new Set<string>();
    for (const c of cases) seen.add(shown(await refusal(c.input), "pt-BR"));
    expect(seen.size).toBe(cases.length);
  });

  // Unknown-tool is one rule over TWO catalogs, and the caller has to know which one it checked: the
  // native list and the RAG list hold different names, so "Unknown tool: x" leaves them guessing
  // where to look. Without this, a mutation collapsing both sites onto one source broke no test.
  test("an unknown tool names which catalog was searched", async () => {
    const native = await refusal([
      { source: "NATIVE", enabledTools: ["send_carrier_pigeon"] },
    ]);
    const rag = await refusal([
      {
        source: "RAG",
        knowledgeBaseIds: ["1"],
        enabledTools: ["send_carrier_pigeon"],
      },
    ]);
    for (const err of [native, rag]) {
      expect(err.translationKey).toBe("errors.toolGrantUnknownTool" as never);
    }
    expect(native.translationParams).toMatchObject({ source: "NATIVE" });
    expect(rag.translationParams).toMatchObject({ source: "RAG" });
    // Through the translation, in both languages: the param is only worth carrying if it renders.
    for (const locale of ["en", "pt-BR"] as const) {
      expect(shown(native, locale)).not.toBe(shown(rag, locale));
      expect(shown(native, locale)).toContain("NATIVE");
      expect(shown(rag, locale)).toContain("RAG");
    }
  });

  // Duplicate is one rule over six sources, so the SOURCE has to reach the caller: without the
  // param, the six sites would be indistinguishable to anyone reading the answer.
  test("a duplicate names which source was granted twice", async () => {
    for (const source of ["RAG", "HTTP", "MCP", "INTEGRATION", "DOCUMENT"]) {
      const id =
        source === "HTTP"
          ? { toolDefinitionId: "1" }
          : source === "MCP"
            ? { mcpServerConnectionId: "1" }
            : source === "INTEGRATION"
              ? { integrationInstanceId: "1" }
              : source === "DOCUMENT"
                ? { documentTemplateId: "1" }
                : {};
      const err = await refusal([
        { source, ...id },
        { source, ...id },
      ]);
      expect(err.translationKey).toBe("errors.toolGrantDuplicate" as never);
      expect(shown(err, "pt-BR")).toContain(source);
    }
  });
});

// The same question one layer up, on the OTHER refusal `updateAgent` raises before it opens a
// transaction: a business-hours id that is not a number. `refOrThrow` takes the key to refuse with
// as an argument, and nothing asserted WHICH key came out — a mutation that hard-coded
// `errors.agentNotFound` there broke no test, so the caller could have been told the AGENT was
// missing when the id they typed was the schedule's.
describe("a business-hours id that is not a number", () => {
  async function updateRefusal(patch: Record<string, unknown>) {
    const { updateAgent } = await import("@/modules/agents/service");
    try {
      await updateAgent(ctx as never, 1n, patch as never, undefined as never);
    } catch (e) {
      if (e instanceof AppError) return e;
      throw e;
    }
    throw new Error("expected a refusal, got none");
  }

  test("is refused as a missing SCHEDULE, in both languages", async () => {
    for (const field of ["businessHoursId", "followUpHoursId"]) {
      const err = await updateRefusal({ [field]: "not-a-number" });
      expect(err.translationKey).toBe("errors.businessHoursNotFound");
      expect(shown(err, "en")).toBe("Business hours not found.");
      expect(shown(err, "pt-BR")).toBe(
        "Horário de atendimento não encontrado.",
      );
      // Named, not merely "not the agent one": the two sentences must not be the same string, which
      // is the state that made this refusal indistinguishable in the first place.
      expect(shown(err, "en")).not.toBe(shown(err, "pt-BR"));
    }
  });
});
