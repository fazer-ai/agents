import { describe, expect, test } from "bun:test";
import { translateWithLocale } from "@/api/lib/i18n";
import { refusalBody } from "@/api/lib/refusal";
import { AppError, type TranslatedParam } from "@/lib/errors";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import type { TenantContext } from "@/lib/tenancy";
import { validateModelConfigForWrite } from "@/modules/agents/service";
import {
  issueDocument,
  reservedIdempotencyKeyRefusal,
} from "@/modules/documents/issue";
import { documentStarter } from "@/modules/documents/starters";
import {
  callerValues,
  createDocumentTemplate,
  patchedContent,
  previewDocumentTemplate,
} from "@/modules/documents/templates";
import { parseAuthoredTemplate } from "@/modules/documents/validate";
import { assertHeadersFit } from "@/modules/mcp-connections/service";
import { parseSourceInput } from "@/modules/rag/source";
import {
  parsePriceOverrides,
  updateCompanySettings,
} from "@/modules/tenant-settings/service";

// A refusal that quotes a REASON reads in one language, the caller's: the sentence and the reason it
// interpolates. Ours are phrases with keys of their own; a third party's words (zod's) are
// quoted in backticks as the validator's, never read as part of our sentence.

// Whole English words a pt-BR refusal must not carry outside backticks, and the reverse.
const ENGLISH =
  /\b(the|is|are|not|only|must|cannot|does|and|with|this|of|to|required|supported|declared|twice|invalid|blocked|range|resolves|address|expected|received|unknown|newer|wrote|file|found|extractable|unsupported)\b/i;
const PORTUGUESE =
  /(?<![\p{L}])(não|é|são|apenas|somente|só|obrigatório|obrigatória|inválido|inválida|cabeçalho|cabeçalhos|deve|este|esta|para|uma|campo|valor|endereço|arquivo|modelo|provedor|configuração|tipo)(?![\p{L}])/iu;

