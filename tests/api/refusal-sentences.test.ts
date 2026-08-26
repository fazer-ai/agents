import { describe, expect, test } from "bun:test";
import { refusalBody } from "@/api/lib/refusal";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { setCompanyLogo } from "@/modules/documents/company";
import { type KeyResolver, listProviderModels } from "@/modules/models/service";
import { listTtsOptions } from "@/modules/tts/listing";
import { createVaultEntry } from "@/modules/vault/service";

// THE SENTENCE THE CALLER ACTUALLY READS, produced by the code that refuses.
//
// The guards in tests/api/error-catalog.test.ts ask their questions of the SOURCE: whether an entry
// carries a placeholder, whether a call site passes a bag with the right names in it. Both were
// written because a source-level mistake here is invisible at runtime — `translateWithLocale` falls
// back to the pre-interpolated English `message` for a placeholder it was given no value for, so a
// forgotten bag answers a pt-BR reader a complete, useful, permanently untranslated sentence
// (issue #291). A rule that can only be checked in the source is one that has never been read.
//
// So this file closes the loop from the other end: it CALLS the refusing function, hands the
// AppError to the same `refusalBody` the error handler uses, and pins the rendered string in both
// languages. Issue #292 split fifteen keys whose one sentence had to answer for several different
// refusals; what proves the split landed is that each of them now reads differently, to a reader.
//
// Every producer below is the real function with its network, key resolution and storage injected —
// none of these refusals is reached by a fake that stands in for the rule.

const ctx: TenantContext = { tenantId: 1n, userId: null, role: "TENANT_ADMIN" };
// Injected away: every case here refuses before the first query.
const noDb = null as never;
const passthroughSafe = async (url: string) => new URL(url);
const resolvesKey: KeyResolver = async () => "fake-api-key";
const resolvesNothing: KeyResolver = async () => null;

function respondsWith(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

// A reachable provider whose body is not JSON: `res.json()` rejects, INSIDE the try that answers a
// network failure.
function answersUnparseable(): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  })) as unknown as typeof fetch;
}

function refuses(err: unknown): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

function upload(type: string, body: number[]) {
  return {
    type,
    size: body.length,
    arrayBuffer: async () => new Uint8Array(body).buffer as ArrayBuffer,
  };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const be32 = (n: number) => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];
// A PNG that is its header and its terminator and nothing else: enough for the byte check that
// runs first and for the reader that measures the dimensions, and nothing past it, because the
// refusal happens well before anything decodes an image.
const PNG_END = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
const pngOf = (w: number, h: number) => [
  ...PNG_MAGIC,
  ...be32(13),
  0x49,
  0x48,
  0x44,
  0x52,
  ...be32(w),
  ...be32(h),
  ...PNG_END,
];

interface Case {
  what: string;
  key: string;
  produce: () => Promise<unknown>;
  en: string;
  pt: string;
}

