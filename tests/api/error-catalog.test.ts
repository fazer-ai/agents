import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { translateWithLocale } from "@/api/lib/i18n";
import apiEn from "@/api/locales/en.json";
import apiPt from "@/api/locales/pt-BR.json";
import clientEn from "@/client/locales/en.json";
import clientPt from "@/client/locales/pt-BR.json";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// The guard for what `ErrorTranslationKey` (src/lib/errors.ts) cannot see.
//
// That type closes the common case completely: a key passed to `AppError`, to a subclass, or to
// `translate`/`translateWithLocale` is checked against the catalog at compile time. It has exactly
// three blind spots, and every one of them was a live defect in this repo when issue #256 was
// written:
//
//   1. an `as ErrorTranslationKey` cast, which is by definition the type being told to stop looking;
//   2. a key used as a COMPARISON token rather than an argument (`if (row.error === "errors.x")`),
//      which never passes through a typed parameter at all. This is how the console matched
//      `errors.embeddingNotConfigured` for four releases while the server wrote
//      `errors.embedding.embedding_not_configured`: two spellings, no call site in common, and
//      nothing that could have compared them;
//   3. a catalog that HAS the key but answers it in the wrong language, which type-checks perfectly.
//
// Source-text sweeps match SPELLING, not intent, so each rule below states its negative case: what
// it deliberately does not flag is the design decision, and the escape hatch is a named entry here
// rather than a silent pass.

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sourceFiles(p)));
    else if (/\.tsx?$/.test(e.name) && !p.includes("/locales/")) out.push(p);
  }
  return out;
}

function flattenValues(obj: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = `${prefix}${k}`;
    if (v && typeof v === "object")
      for (const [ck, cv] of flattenValues(v, `${key}.`)) out.set(ck, cv);
    else out.set(key, String(v));
  }
  return out;
}

// EVERY key whose two languages are the same string, minus an enumerated list. No word threshold:
// an earlier version of this rule required three-plus prose words, on the argument that a shorter
// exception list was a ledger nobody would maintain. The four defects that shipped past it settle
// that argument — `knowledge.tabTexto` answered an English-speaking operator "Texto", and
// `knowledge.docStatus.READY` answered "12 trechos", both one word long. A threshold is a rule that
// declines to look at exactly the entries most likely to be a copy-paste of the other language.
//
// As a function rather than inline in the test, so it can be pointed at a catalog that DOES offend:
// live data has zero offenders, and a predicate matching nothing would pass over live data unchanged.
function identicalInBoth(
  en: Map<string, string>,
  pt: Map<string, string>,
  allow: readonly string[],
): string[] {
  return [...en.keys()].filter(
    (k) => pt.get(k) === en.get(k) && !allow.includes(k),
  );
}

// The other direction of the same list, also as a function and for the same reason: live data has
// no stale waiver, so a blinded predicate would pass over it unchanged. Proven below against input
// that does offend.
function staleWaivers(
  en: Map<string, string>,
  pt: Map<string, string>,
  allow: readonly string[],
): string[] {
  return allow.filter((k) => !en.has(k) || pt.get(k) !== en.get(k));
}

function flatten(obj: unknown, prefix = ""): Set<string> {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = `${prefix}${k}`;
    if (v && typeof v === "object")
      for (const c of flatten(v, `${key}.`)) out.add(c);
    else out.add(key);
  }
  return out;
}

const API = flatten(apiEn);
const CLIENT = flatten(clientEn);

// Every `as ErrorTranslationKey` in `src/`, by file. A cast is the one way to hand the wire a key
// the catalog does not have, so each one is listed with the reason it is allowed to exist. Empty on
// purpose right now: production code has no reason to assert a key it did not spell.
const ALLOWED_CASTS: Record<string, string> = {};

// A key whose two languages are the same STRING. A proper noun or a bare protocol word could
// legitimately land here; nothing has yet, and an entry is how a future one gets argued rather than
// assumed.
const ALLOWED_UNTRANSLATED: string[] = [];