const prose = (s: string) => s.replace(/`[^`]*`/g, "``");

function caught(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

async function caughtAsync(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

function templateRefusal(blocks: unknown, fields: unknown): AppError {
  return caught(() => patchedContent(null, { blocks, fields }));
}

function valuesRefusal(fields: unknown, values: unknown): AppError {
  const template = parseAuthoredTemplate(
    [{ id: "b1", type: "fields", rows: [{ label: "Cliente", value: "x" }] }],
    fields,
    {},
  );
  if (!template.ok) throw new Error(template.reason);
  return caught(() =>
    callerValues(
      template.content.fields,
      values,
      new Date("2026-10-11T12:00:00Z"),
      "2026-10-11",
      "pt-BR",
    ),
  );
}

// A template that passes everything but the rule under test.
const STARTER = (() => {
  const starter = documentStarter("quote", "pt-BR");
  if (!starter) throw new Error("no starter");
  return {
    blocks: starter.blocks,
    fields: starter.fields,
    style: starter.style,
  };
})();

// Both refuse before reading anything, so no tenant is ever reached.
const NO_TENANT = { tenantId: 0n } as unknown as TenantContext;

const portal = (baseUrl: string) =>
  parseSourceInput(
    { kind: "chatwoot_portal", baseUrl, slug: "ajuda", locale: "pt-BR" },
    (url) => assertSafeOutboundUrl(url, { allowPrivate: false }),
  );

interface Row {
  name: string;
  error: () => AppError | Promise<AppError>;
  // Our own English reason, which a pt-BR caller must not read at all, not even in backticks.
  ours?: string;
  // What the sentence must name in either language.
  mentions: string[];
}

const ROWS: Row[] = [
  {
    name: "model config: reasoningEffort off openai",
    error: () =>
      caught(() =>
        validateModelConfigForWrite({
          provider: "anthropic",
          model: "claude-x",
          reasoningEffort: "low",
        }),
      ),
    ours: "is only supported on the",
    mentions: ["reasoningEffort", '"anthropic"'],
  },
  {
    name: "model config: a provider that needs a model",
    error: () =>
      caught(() =>
        validateModelConfigForWrite({ provider: "anthropic", model: "" }),
      ),
    ours: "model is required for this provider",
    mentions: ["model"],
  },
  {
    name: "model config: zod's own check, quoted as the validator's",
    error: () =>
      caught(() =>
        validateModelConfigForWrite({
          provider: "openai",
          model: "gpt-4o-mini",
          temperature: 5,
        }),
      ),
    mentions: ["temperature"],
  },
  {
    name: "model config: several problems at once",
    error: () =>
      caught(() =>
        validateModelConfigForWrite({
          provider: "anthropic",
          model: "",
          reasoningEffort: "low",
          temperature: 5,
        }),
      ),
    ours: "model is required for this provider",
    mentions: ["reasoningEffort", "temperature"],
  },
  {
    name: "model config: prompt cache off its providers",
    error: () =>
      caught(() =>
        validateModelConfigForWrite({
          provider: "openai",
          model: "gpt-4o-mini",
          promptCache: "auto",
        }),
      ),
    ours: "is only supported on the",
    mentions: ["promptCache", '"anthropic"', '"openrouter"'],
  },
  {
    name: "document template: duplicate field name",
    error: () =>
      templateRefusal(
        [{ id: "b1", type: "text", text: "Olá {{cliente}}" }],
        [
          { name: "cliente", label: "Cliente", type: "text" },
          { name: "cliente", label: "Cliente", type: "text" },
        ],
      ),
    ours: "duplicate field name",
    mentions: ['"cliente"'],
  },
  {
    name: "document template: a token nothing declares",
    error: () =>
      templateRefusal([{ id: "b1", type: "text", text: "Olá {{nome}}" }], []),
    ours: "which is neither a declared field nor a reserved name",
    mentions: ['"b1"', "{{nome}}"],
  },
  {
    name: "document template: a block pointing at a field of the wrong type",
    error: () =>
      templateRefusal(
        [{ id: "t1", type: "lineItems", field: "cliente" }],
        [{ name: "cliente", label: "Cliente", type: "text" }],
      ),
    ours: "needs field to name a field of type",
    mentions: ['"t1"', '"cliente"', "lineItems"],
  },
  {
    name: "document values: a required field left out",
    error: () =>
      valuesRefusal(
        [{ name: "cliente", label: "Cliente", type: "text", required: true }],
        {},
      ),
    ours: "is required",
    mentions: ['"cliente"', "Cliente"],
  },
  {
    name: "document values: a number that is not one",
    error: () =>
      valuesRefusal([{ name: "total", label: "Total", type: "number" }], {
        total: "dez",
      }),
    ours: "must be a finite number",
    mentions: ['"total"'],
  },
  {
    name: "document template: stored content a newer version wrote",
    error: () =>
      caught(() =>
        patchedContent(
          {
            blocks: [{ id: "b1", type: "bloco_do_futuro" }],
            fields: [],
            style: {},
          },
          {},
        ),
      ),
    mentions: ["blocks"],
  },
  {
    name: "document template: a name out of bounds, under its own sentence",
    error: () =>
      caughtAsync(() =>
        createDocumentTemplate(NO_TENANT, {
          name: "",
        } as unknown as Parameters<typeof createDocumentTemplate>[1]),
      ),
    ours: "must be between",
    mentions: ["name", "120"],
  },
  {
    name: "document preview: a number prefix too long",
    error: () =>
      caughtAsync(() =>
        previewDocumentTemplate(NO_TENANT, { numberPrefix: "x".repeat(25) }),
      ),
    ours: "must be at most",
    mentions: ["numberPrefix", "20"],
  },
  {
    name: "MCP: a header declared twice",
    error: () =>
      caught(() =>
        assertHeadersFit(
          { "X-Tenant": "a", "x-tenant": "b" },
          "streamableHttp",
          null,
        ),
      ),
    ours: "is declared twice",
    mentions: ['"x-tenant"'],
  },
  {
    name: "MCP: a variable the conversation does not have",
    error: () =>
      caught(() =>
        assertHeadersFit({ "X-A": "{{segredo}}" }, "streamableHttp", null),
      ),
    ours: "which is not a conversation variable",
    mentions: ['"X-A"', "{{segredo}}"],
  },
  {
    name: "knowledge source: an address in a blocked range",
    error: () => caughtAsync(() => portal("https://10.0.0.1")),
    ours: "is in a blocked range",
    mentions: ["10.0.0.1"],
  },
  {
    name: "document template: a slug that does not start with a letter",
    error: () =>
      caughtAsync(() =>
        createDocumentTemplate(NO_TENANT, {
          ...STARTER,
          name: "Orçamento",
          slug: "9orcamento",
        } as unknown as Parameters<typeof createDocumentTemplate>[1]),
      ),
    ours: "must start with a letter",
    mentions: [],
  },
  {
    name: "document template: a slug past its length",
    error: () =>
      caughtAsync(() =>
        createDocumentTemplate(NO_TENANT, {
          ...STARTER,
          name: "Orçamento",
          slug: "o".repeat(41),
        } as unknown as Parameters<typeof createDocumentTemplate>[1]),
      ),
    ours: "must be at most",
    mentions: ["40", "send_"],
  },
  {
    name: "document template: a slug onto a built-in tool",
    error: () =>
      caughtAsync(() =>
        createDocumentTemplate(NO_TENANT, {
          ...STARTER,
          name: "Imagem",
          slug: "image",
        } as unknown as Parameters<typeof createDocumentTemplate>[1]),
      ),
    ours: "which is already a built-in tool",
    mentions: ["send_image"],
  },
  {
    name: "document template: a next number out of range",
    error: () =>
      caughtAsync(() =>
        createDocumentTemplate(NO_TENANT, {
          ...STARTER,
          name: "Orçamento",
          slug: "orcamento",
          nextNumber: 0,
        } as unknown as Parameters<typeof createDocumentTemplate>[1]),
      ),
    ours: "must be a whole number from 1 to",
    mentions: ["nextNumber", "2147483647"],
  },
  {
    name: "company profile: a character the documents cannot print",
    error: () =>
      caughtAsync(() => updateCompanySettings(NO_TENANT, { name: "ACME 漢" })),
    ours: "contains characters this document cannot print",
    mentions: ["name", "漢"],
  },
  {
    name: "document issue: an idempotency key the database cannot store",
    error: () =>
      caughtAsync(() =>
        issueDocument({
          ctx: NO_TENANT,
          templateId: 1n,
          idempotencyKey: "a\u0000b",
          values: {},
        }),
      ),
    ours: "contains characters the database cannot store",
    mentions: ["idempotencyKey", "U+0000"],
  },
  {
    name: "document issue: an idempotency key under the approval prefix",
    error: () => {
      const refusal = reservedIdempotencyKeyRefusal("approval:42");
      if (!refusal) throw new Error("expected a refusal");
      return refusal;
    },
    ours: "is reserved for approved documents",
    mentions: ["idempotencyKey", "approval:"],
  },
  {
    name: "price row: a model left out",
    error: () =>
      caught(() =>
        parsePriceOverrides([
          { provider: "openai", model: "", input: 1, output: 1 },
        ]),
      ),
    ours: "a model name is required for this provider",
    mentions: ["model"],
  },
  {
    name: "price row: the same model twice",
    error: () =>
      caught(() =>
        parsePriceOverrides([
          { provider: "openai", model: "gpt-x", input: 1, output: 1 },
          { provider: "openai", model: "gpt-x", input: 2, output: 2 },
        ]),
      ),
    ours: "duplicate provider and model",
    mentions: ["model"],
  },
  {
    name: "price row: zod's own check, quoted as the validator's",
    error: () =>
      caught(() =>
        parsePriceOverrides([
          { provider: "openai", model: "gpt-x", input: -1, output: 1 },
        ]),
      ),
    mentions: ["input"],
  },
  {
    name: "an outbound URL refused on its own sentence",
    error: () =>
      caughtAsync(() =>
        assertSafeOutboundUrl("https://10.0.0.1/hook", { allowPrivate: false }),
      ),
    ours: "is in a blocked range",
    mentions: ["10.0.0.1"],
  },
];

// The phrase's English template, rendered with its params, must BE its message: the en caller and the
// log line read the same sentence, and a template whose placeholder nobody fills would fall back.
function english(p: TranslatedParam): string {
  const params = Object.fromEntries(
    Object.entries(p.params ?? {}).map(([k, v]) => [
      k,
      typeof v === "object" ? english(v) : v,
    ]),
  );
  return translateWithLocale("en", p.key, "<fallback>", params);
}

describe("a refusal that quotes a reason reads in one language", () => {
  for (const row of ROWS) {
    test(`pt-BR: ${row.name}`, async () => {
      const refusal = await row.error();
      expect(refusal.translatedParams?.reason).toBeDefined();
      const { error } = refusalBody(refusal, "pt-BR");
      expect(prose(error)).not.toMatch(ENGLISH);
      if (row.ours) expect(error).not.toContain(row.ours);
      for (const m of row.mentions) expect(error).toContain(m);
    });
    test(`en: ${row.name}`, async () => {
      const refusal = await row.error();
      const { error } = refusalBody(refusal, "en");
      expect(prose(error)).not.toMatch(PORTUGUESE);
      if (row.ours) expect(error).toContain(row.ours);
      for (const m of row.mentions) expect(error).toContain(m);
    });
    test(`the English phrase is the message: ${row.name}`, async () => {
      const reason = (await row.error()).translatedParams?.reason;
      if (!reason) throw new Error("no reason phrase");
      expect(english(reason)).toBe(reason.message);
    });
  }
});