const CASES: Case[] = [
  // ONE FACT, TWO PHRASINGS. The chat listing said "credentialRef is required to list provider
  // models" and the TTS listing "credentialRef is required to list ElevenLabs options"; both mean
  // the caller named no credential, and both now answer the one sentence the catalog always had.
  {
    what: "the chat model listing, with no credential named",
    key: "errors.credentialRequired",
    produce: () =>
      listProviderModels(
        ctx,
        { provider: "openai" },
        noDb,
        respondsWith(200, {}),
        passthroughSafe,
        resolvesKey,
      ),
    en: "A credential is required to list provider models.",
    pt: "Uma credencial é obrigatória para listar os modelos do provedor.",
  },
  {
    what: "the voice listing, with no credential named",
    key: "errors.credentialRequired",
    produce: () =>
      listTtsOptions(
        ctx,
        { provider: "elevenlabs", kind: "voices" },
        noDb,
        respondsWith(200, {}),
        passthroughSafe,
        resolvesKey,
      ),
    en: "A credential is required to list provider models.",
    pt: "Uma credencial é obrigatória para listar os modelos do provedor.",
  },
  // TWO FACTS THAT SHARED THAT KEY. Naming no credential and naming one that cannot be read are
  // different mistakes with different repairs, and they answered the same sentence.
  {
    what: "a credential that resolves to nothing",
    key: "errors.credentialNotUsable",
    produce: () =>
      listTtsOptions(
        ctx,
        { provider: "elevenlabs", kind: "voices", credentialRef: "vault:1" },
        noDb,
        respondsWith(200, {}),
        passthroughSafe,
        resolvesNothing,
      ),
    en: "This credential did not provide an API key: it may be missing, empty, or of a type this provider cannot use.",
    pt: "Esta credencial não forneceu uma chave de API: ela pode estar ausente, vazia ou de um tipo que este provedor não usa.",
  },
  {
    what: "a provider that needs a base URL and was given none",
    key: "errors.baseUrlRequired",
    produce: () =>
      listProviderModels(
        ctx,
        { provider: "openai-compatible", credentialRef: "vault:1" },
        noDb,
        respondsWith(200, {}),
        passthroughSafe,
        resolvesKey,
      ),
    en: "A base URL is required for this provider.",
    pt: "Uma URL base é obrigatória para este provedor.",
  },
  // THE VALUES THE SENTENCE NOW CARRIES. `unknown ${capability} provider: ${provider}` was answered
  // by "Unknown model provider." — the two values the caller needs were in the message and nowhere
  // else, so the reader was told the provider is unknown without being told which one.
  {
    what: "an unknown chat provider",
    key: "errors.unknownProvider",
    produce: () =>
      listProviderModels(
        ctx,
        { provider: "bogus" },
        noDb,
        respondsWith(200, {}),
        passthroughSafe,
        resolvesKey,
      ),
    en: "Unknown chat provider: bogus.",
    pt: "Provedor de chat desconhecido: bogus.",
  },
  {
    what: "an unknown speech provider",
    key: "errors.unknownProvider",
    produce: () =>
      listTtsOptions(
        ctx,
        { provider: "bogus", kind: "voices" },
        noDb,
        respondsWith(200, {}),
        passthroughSafe,
        resolvesKey,
      ),
    en: "Unknown tts provider: bogus.",
    pt: "Provedor de tts desconhecido: bogus.",
  },
  // THREE WAYS A LISTING FAILS, and they were one sentence: "Failed to retrieve model list from
  // provider." Seventeen distinct messages sat behind it. The repairs differ — a 401 is the
  // credential, an unexpected shape is not the operator's to fix, and an unreachable host is the
  // base URL or the network.
  {
    what: "a provider that answers the listing with an error status",
    key: "errors.providerModelsFailed",
    produce: () =>
      listProviderModels(
        ctx,
        { provider: "openai", credentialRef: "vault:1" },
        noDb,
        respondsWith(401, {}),
        passthroughSafe,
        resolvesKey,
      ),
    en: "openai refused the list request (status 401).",
    pt: "openai recusou a requisição da lista (status 401).",
  },
  {
    what: "a provider that answers the listing in a shape nothing can read",
    key: "errors.providerListUnexpectedResponse",
    produce: () =>
      listProviderModels(
        ctx,
        { provider: "openai", credentialRef: "vault:1" },
        noDb,
        respondsWith(200, { nope: true }),
        passthroughSafe,
        resolvesKey,
      ),
    en: "openai answered the list request in an unexpected format.",
    pt: "openai respondeu à requisição da lista em um formato inesperado.",
  },
  {
    what: "a provider that never answers at all",
    key: "errors.providerListUnreachable",
    produce: () =>
      listProviderModels(
        ctx,
        { provider: "openai", credentialRef: "vault:1" },
        noDb,
        refuses(new Error("connection refused")),
        passthroughSafe,
        resolvesKey,
      ),
    en: "Could not reach openai to list the options",
    pt: "Não foi possível alcançar openai para listar as opções",
  },
  // THE TWO UPLOAD SURFACES ACCEPT DIFFERENT FORMATS, which is why the sentence carries the list
  // instead of naming one of them: the branding asset takes five, the letterhead two.
  {
    what: "a logo in a format the letterhead does not take",
    key: "errors.unsupportedImageType",
    produce: () =>
      setCompanyLogo(ctx, upload("image/webp", pngOf(10, 10)), noDb),
    en: "Unsupported image type. Allowed: PNG, JPG",
    pt: "Tipo de imagem não suportado. Permitidos: PNG, JPG",
  },
  // SIZE IN BYTES AND SIZE IN PIXELS were one key. A file can pass the byte cap and still decode
  // into gigabytes, and "Image is too large" sent the operator to compress a file that was already
  // small.
  {
    what: "a logo whose declared dimensions are past the pixel budget",
    key: "errors.imageTooManyPixels",
    produce: () =>
      setCompanyLogo(ctx, upload("image/png", pngOf(3000, 3000)), noDb),
    en: "The image has too many pixels: at most 4000000 in total (about 2000×2000)",
    pt: "A imagem tem pixels demais: no máximo 4000000 no total (cerca de 2000×2000)",
  },
  {
    what: "a logo whose header cannot be measured",
    key: "errors.imageDimensionsUnreadable",
    produce: () => setCompanyLogo(ctx, upload("image/png", pngOf(0, 0)), noDb),
    en: "The image header could not be read, so its size cannot be checked. Export the file again.",
    pt: "Não foi possível ler o cabeçalho da imagem, então o tamanho dela não pode ser conferido. Exporte o arquivo novamente.",
  },
  // A PROVIDER THAT ANSWERS, in a body nothing can parse. It is reached inside the same `try` that
  // answers a network failure, and the catch there used to call it unreachable.
  {
    what: "a provider whose answer is not JSON at all",
    key: "errors.providerListUnexpectedResponse",
    produce: () =>
      listProviderModels(
        ctx,
        { provider: "openai", credentialRef: "vault:1" },
        noDb,
        answersUnparseable(),
        passthroughSafe,
        resolvesKey,
      ),
    en: "openai answered the list request in an unexpected format.",
    pt: "openai respondeu à requisição da lista em um formato inesperado.",
  },
  {
    what: "a provider whose answer is the literal null",
    key: "errors.providerListUnexpectedResponse",
    produce: () =>
      listProviderModels(
        ctx,
        { provider: "openai", credentialRef: "vault:1" },
        noDb,
        respondsWith(200, null),
        passthroughSafe,
        resolvesKey,
      ),
    en: "openai answered the list request in an unexpected format.",
    pt: "openai respondeu à requisição da lista em um formato inesperado.",
  },
  // THREE SHAPES OF A BAD SECRET, one sentence. Only the first is about the value as a whole; the
  // other two name an input on the credential form, and named neither.
  {
    what: "a multi-field secret sent as a string",
    key: "errors.invalidVaultValue",
    produce: () =>
      createVaultEntry(
        ctx,
        {
          name: "lf",
          kind: "langfuse",
          value: "not-an-object" as unknown as Record<string, string>,
        },
        undefined,
        undefined,
        noDb,
      ),
    en: "The secret value must be an object for this credential type",
    pt: "O valor do segredo precisa ser um objeto para este tipo de credencial",
  },
  {
    what: "a declared field left empty",
    key: "errors.vaultFieldRequired",
    produce: () =>
      createVaultEntry(
        ctx,
        {
          name: "lf",
          kind: "langfuse",
          value: { publicKey: "pk", secretKey: "" },
        },
        undefined,
        undefined,
        noDb,
      ),
    en: 'The "secretKey" field must not be empty',
    pt: 'O campo "secretKey" não pode ficar vazio',
  },
  {
    what: "a field this credential type does not declare",
    key: "errors.vaultFieldUnknown",
    produce: () =>
      createVaultEntry(
        ctx,
        {
          name: "lf",
          kind: "langfuse",
          value: { publicKey: "pk", secretKey: "sk", extra: "x" },
        },
        undefined,
        undefined,
        noDb,
      ),
    en: 'This credential type has no field called "extra"',
    pt: 'Este tipo de credencial não tem um campo chamado "extra"',
  },
];