// Every client entry whose two languages are the same STRING, with the reason it is allowed to be.
// The list is long because the rule above has no threshold, and that is the trade being made: a
// hundred lines of data anyone can check, against four user-visible defects that a threshold hid.
// An entry arriving here is a decision someone wrote down; an entry MISSING is a red test.
const CLIENT_IDENTICAL_BY_DESIGN: readonly string[] = [
  // Brand and product names. A proper noun is not translated in any language.
  "alerts.type.discord",
  "documents.company.logo",
  "edition.pro",
  "integrations.catalog.ASAAS.label",
  "integrations.catalog.GOOGLE_CALENDAR.label",
  "integrations.catalog.GOOGLE_DRIVE.label",
  "mcp.admin.clientNamePlaceholder",
  "nav.github",
  "nav.website",
  "vault.googleOAuth.scopeCalendar",
  "vault.googleOAuth.scopeContacts",
  "vault.googleOAuth.scopeGmail",
  "vault.googleOAuth.scopeSheets",
  "vault.googleOAuth.scopeTasks",
  "vault.langfuseEnvLabel",
  "vault.secretType.anthropic",
  "vault.secretType.asaas",
  "vault.secretType.deepseek",
  "vault.secretType.elevenlabs",
  "vault.secretType.gemini",
  "vault.secretType.google_oauth",
  "vault.secretType.langfuse",
  "vault.secretType.openai",
  "vault.secretType.openrouter",

  // Acronyms, units and format strings: no letters to translate, or none outside a placeholder.
  "common.notAvailable",
  "dashboard.absolute",
  "dashboard.percent",
  "dashboard.range.30d",
  "dashboard.range.7d",
  "dashboard.range.90d",
  "editor.capabilities.mcp",
  "editor.tab.experiments",
  "integrations.config.minutesOption",
  "integrations.inboundAuthStrategy.HMAC_SHA256",
  "integrations.kind.MCP",
  "knowledge.fileHint",
  "knowledge.fileSize",
  "logs.exportFormatCsv",
  "logs.exportFormatJson",
  "mcp.my.title",
  "mcp.transportLabel.sse",
  "mcp.transportLabel.stdio",
  "mcp.transportLabel.streamableHttp",
  "mcp.url",
  "playground.toolsim.cat.http",
  "playground.toolsim.cat.mcp",
  "settings.mcp",

  // The same word in both languages, spelled identically.
  "admin.email",
  "admin.tenant",
  "agents.statusLabel",
  "auth.email",
  "common.email",
  "dashboard.source.inbox",
  "editor.contactAuthTimeout",
  "editor.promptEditorLabel",
  "invite.email",
  "invite.status",
  "logs.level.info",
  "logs.source.inbox",
  "logs.stage.embed",
  "nav.admin",
  "role.superAdmin",
  "tenant.demo",
  "tenant.slug",
  "vault.secretType.header",
  "vault.secretType.query",

  // Vocabulary the OAuth/provider console itself shows in English, which is where the operator reads
  // the value before pasting it here. Translating the label would stop it matching the screen it came
  // from.
  "editor.baseURL",
  "editor.sttBaseURL",
  "editor.visionBaseURL",
  "mcp.admin.redirectUris",
  "vault.baseUrl",
  "vault.field.clientId",
  "vault.field.clientSecret",
  "vault.field.publicKey",
  "vault.field.secretKey",
  "vault.googleOAuth.redirectUri",
  "vault.secretType.mcp_oauth",

  // Product vocabulary this app keeps in English in BOTH languages, deliberately: these are the words
  // the console, the docs and the Chatwoot surface all use, and a Portuguese-only spelling would make
  // them stop matching each other.
  "admin.tabTenants",
  "admin.tenants",
  "conversation.followUp.badge",
  "conversation.followUp.badgeN",
  "conversation.followUp.scheduled",
  "dashboard.inbox",
  "dashboard.source.playground",
  "dashboard.tokensHint",
  "editor.channelRedirect.navFollowup",
  "editor.channelRedirect.step4Title",
  "editor.observability",
  "editor.tab.guardrails",
  "editor.tab.playground",
  "invite.tenant",
  "logs.source.playground",
  "logs.title",
  "mcp.launcher",
  "nav.logs",
  "nav.webhooks",
  "resources.tabs.followups",
  "tenant.label",
  "vault.refWebhooks",
  "webhooks.title",
];

// A KEY THAT CANNOT SAY WHAT ITS CALL SITE SAYS.
//
// Found by review, on a key this PR itself registered. `refusalBody` prefers the catalog sentence
// over `AppError.message`, so registering a key REPLACES the message — and where the message was
// the more informative of the two, registering it made the answer worse, in English as well as in
// pt-BR. Measured: the Drive 403 said which OAuth scope to reconnect with, and `errors.upstream`
// answered "The integration provider refused or failed the request."
//
// Two shapes, one rule. A key whose catalog entry has no `{{placeholder}}` cannot carry:
//   1. a value the message interpolates (`\${status}`) — the value is dropped;
//   2. a second, DIFFERENT literal message — the two facts collapse into one sentence.
// A key with a placeholder is exempt: that is how a sentence carries what varies.
function keysThatSayLess(
  bySite: Map<string, Set<string>>,
  catalog: Record<string, string>,
  grandfathered: readonly string[],
): string[] {
  return [...bySite.entries()]
    .filter(([key, messages]) => {
      const entry = catalog[key];
      if (entry === undefined || /\{\{\w+\}\}/.test(entry)) return false;
      if (grandfathered.includes(key)) return false;
      return [...messages].some((m) => m.includes("${")) || messages.size > 1;
    })
    .map(([key]) => key)
    .sort();
}

// Every `new AppError(<literal>, …, "errors.X")` in `src`, as key -> the set of messages thrown with
// it. Literal messages only: a message built from a variable cannot be compared to a catalog entry,
// and the rule is about what the two SAY.
// DERIVED from src/lib/errors.ts, not spelled out. A hard-coded alternation is a list that goes stale
// the day someone adds a subclass, and it did: `ConflictError` was missing, so every refusal thrown
// through it — `chatwootDifferentDeployment` among them, one of the entries review had to find by
// reading — was invisible to the rule below.
async function throwSiteRe(): Promise<RegExp> {
  const src = await readFile("src/lib/errors.ts", "utf8");
  const classes = [...src.matchAll(/export class (\w+)/g)].map(
    (m) => m[1] as string,
  );
  expect(classes.length).toBeGreaterThan(5);
  return new RegExp(
    `new (?:${classes.join("|")})\\(\\s*(\`[^\`]*\`|"(?:[^"\\\\]|\\\\.)*")\\s*,\\s*(?:\\d+\\s*,\\s*)?"errors\\.([A-Za-z0-9_]+)"`,
    "gs",
  );
}

