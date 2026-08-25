import { describe, expect, test } from "bun:test";
import { refusalBody } from "@/api/lib/refusal";
import { AppError, ConflictError } from "@/lib/errors";
import { SettingsTextTooLongError } from "@/modules/agents/service";

// What a refusal ANSWERS, as a table: the message the operator reads, and the name of the value that
// was refused. The two are decided by different things: the message by the request's locale, the
// name by the server's own vocabulary. The table exists to keep them from being confused for
// each other. Issue #231.

interface Row {
  name: string;
  error: AppError;
  acceptLanguage: string | null;
  body: { error: string; field?: string };
}

const ROWS: Row[] = [
  {
    name: "the field rides ALONGSIDE the localized sentence, not inside it",
    error: new SettingsTextTooLongError(
      "guardrails.output.templateMessage",
      5000,
      2000,
    ),
    acceptLanguage: "en",
    body: {
      error:
        "The text in guardrails.output.templateMessage is too long: 5000 characters (limit 2000).",
      field: "guardrails.output.templateMessage",
    },
  },
  {
    name: "another locale changes the sentence and NOT the field: it is a key, never copy",
    error: new SettingsTextTooLongError(
      "guardrails.output.templateMessage",
      5000,
      2000,
    ),
    acceptLanguage: "pt-BR",
    body: {
      error:
        "O texto em guardrails.output.templateMessage é longo demais: 5000 caracteres (limite 2000).",
      field: "guardrails.output.templateMessage",
    },
  },
  {
    name: "no translation key: the raw message is the sentence, and the field still rides",
    error: new AppError(
      "agentId is required",
      400,
      undefined,
      undefined,
      "agentId",
    ),
    acceptLanguage: "pt-BR",
    body: { error: "agentId is required", field: "agentId" },
  },
  {
    name: "a refusal that names no field answers EXACTLY the body it answers today",
    error: new AppError("Forbidden", 403),
    acceptLanguage: "en",
    body: { error: "Forbidden" },
  },
  {
    // The class carries a field and no params, which is why the slug refusal below stopped being
    // thrown through it: a 409 that has to interpolate cannot.
    name: "a ConflictError carries its field through, like any other refusal",
    error: new ConflictError(
      "mcp connection name already in use",
      "errors.mcpNameTaken",
      "name",
    ),
    acceptLanguage: "en",
    body: {
      error: "That MCP connection name is already in use.",
      field: "name",
    },
  },
  {
    name: "a 409 names its input too: the status is not what decides this",
    error: new AppError(
      'a document template with the slug "orcamento" already exists',
      409,
      "errors.documentTemplateSlugTaken",
      { slug: "orcamento" },
      "slug",
    ),
    acceptLanguage: "en",
    body: {
      error:
        'A document template with the identifier "orcamento" already exists',
      field: "slug",
    },
  },
  {
    name: "a blank name is not a name: omitted rather than sent empty",
    error: new AppError("nope", 400, undefined, undefined, "   "),
    acceptLanguage: "en",
    body: { error: "nope" },
  },
  {
    name: "no Accept-Language falls back to en, the same as every other translated answer",
    error: new SettingsTextTooLongError("vision.extractionPrompt", 9, 8),
    acceptLanguage: null,
    body: {
      error:
        "The text in vision.extractionPrompt is too long: 9 characters (limit 8).",
      field: "vision.extractionPrompt",
    },
  },
];

describe("refusalBody", () => {
  for (const row of ROWS) {
    test(row.name, () => {
      expect(refusalBody(row.error, row.acceptLanguage)).toEqual(row.body);
    });
  }

  test("the key is ABSENT, not null, when nothing was named", () => {
    // A `field: null` would be a wire change for every refusal in the app, and every client that
    // reads the body would have to learn a second spelling of "nothing here".
    expect("field" in refusalBody(new AppError("Forbidden", 403), "en")).toBe(
      false,
    );
  });
});