describe("a refusal reads differently for each thing it refuses", () => {
  for (const c of CASES) {
    test(c.what, async () => {
      const err = await c.produce().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, "the producer did not refuse").toBeInstanceOf(AppError);
      const refusal = err as AppError;
      expect(refusal.translationKey).toBe(
        c.key as AppError["translationKey"] & string,
      );
      expect(refusalBody(refusal, "en").error).toBe(c.en);
      expect(refusalBody(refusal, "pt-BR").error).toBe(c.pt);
    });
  }

  // NOT A SENTENCE, and that is the answer: a malformed ITEM inside a well-formed list is dropped,
  // the way every other unusable row already is (`typeof id !== "string"` → skip). What made this
  // worth a test is where it USED to land — reading a field off `null` threw a TypeError inside the
  // try that answers a network failure, so one bad row in a provider's list told the operator the
  // provider could not be reached, and took the whole picker down with it (issue #292, round 2).
  test("a malformed item is skipped, not reported as an unreachable provider", async () => {
    const models = await listProviderModels(
      ctx,
      { provider: "anthropic", credentialRef: "vault:1" },
      noDb,
      respondsWith(200, { data: [null, { id: "claude-x" }] }),
      passthroughSafe,
      resolvesKey,
    );
    expect(models).toEqual([{ id: "claude-x" }]);
  });

  // THE ONE THING A NETWORK FAILURE MUST NOT SAY. Bun raises header validation with the offending
  // header VALUE inside the message — `Header 'Authorization' has invalid value: 'Bearer <secret>'`
  // — and a stored key with a stray newline is enough to reach it. An entry that interpolated that
  // text would answer a write-only vault secret to whoever called the listing endpoint (found by
  // review, issue #292). The fixture below is that exact message, and the assertion is on the
  // ANSWER, in both languages, not on the entry: an entry can grow a placeholder at any time.
  test("a network failure never answers with the text of the error", async () => {
    const secret = "sk-live-NEVER-ON-THE-WIRE";
    const leaky = new TypeError(
      `Header 'Authorization' has invalid value: 'Bearer ${secret}\nX-Injected: 1'`,
    );
    const err = (await listProviderModels(
      ctx,
      { provider: "openai", credentialRef: "vault:1" },
      noDb,
      refuses(leaky),
      passthroughSafe,
      resolvesKey,
    ).then(
      () => null,
      (e: unknown) => e,
    )) as AppError;
    expect(err).toBeInstanceOf(AppError);
    for (const lang of ["en", "pt-BR"]) {
      expect(refusalBody(err, lang).error).not.toContain(secret);
      expect(refusalBody(err, lang).error).not.toContain("Authorization");
    }
  });

  // The point of the whole exercise, asked of the answers rather than of the catalog: no two of
  // these refusals read the same, EXCEPT the pair that was deliberately made to (one fact, two
  // phrasings). A split that renamed a key without changing what it says would go green above and
  // red here.
  test("no two different refusals answer with the same sentence", async () => {
    const byPt = new Map<string, string[]>();
    for (const c of CASES) {
      byPt.set(c.pt, [...(byPt.get(c.pt) ?? []), c.key]);
    }
    const shared = [...byPt.entries()]
      .filter(([, keys]) => new Set(keys).size > 1)
      .map(([sentence]) => sentence);
    expect(shared).toEqual([]);
  });
});