function throwSites(
  body: string,
  into: Map<string, Set<string>>,
  re: RegExp,
): void {
  for (const m of body.matchAll(re)) {
    const key = m[2] as string;
    const msg = (m[1] as string).slice(1, -1);
    const set = into.get(key) ?? new Set<string>();
    set.add(msg);
    into.set(key, set);
  }
}

// PREDATES the rule, and may only ever SHRINK. Not an argument that each of these is fine: it is the
// line drawn under what was already there, so no NEW key can land in this shape. Working the list
// down is its own change.
//
// That none of these arrived with the rule was checked against the merge base while writing it, and
// deliberately is NOT a test: the comparison needs a ref that stops meaning anything once this is on
// main. What IS a test, below, is the half that keeps mattering — a waiver whose key no longer
// offends has to leave, so the list stays a record of what is left to do rather than a graveyard.
const SAY_LESS_GRANDFATHERED: readonly string[] = [
  "baseUrlRequired",
  "credentialPending",
  "credentialRequired",
  "documentTemplateSlugTaken",
  "documentTemplateUnreadable",
  "documentWouldBeBlank",
  "googleOAuthInvalidScope",
  "googleOAuthNotConnected",
  "googleOAuthTokenExchangeFailed",
  "googleOAuthTooManyScopes",
  "imageTooLarge",
  "invalidId",
  "invalidVaultRef",
  "invalidVaultValue",
  "mcpOAuthDcrFailed",
  "mcpOAuthDiscoveryFailed",
  "mcpOAuthNotConnected",
  "mcpOAuthTokenExchangeFailed",
  "noExtractableText",
  "providerModelsFailed",
  "unknownFlowStage",
  "unknownProvider",
  "unknownWebhookEvent",
  "unsupportedFileType",
  "vaultRefNotFound",
];

describe("the error catalog cannot be bypassed", () => {
  // A sweep whose subject does not exist yet asserts nothing, and reads exactly like one that
  // works: `src` holds no cast today, so a detector that matched NOTHING would pass this suite
  // unchanged. The predicate is therefore proven against a body that does contain one, before it is
  // pointed at the tree.
  const castsIn = (body: string): boolean =>
    body.includes("as ErrorTranslationKey");

  test("the cast detector detects a cast", () => {
    expect(castsIn('const k = "errors.x" as ErrorTranslationKey;')).toBe(true);
    expect(castsIn('const k: ErrorTranslationKey = "errors.x";')).toBe(false);
  });

  test("no production code casts its way past ErrorTranslationKey", async () => {
    const offenders: string[] = [];
    for (const f of await sourceFiles("src")) {
      if (!castsIn(await readFile(f, "utf8"))) continue;
      if (ALLOWED_CASTS[f]) continue;
      offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  // The spelling rule. A literal that LOOKS like a key and resolves to nothing is either a typo or
  // a token one side invented, and both read identically at the call site.
  // HISTORY, not keys. `KnowledgeDocument.error` is a stored column, so rows written before issue
  // #256 still carry the spelling the producer used then; the console maps them onto today's tokens
  // (src/client/lib/knowledgeDocs.ts). They are `errors.*` literals that must NOT be catalog entries
  // — registering them would put a second dot in the API catalog, which the next test forbids for
  // exactly the reason these exist.
  //
  // Frozen at three. The producer emits only camel-case now, so this list describes a closed past;
  // a fourth arriving here means someone added a NEW dotted token, which is the shape being retired.
  const STORED_LEGACY_TOKENS: readonly string[] = [
    "errors.embedding.embedding_not_configured",
    "errors.embedding.credential_pending",
    "errors.embedding.credential_empty",
  ];

  // As a function, with the control below: `src` holds no unregistered literal once this lands, so a
  // sweep that skipped every key would pass over the tree unchanged — measured, when a mutation
  // replaced the waiver check with a bare `continue`.
  const unregisteredLiterals = (
    body: string,
    catalog: Set<string>,
    api: Set<string>,
    waived: readonly string[],
  ): string[] =>
    [...body.matchAll(/["'](errors\.[A-Za-z0-9_.]+)["']/g)]
      .map((m) => m[1] as string)
      // The client reads server-written tokens off a column, so ITS side of a shared token resolves
      // against the API catalog, not its own.
      .filter((k) => !catalog.has(k) && !api.has(k) && !waived.includes(k));

  test("the literal sweep finds an unregistered key, and only that", () => {
    const api = new Set(["errors.real"]);
    const body = [
      'throw new AppError("x", 400, "errors.real");',
      "throw new AppError('x', 400, 'errors.ghost');",
      'const legacy = "errors.embedding.credential_empty";',
      'const notAKey = "errorsomething";',
    ].join("\n");
    expect(unregisteredLiterals(body, api, api, [])).toEqual([
      "errors.ghost",
      "errors.embedding.credential_empty",
    ]);
    expect(
      unregisteredLiterals(body, api, api, [
        "errors.embedding.credential_empty",
      ]),
    ).toEqual(["errors.ghost"]);
  });

  test("every errors.* literal in src names a real catalog entry", async () => {
    const offenders: string[] = [];
    for (const f of await sourceFiles("src")) {
      const body = await readFile(f, "utf8");
      const catalog = f.startsWith("src/client/") ? CLIENT : API;
      for (const key of unregisteredLiterals(
        body,
        catalog,
        API,
        STORED_LEGACY_TOKENS,
      )) {
        offenders.push(`${f}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // The exemption above is only honest while every entry in it is still REACHED, and only from the
  // one place that is allowed to know about the old spelling.
  test("a legacy token is exempt only where the console translates it", async () => {
    const alias = await readFile("src/client/lib/knowledgeDocs.ts", "utf8");
    for (const token of STORED_LEGACY_TOKENS) {
      expect(alias, `${token} is waived but nothing maps it`).toContain(token);
    }
    const elsewhere: string[] = [];
    for (const f of await sourceFiles("src")) {
      if (f === "src/client/lib/knowledgeDocs.ts") continue;
      const body = await readFile(f, "utf8");
      for (const token of STORED_LEGACY_TOKENS) {
        if (body.includes(token)) elsewhere.push(`${f}: ${token}`);
      }
    }
    // Notably the PRODUCER: a legacy spelling reappearing in src/modules/rag would mean the rename
    // was undone, and the waiver would then be hiding the very bug it was written around.
    expect(elsewhere).toEqual([]);
  });

  // The negative case for the rule above, stated as a rule of its own: a dotted key is how the
  // embedding token was spelled, and the API catalog is one level deep by construction, so a
  // second dot means the key was BUILT rather than declared.
  test("no API error key carries a second dot", () => {
    const dotted = [...API].filter((k) => k.split(".").length > 2);
    expect(dotted).toEqual([]);
  });

  // The other direction of every waiver rule in this file, and the one none of them had: a ledger is
  // subtracted from a set DERIVED from the tree, so appending to it both silences a new offender and
  // satisfies the stale-waiver test. The size is the only fact the tree cannot supply.
  // tests/utils/ledger.ts carries the measurement (issue #293).
  test("the cast and legacy-token ledgers may only shrink", () => {
    expectWaiverLedger("ALLOWED_CASTS", ALLOWED_CASTS, 0);
    expectWaiverLedger("STORED_LEGACY_TOKENS", STORED_LEGACY_TOKENS, 3);
  });
});

describe("both languages answer, and answer differently", () => {
  test("the API catalogs hold the same keys", () => {
    expect([...flatten(apiPt)].sort()).toEqual([...API].sort());
  });

  // Compared on the BASE key, because i18next appends a plural category and the categories differ
  // by language: English has one/other, pt-BR has one/many. Eight client keys legitimately exist
  // only in pt-BR for that reason, and demanding a key-for-key match would have to be silenced with
  // a list that grows every time a counted noun is added.
  const base = (k: string): string =>
    k.replace(/_(zero|one|two|few|many|other)$/, "");
  // Same trap as the cast sweep: the eight real keys all end in `_many`, so a regex that stripped
  // ANY trailing `_word` would give this suite the identical answer while quietly merging
  // `agents.model_name` into `agents.model`. The boundary is asserted directly.
  test("only a plural category is stripped", () => {
    expect(base("knowledge.docCountPlural_many")).toBe(
      "knowledge.docCountPlural",
    );
    expect(base("knowledge.docCountPlural_other")).toBe(
      "knowledge.docCountPlural",
    );
    expect(base("agents.model_name")).toBe("agents.model_name");
    expect(base("errors.toolGrantIdRequired")).toBe(
      "errors.toolGrantIdRequired",
    );
  });

  test("the client catalogs cover the same base keys", () => {
    const en = new Set([...CLIENT].map(base));
    const pt = new Set([...flatten(clientPt)].map(base));
    expect([...pt].sort()).toEqual([...en].sort());
  });

  // The negative case: the plural relaxation above must not let a whole key go missing. A base key
  // present on one side only is still a hole.
  //
  // As a function, and with the control below, because live data has no hole: every pt-only key is a
  // plural variant, so blinding this predicate changes no answer and the assertion would pass over
  // the real catalogs unchanged.
  const pluralOnlyExtras = (en: Set<string>, pt: Set<string>): string[] =>
    [...pt].filter((k) => !en.has(k) && !en.has(`${base(k)}_other`));

  test("the plural relaxation accepts a plural variant and refuses a missing key", () => {
    const en = new Set(["a.count_other", "a.plain"]);
    expect(pluralOnlyExtras(en, new Set(["a.count_one", "a.plain"]))).toEqual(
      [],
    );
    expect(pluralOnlyExtras(en, new Set(["a.count_one", "a.ghost"]))).toEqual([
      "a.ghost",
    ]);
  });

  test("a plural category is the only thing that may differ", () => {
    expect(pluralOnlyExtras(CLIENT, flatten(clientPt))).toEqual([]);
  });

  // The client catalog cannot take the API's rule as-is. Twenty-seven of its entries are legitimately
  // identical in both languages (`Base URL`, `Google Drive`, `HMAC SHA-256`, `Client secret`), so a
  // blanket comparison would need an allowlist longer than the defect it guards. What it CAN hold is
  // prose: three real words reading identically in both languages is a sentence nobody translated,
  // or one written in the wrong language to begin with.
  //
  // Four client entries were the second kind when this was written, all on the knowledge screen,
  // with the English catalog holding the Portuguese. Two of the four are two-word labels, so this
  // rule would NOT have caught them. That is the limit, stated rather than papered over with a lower
  // threshold: at two words the exception list is twenty-seven entries, a ledger nobody maintains.
  test("the rule flags what was never translated, at every length", () => {
    const en = new Map([
      ["a.sentence", "Drag and drop files here, or click to choose"],
      ["a.oneWord", "Texto"],
      ["a.withPlaceholder", "{{n}} trechos"],
      ["a.waived", "PDF, DOCX, TXT"],
    ]);
    // The one-word and placeholder entries are the two shapes the old threshold let through, so
    // they are named here rather than left to the sweep over live data to maybe cover.
    expect(identicalInBoth(en, new Map(en), ["a.waived"])).toEqual([
      "a.sentence",
      "a.oneWord",
      "a.withPlaceholder",
    ]);
    // …and says nothing when the two languages differ, which is the whole point.
    const pt = new Map(en)
      .set("a.sentence", "Arraste e solte arquivos aqui")
      .set("a.oneWord", "Text")
      .set("a.withPlaceholder", "{{n}} chunks");
    expect(identicalInBoth(en, pt, ["a.waived"])).toEqual([]);
  });

  test("no client entry reads the same in both languages without being on the list", () => {
    expect(
      identicalInBoth(
        flattenValues(clientEn),
        flattenValues(clientPt),
        CLIENT_IDENTICAL_BY_DESIGN,
      ),
    ).toEqual([]);
  });

  // The other direction: the list is an argument about entries that EXIST, so a key that was renamed
  // or deleted has to leave it. Otherwise the list slowly becomes a place where a waiver outlives the
  // thing it waived, and nobody can tell which entries still mean anything.
  test("the stale-waiver rule flags a waiver whose key left, and one that got translated", () => {
    const en = new Map([
      ["a.stillSame", "Logo"],
      ["a.nowTranslated", "File"],
    ]);
    const pt = new Map([
      ["a.stillSame", "Logo"],
      ["a.nowTranslated", "Arquivo"],
    ]);
    expect(
      staleWaivers(en, pt, ["a.stillSame", "a.nowTranslated", "a.deleted"]),
    ).toEqual(["a.nowTranslated", "a.deleted"]);
    expect(staleWaivers(en, pt, ["a.stillSame"])).toEqual([]);
  });

  test("every waiver on the list names a key that is still identical in both languages", () => {
    expect(
      staleWaivers(
        flattenValues(clientEn),
        flattenValues(clientPt),
        CLIENT_IDENTICAL_BY_DESIGN,
      ),
    ).toEqual([]);
  });

  test("the say-less rule flags a dropped value and two facts sharing one key, and nothing else", () => {
    const catalog = {
      generic: "The request was refused.",
      withParam: "{{provider}} returned HTTP {{status}}.",
      onlyOne: "Business hours not found.",
    };
    // The fixture needs a literal `${…}`, since interpolation is exactly what the rule looks for.
    // Built from pieces: spelled out in a plain string Biome's noTemplateCurlyInString refuses it,
    // and in a template string it would interpolate away.
    const interpolated = `Drive returned HTTP ${"$"}{status}.`;
    const sites = new Map([
      // interpolates a value the entry has nowhere to put
      ["generic", new Set([interpolated])],
      // two different facts behind one sentence
      ["onlyOne", new Set(["not found here", "not found there"])],
      // a placeholder is exactly how a sentence carries what varies: exempt
      ["withParam", new Set([interpolated, "Calendar too"])],
      // one fact, one literal, nothing lost
      ["absent", new Set(["whatever"])],
    ]);
    expect(keysThatSayLess(sites, catalog, [])).toEqual(["generic", "onlyOne"]);
    // …and a waiver silences exactly its own key.
    expect(keysThatSayLess(sites, catalog, ["generic"])).toEqual(["onlyOne"]);
  });

  test("the throw-site reader finds the shapes the codebase actually writes", async () => {
    const into = new Map<string, Set<string>>();
    // Same reason as the fixture above: the interpolation has to survive into the SOURCE this reads.
    const dollar = "$";
    throwSites(
      [
        'throw new AppError("plain", 400, "errors.a");',
        `throw new AppError(\`with ${dollar}{x}\`, 502, "errors.b");`,
        'throw new NotFoundError("no status arg", "errors.c");',
        'throw new AppError("second message", 400, "errors.a");',
        'throw new AppError(someVariable, 400, "errors.d");',
      ].join("\n"),
      into,
      await throwSiteRe(),
    );
    expect([...into.keys()].sort()).toEqual(["a", "b", "c"]);
    // The captured MESSAGE, not just the key: what feeds the rule above is whether the message
    // interpolates, so a reader that stripped the `${…}` on the way out would silence it.
    //
    // Asserted as a CHARACTER CODE (36 is `$`) rather than against a string built from `dollar`:
    // an expectation assembled from the same variable as the fixture moves with it, and blanking
    // `dollar` left both sides agreeing on `{x}` while nothing interpolated any more.
    const captured = [...(into.get("b") ?? [])][0] ?? "";
    expect(captured.charCodeAt(captured.indexOf("{") - 1)).toBe(36);
    expect(into.get("a")?.size).toBe(2);
    // A message built from a variable has nothing to compare, so it is not a site.
    expect(into.has("d")).toBe(false);
  });

  // The regression this derivation exists for: a subclass the alternation forgot is a whole family of
  // refusals the rule cannot see. `ConflictError` was that subclass.
  test("the reader covers every error class the module exports", async () => {
    const src = await readFile("src/lib/errors.ts", "utf8");
    const classes = [...src.matchAll(/export class (\w+)/g)].map(
      (m) => m[1] as string,
    );
    const re = await throwSiteRe();
    for (const cls of classes) {
      const into = new Map<string, Set<string>>();
      throwSites(`throw new ${cls}("m", 409, "errors.k");`, into, re);
      expect(
        [...into.keys()],
        `${cls} is not a throw site to the reader`,
      ).toEqual(["k"]);
    }
  });

  test("no key answers with less than its call sites already said", async () => {
    const sites = new Map<string, Set<string>>();
    const re = await throwSiteRe();
    for (const f of await sourceFiles("src")) {
      throwSites(await readFile(f, "utf8"), sites, re);
    }
    expect(
      keysThatSayLess(
        sites,
        apiEn.errors as Record<string, string>,
        SAY_LESS_GRANDFATHERED,
      ),
    ).toEqual([]);
  });

  test("the grandfathered list only names keys that still offend", async () => {
    const sites = new Map<string, Set<string>>();
    const re = await throwSiteRe();
    for (const f of await sourceFiles("src")) {
      throwSites(await readFile(f, "utf8"), sites, re);
    }
    const stillOffends = new Set(
      keysThatSayLess(sites, apiEn.errors as Record<string, string>, []),
    );
    // A waiver whose key was fixed, renamed or deleted has to leave: the list is the record of what
    // is left to do, and one that never shrinks stops being that.
    expect(SAY_LESS_GRANDFATHERED.filter((k) => !stillOffends.has(k))).toEqual(
      [],
    );
  });

  // A SUBCLASS IS A THROW SITE WITH NO ARGUMENTS.
  //
  // The sweeps above read call sites, and a class that hard-codes its own message and status is
  // invisible to every one of them: `throw new UnauthorizedError()` names no key, so there is nothing
  // for a source sweep to find and nothing for the type to check. Measured live, against a running
  // server: the public inbound receptor answered `{"error":"Unauthorized"}` to
  // `accept-language: pt-BR` while `errors.unauthorized` sat in both catalogs, translated. Twenty-
  // eight call sites across two classes were in that state.
  //
  // The waived one is waived by an argument written at the class: a 503 whose body the client never
  // shows, because it retries.
  const KEYLESS_BY_DESIGN: readonly string[] = ["ServiceUnavailableError"];

  const keylessSubclasses = (source: string): string[] =>
    [
      ...source.matchAll(
        /export class (\w+) extends (?:AppError|NotFoundError|ForbiddenError|ConflictError) \{(.*?)\n\}/gs,
      ),
    ]
      .filter(([, , body]) => {
        const sup = /super\((.*?)\);/s.exec(body as string);
        return (
          sup !== null && !/errors\.|translationKey/.test(sup[1] as string)
        );
      })
      .map(([, name]) => name as string);

  test("the subclass reader tells a class that passes a key from one that does not", () => {
    const fixture = [
      'export class A extends AppError {\n  constructor() {\n    super("x", 401);\n  }\n}',
      'export class B extends AppError {\n  constructor() {\n    super("x", 401, "errors.b");\n  }\n}',
      'export class C extends AppError {\n  constructor(k: ErrorTranslationKey) {\n    super("x", 401, translationKey);\n  }\n}',
    ].join("\n\n");
    expect(keylessSubclasses(fixture)).toEqual(["A"]);
  });

  test("every error subclass carries the key its refusal is answered with", async () => {
    const source = await readFile("src/lib/errors.ts", "utf8");
    expect(keylessSubclasses(source)).toEqual([...KEYLESS_BY_DESIGN]);
  });

  // TWO ENTRIES PINNED BY WORDING, because review found the same defect at each of them twice.
  //
  // `refusalBody` prefers the catalog over `AppError.message`, so an entry that is merely a shorter
  // paraphrase of the message SILENTLY drops what the message carried. The rule above catches that
  // mechanically only when a value is interpolated or two facts share a key; where the message is
  // simply the more specific prose, nothing but a reader can tell. These two were caught by one, so
  // the thing that made them wrong is written down here rather than left to be re-found.
  test("an entry keeps the instruction the message it replaced was carrying", () => {
    const en = apiEn.errors as Record<string, string>;
    const pt = apiPt.errors as Record<string, string>;
    // The recovery step: without "disconnect first", a 409 tells the operator they are stuck.
    expect(en.chatwootDifferentDeployment).toContain("Disconnect it first");
    expect(pt.chatwootDifferentDeployment).toContain("Desconecte");
    // The required SHAPE, not merely that something is wrong: a REST client cannot act on "invalid".
    expect(en.invalidModelConfig).toContain("object");
    expect(pt.invalidModelConfig).toContain("objeto");
    // Why one Chatwoot account cannot be shared, which is the whole answer to "so what do I do".
    expect(en.chatwootAccountTaken).toContain("single tenant");
    expect(pt.chatwootAccountTaken).toContain("único tenant");
  });

  test("no API entry answers pt-BR with the English sentence", () => {
    const en = apiEn.errors as Record<string, string>;
    const pt = apiPt.errors as Record<string, string>;
    const untranslated = Object.keys(en).filter(
      (k) => pt[k] === en[k] && !ALLOWED_UNTRANSLATED.includes(`errors.${k}`),
    );
    expect(untranslated).toEqual([]);
  });

  // Same rule, same reason as the cast and legacy-token pin above.
  test("the untranslated, keyless and say-less ledgers may only shrink", () => {
    expectWaiverLedger("ALLOWED_UNTRANSLATED", ALLOWED_UNTRANSLATED, 0);
    expectWaiverLedger("KEYLESS_BY_DESIGN", KEYLESS_BY_DESIGN, 1);
    // PER EDITION, and the split is made by EXCLUSION rather than by two pins. Both ledgers hold
    // entries inside `@full-only` blocks, waiving keys the Free extractor prunes, so waiver and key
    // leave the Free tree together and the ledger is shorter there. Counting the entries every
    // edition holds keeps one number right in all three trees.
    //
    // Not a second ledger to keep in sync by hand. A `@full-only` waiver missing from here leaves the
    // full tree one OVER its pin, which is the same red as an append; and an entry listed here that
    // is not actually marked stays in the Free ledger and leaves that tree one UNDER. The cheat this
    // shape would otherwise invite — append to the ledger and to this list — is refused for the same
    // reason: it only balances once the entry is genuinely inside a marker block.
    //
    // Runtime cannot answer this, which is what the shape above replaced: written as
    // `IS_FREE ? 100 : 102` it failed in a derived Free tree, because the env var that flips
    // `config.edition` is set by the Dockerfile and not by the test runner. Written with the markers
    // inside the expression it passed everywhere and left the derived Free file unformatted, which
    // `bun run lint` refuses in the public repo. Both measured.
    const PRUNED_IN_FREE = [
      "branding.faviconTitle",
      "branding.logoTitle",
      "unsupportedImageType",
    ];
    const inEveryEdition = (ledger: readonly string[]): readonly string[] =>
      ledger.filter((k) => !PRUNED_IN_FREE.includes(k));
    expectWaiverLedger(
      "CLIENT_IDENTICAL_BY_DESIGN (excluding what Free prunes)",
      inEveryEdition(CLIENT_IDENTICAL_BY_DESIGN),
      100,
    );
    expectWaiverLedger(
      "SAY_LESS_GRANDFATHERED (excluding what Free prunes)",
      inEveryEdition(SAY_LESS_GRANDFATHERED),
      25,
    );
  });
});

// A key can be registered and still answer with nothing useful. i18next leaves a placeholder it was
// given no value for exactly as written, so `Unknown timezone: {{timezone}}.` reaches the caller
// without throwing and without logging — the same invisibility as a missing key, one layer in.
//
// Three keys shipped that way in the round that registered them, and the reviewer caught all three.
// What follows is the class rather than those three lines: the rendering is fail-safe, and the two
// catalogs must agree on what each sentence interpolates.
describe("a registered key still has to say something", () => {
  const placeholders = (v: string): Set<string> =>
    new Set([...v.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string));

  test("both languages interpolate the same values", () => {
    const en = apiEn.errors as Record<string, string>;
    const pt = apiPt.errors as Record<string, string>;
    const disagree = Object.keys(en).filter(
      (k) =>
        [...placeholders(en[k] ?? "")].sort().join(",") !==
        [...placeholders(pt[k] ?? "")].sort().join(","),
    );
    expect(disagree).toEqual([]);
  });

  // The premise the fail-safe rests on: `{{` in a rendered string means an unfilled placeholder and
  // never a sentence that wanted braces. If an entry ever wants them, this fails first and the
  // fallback in translateWithLocale has to grow a real escape instead.
  test("no entry wants literal braces", () => {
    const odd = Object.entries(apiEn.errors as Record<string, string>).filter(
      ([, v]) => (v.match(/\{\{/g) ?? []).length !== placeholders(v).size,
    );
    expect(odd.map(([k]) => k)).toEqual([]);
  });

  // Over the whole catalog rather than the three keys the review named: the three throw sites are
  // fixed, but "someone registers a placeholder and forgets the param" is a mistake with no signal,
  // so the property that has to hold is that NO key can put braces on a caller's screen.
  test("no placeholder key can render braces to a caller", () => {
    const en = apiEn.errors as Record<string, string>;
    const withParams = Object.keys(en).filter(
      (k) => placeholders(en[k] ?? "").size,
    );
    expect(withParams.length).toBeGreaterThan(10);
    for (const k of withParams) {
      for (const locale of ["en", "pt-BR"] as const) {
        const out = translateWithLocale(
          locale,
          k as never,
          `fallback for ${k}`,
        );
        expect(out, `${locale} ${k}`).not.toContain("{{");
      }
    }
  });

  // The negative case, and it is a regression this guard caused before it was written this way: the
  // check reads the catalog TEMPLATE, not the rendered output, because an interpolated VALUE can
  // hold braces of its own. A document-template refusal quotes the token it rejected, so reading the
  // output called a correct pt-BR sentence broken and answered in English instead.
  test("a value containing braces does not cancel the translation", () => {
    const out = translateWithLocale(
      "pt-BR",
      "errors.invalidDocumentTemplateReason",
      'blocks[2]: token "{{cliente}}" names no field',
      { reason: 'blocks[2]: token "{{cliente}}" names no field' },
    );
    expect(out).toContain("{{cliente}}");
    expect(out).not.toBe('blocks[2]: token "{{cliente}}" names no field');
  });

  test("an unfilled placeholder falls back to the interpolated message", () => {
    // The throw site always builds `message` with the value already in it, so the fallback is a
    // complete sentence: the wrong language, but it names what the caller has to change.
    expect(
      translateWithLocale(
        "pt-BR",
        "errors.invalidTimezone",
        "invalid timezone: America/Nowhere",
      ),
    ).toBe("invalid timezone: America/Nowhere");
    // …and the translation still wins when the value IS supplied.
    expect(
      translateWithLocale(
        "pt-BR",
        "errors.invalidTimezone",
        "invalid timezone: America/Nowhere",
        { timezone: "America/Nowhere" },
      ),
    ).toContain("Fuso horário desconhecido: America/Nowhere");
  });
});

// The fail-safe above keeps braces off the screen, and that is exactly why this rule is separate:
// with it in place, forgetting a param no longer breaks anything visible. It downgrades a pt-BR
// caller to a correct ENGLISH sentence, silently. Removing `{ timezone: tz }` from its throw site
// fails no assertion anywhere else in this suite — measured.
//
// So the language is asserted structurally. A key whose text interpolates must be thrown with
// something after it, and `NotFoundError`/`ForbiddenError` cannot be that something: their
// constructors take no params argument at all, so a placeholder key thrown through one can never
// interpolate no matter what the call site looks like.
describe("a key that interpolates is thrown with the values", () => {
  const PARAMLESS_CLASSES = ["NotFoundError", "ForbiddenError"];

  // Proven against a synthetic body first: live source has no offender once this PR lands, and a
  // predicate that matched nothing would pass the sweep below unchanged.
  function offendersIn(body: string, keys: readonly string[]): string[] {
    const out: string[] = [];
    const lines = body.split("\n");
    for (const [i, line] of lines.entries()) {
      const m = line.match(/["'](errors\.\w+)["']/);
      if (!m || line.trimStart().startsWith("//")) continue;
      const key = m[1] as string;
      if (!keys.includes(key)) continue;
      const next = lines.slice(i + 1).find((l) => l.trim().length > 0) ?? "";
      if (/^\s*\)/.test(next)) out.push(`${key}: no argument follows`);
      const opener = lines
        .slice(Math.max(0, i - 6), i + 1)
        .reverse()
        .find((l) => /new \w+Error\(/.test(l));
      const cls = opener?.match(/new (\w+Error)\(/)?.[1];
      if (cls && PARAMLESS_CLASSES.includes(cls))
        out.push(`${key}: thrown through ${cls}, which carries no params`);
    }
    return out;
  }

  test("the detector detects both shapes", () => {
    const keys = ["errors.invalidTimezone"];
    expect(
      offendersIn(
        'throw new AppError(\n  "bad tz",\n  400,\n  "errors.invalidTimezone",\n);',
        keys,
      ),
    ).toEqual(["errors.invalidTimezone: no argument follows"]);
    expect(
      offendersIn(
        'throw new NotFoundError(\n  "nope",\n  "errors.invalidTimezone",\n);',
        keys,
      ),
    ).toContain(
      "errors.invalidTimezone: thrown through NotFoundError, which carries no params",
    );
    expect(
      offendersIn(
        'throw new AppError(\n  "bad tz",\n  400,\n  "errors.invalidTimezone",\n  { timezone: tz },\n);',
        keys,
      ),
    ).toEqual([]);
    // A ledger line is a declaration, not a throw.
    expect(
      offendersIn(
        "// translate('errors.invalidTimezone', 'Unknown: {{timezone}}')",
        keys,
      ),
    ).toEqual([]);
  });

  test("every interpolating key is thrown with its values", async () => {
    const en = apiEn.errors as Record<string, string>;
    const keys = Object.keys(en)
      .filter((k) => /\{\{\w+\}\}/.test(en[k] ?? ""))
      .map((k) => `errors.${k}`);
    const offenders: string[] = [];
    for (const f of await sourceFiles("src")) {
      for (const o of offendersIn(await readFile(f, "utf8"), keys))
        offenders.push(`${f}: ${o}`);
    }
    expect(offenders).toEqual([]);
  });
});
