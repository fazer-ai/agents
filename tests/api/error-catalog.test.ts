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

// Every refusal in `src` that pairs a LITERAL message with a catalog key, as key -> the set of
// messages thrown with it. Literal messages only: a message built from a variable cannot be compared
// to a catalog entry, and the rule is about what the two SAY.
//
// FIVE SPELLINGS, because a refusal is written five ways here and the rule is about the refusal,
// not about the syntax. The class alternation is DERIVED from src/lib/errors.ts rather than spelled
// out. A hard-coded list goes stale the day someone adds a subclass, and it did: `ConflictError`
// was missing, so every refusal thrown through it (`chatwootDifferentDeployment` among them) was
// invisible. Every spelling since was found the same way, one blind spot at a time, and each was
// MEASURED before being added, because a widened reader is only worth what it newly sees:
//
//   1. `new AppError("…", 400, "errors.x")`, the direct throw;
//   2. `super("…", 400, "errors.x")`, a subclass that hard-codes its own refusal. Sees three keys
//      the direct form does not (`tenantNotFound`, `promptTooLong`, `settingsTextTooLong`), and
//      names no new offender: measured, and the reason it costs nothing to keep looking;
//   3. `{ message: "…", key: "errors.x", params: {…} }`, a refusal BUILT and thrown elsewhere, the
//      shape `src/modules/documents/templates.ts` uses so a dry run and an apply can reach the same
//      answer. This one was hiding a live offender: `invalidDocumentSlug` interpolates the rule the
//      identifier broke (`slug: ${problem}.`) into a catalog entry that says only "This identifier
//      is not valid", and issue #291 was written from a list that could not see it;
//   4. `translate("errors.x", "…")` and 5. `translateWithLocale(locale, "errors.x", "…")`, which are
//      not throws at all: the auth, admin and origin surfaces answer `set.status` plus a body, and
//      the schema boundary renders its own. Twenty-one keys, and the whole of `features/auth` and
//      `features/admin`, had never been read by this rule (issue #299).
//
// THE KEY COMES FIRST in 4 and 5 and second in 1 to 3, which is why the groups are NAMED. Written
// positionally, the two orders are one transposition apart, and the transposed version still runs:
// it reads a message as a key and reports offenders that do not exist.
//
// The `translate(` forms are anchored to the CALL and not to adjacency, and that is the whole
// difference between this reader and a wrong one. Measured while writing it: a bare
// `"errors.x"\s*,\s*"…"` also matches a key sitting next to its neighbour in an ARRAY of keys
// (`src/graph/tools/documents.ts` holds one), and it reported `documentNotStored` and
// `documentRevoked` as offenders whose "message" was the next key in the list.
// The pieces every producer spelling is built from, at module scope so the two readers below cannot
// drift apart on what a key, a status or a literal looks like. MESSAGE is the literal one: a plain
// string or a template, which is what the say-less rule can compare to a catalog entry.
// THE STATUS ARGUMENT IS AN EXPRESSION, not always a literal. This read `\d+` until issue #292,
// and the two OAuth token helpers answer `json.error === "invalid_grant" ? 400 : 502` — so the
// reader walked past both of them and counted their key as having one producer fewer than it has.
// Splitting those keys without seeing it would have left the third producer behind, answering the
// sentence written for another fact.
//
// MEASURED IN BOTH DIRECTIONS, which is the half that is easy to skip: a widened reader is judged
// by what it newly sees, and a matcher that runs too far does not merely see more — it pairs a
// message with somebody else's key and DROPS the right pairing, which shows up as a loss, not as a
// gain. Against this tree: 233 pairs before, 235 after, zero lost, and the two gained are exactly
// the two helpers above.
//
// BOUNDED TO ONE ARGUMENT, and not merely to the next comma. A status is a single expression on a
// single line inside one call, so the run may cross neither a parenthesis, a newline nor a
// semicolon. The looser `[^,]*` measures identically on this tree and is a weaker guarantee: after
// a call that passes NO status, it could swallow the key, the `)` and whatever follows, and pair
// that message with a LATER key. Nothing is written that way here today, which is exactly why the
// bound belongs in the expression instead of in a habit (found by review, issue #292).
const STATUS = "(?:[^,()\\n;]*,\\s*)?";
const KEY = '"errors\\.(?<key>[A-Za-z0-9_]+)"';
const MESSAGE = '(?<msg>`[^`]*`|"(?:[^"\\\\]|\\\\.)*")';

async function errorClasses(): Promise<string[]> {
  const src = await readFile("src/lib/errors.ts", "utf8");
  const classes = [...src.matchAll(/export class (\w+)/g)].map(
    (m) => m[1] as string,
  );
  expect(classes.length).toBeGreaterThan(5);
  return classes;
}

async function throwSiteRes(): Promise<RegExp[]> {
  const classes = await errorClasses();
  return [
    new RegExp(
      `new (?:${classes.join("|")})\\(\\s*${MESSAGE}\\s*,\\s*${STATUS}${KEY}`,
      "gs",
    ),
    new RegExp(`super\\(\\s*${MESSAGE}\\s*,\\s*${STATUS}${KEY}`, "gs"),
    new RegExp(`message:\\s*${MESSAGE}\\s*,\\s*key:\\s*${KEY}`, "gs"),
    new RegExp(`\\btranslate\\(\\s*${KEY}\\s*,\\s*${MESSAGE}`, "gs"),
    new RegExp(
      `\\btranslateWithLocale\\(\\s*\\w+\\s*,\\s*${KEY}\\s*,\\s*${MESSAGE}`,
      "gs",
    ),
  ];
}

// THE SIXTH PRODUCER, and the only one that cannot be a regex over the tree: a subclass that
// hard-codes BOTH its sentence and its key, so neither is written at any call site.
// `throw new ProEditionError()` names nothing for a sweep to find.
//
// The pair is split across two lines of the class — a `message = "…"` default in the constructor
// signature, the key in the `super(...)` call — so the file is read class by class rather than by
// one expression, which is also what keeps a default from pairing with the NEXT class's key. That
// happened while writing this: a single greedy regex reported `ForbiddenError`'s "Forbidden" as the
// sentence of `errors.proEdition`.
//
// Found by review on #304, and by the right question: the `tenantTargetRequired` fix in this same PR
// moved two refusals ONTO one of these classes, which silenced the rule instead of satisfying it.
// A producer the reader cannot see is not a producer that agrees.
async function subclassDefaults(into: Map<string, Set<string>>): Promise<void> {
  const src = await readFile("src/lib/errors.ts", "utf8");
  const bodies = src.split(/\nexport class /).slice(1);
  expect(bodies.length).toBeGreaterThan(5);
  for (const body of bodies) {
    const message = body.match(
      /constructor\([^)]*?message\s*=\s*("(?:[^"\\]|\\.)*")/,
    )?.[1];
    const key = body
      .match(/super\(([^;]*?)\)\s*;/s)?.[1]
      ?.match(/"errors\.([A-Za-z0-9_]+)"/)?.[1];
    if (!message || !key) continue;
    const set = into.get(key) ?? new Set<string>();
    set.add(message.slice(1, -1));
    into.set(key, set);
  }
}

// Every producer in the tree, in one place: the three tests below asked the same question with the
// same loop, and a spelling added to one of them and not the others is the shape of blind spot this
// whole file exists to close.
async function allSites(): Promise<Map<string, Set<string>>> {
  const res = await throwSiteRes();
  const sites = new Map<string, Set<string>>();
  for (const f of await sourceFiles("src")) {
    throwSites(await readFile(f, "utf8"), sites, res);
  }
  await subclassDefaults(sites);
  return sites;
}

function throwSites(
  body: string,
  into: Map<string, Set<string>>,
  res: readonly RegExp[],
): void {
  for (const re of res) {
    for (const m of body.matchAll(re)) {
      // Every reader above names both groups, so a match that is missing one is a broken reader and
      // not a shape in the tree: let it throw here rather than skip the site quietly.
      const { key, msg } = m.groups as { key: string; msg: string };
      const set = into.get(key) ?? new Set<string>();
      set.add(msg.slice(1, -1));
      into.set(key, set);
    }
  }
}

// A MESSAGE THAT VARIES, IN AN ENTRY THAT CANNOT CARRY ANYTHING THAT VARIES.
//
// The reader above takes literals only, and the reason it gives is sound: a message built from a
// variable cannot be compared to a catalog entry, and the say-less rule is about what the two SAY.
// The conclusion drawn from it was not. A computed message is, by construction, a sentence that
// VARIES, and an entry with no `{{placeholder}}` is a sentence that cannot carry anything that
// varies — a question that needs no comparison, and so needs no literal, to answer.
//
// Measured on main for issue #302: eight keys are thrown with a computed message and four of them
// into a placeholder-less entry. One does not merely drop the reason, it answers with a DIFFERENT
// one: a five-character template name holding a control character was refused with "The document
// template name must be between 1 and 120 characters", so the operator counts characters and finds
// nothing wrong.
//
// The `super(` spelling is deliberately absent. It occurs only in src/lib/errors.ts, where the
// expression in the message position is the constructor's own parameter, and the sentence it
// defaults to is read by `subclassDefaults` — reading the forwarding as a computed message would
// report the three subclasses that hard-code a key as offenders against their own defaults.
//
// What this reader still cannot see is a caller that passes a computed message INTO one of those
// classes, because that call site names no key. Measured: one call site passes an argument to one
// of them, and it is a tenant id rather than a message (`new ActiveTenantNotFoundError(tenantId)`).
async function computedSiteRes(): Promise<RegExp[]> {
  const classes = await errorClasses();
  // Anything in the message position that is not a literal: an identifier, a member chain, a call.
  // It may not start with a quote or a backtick — that is the other reader's subject — and `[^;]`
  // bounds it to the statement it was found in, so a call with no key cannot reach the next one's.
  // On a nested call the lazy match can stop at an inner comma, which shortens the expression this
  // records; the rule reads the KEY, and the expression only ever goes into the report.
  const COMPUTED = '(?<msg>[^\\s;"`][^;]*?)';
  return [
    new RegExp(
      `new (?:${classes.join("|")})\\(\\s*${COMPUTED}\\s*,\\s*${STATUS}${KEY}`,
      "gs",
    ),
    new RegExp(`message:\\s*${COMPUTED}\\s*,\\s*key:\\s*${KEY}`, "gs"),
    new RegExp(`\\btranslate\\(\\s*${KEY}\\s*,\\s*${COMPUTED}\\s*[,)]`, "gs"),
    new RegExp(
      `\\btranslateWithLocale\\(\\s*\\w+\\s*,\\s*${KEY}\\s*,\\s*${COMPUTED}\\s*[,)]`,
      "gs",
    ),
  ];
}

async function computedSites(): Promise<Map<string, Set<string>>> {
  const res = await computedSiteRes();
  const sites = new Map<string, Set<string>>();
  for (const f of await sourceFiles("src")) {
    throwSites(await readFile(f, "utf8"), sites, res);
  }
  return sites;
}

// The rule itself, and it is one line: a key thrown with a message that varies has to have somewhere
// to put it. No grandfathered list, because there is nothing to grandfather — the four this found
// are fixed in the same change, and a fifth would be a refusal answering the wrong reason from the
// day it was written.
function keysThatCannotCarryTheirReason(
  computed: Map<string, Set<string>>,
  catalog: Record<string, string>,
): string[] {
  return [...computed.keys()]
    .filter((key) => {
      const entry = catalog[key];
      return entry !== undefined && !/\{\{\w+\}\}/.test(entry);
    })
    .sort();
}

// EMPTY, and pinned there. It was fifteen keys drawn as a line under what predated the rule, each
// one a catalog sentence that could not say what its call sites said; issue #292 worked them down to
// nothing, key by key, by asking of every pair of messages whether they are two FACTS (split the
// key), one fact with a value that varies (give the entry a placeholder), or one fact written twice
// (make the two call sites say the one sentence). An append here is now a defect being waived rather
// than a line being held, which is what the pin below says out loud.
const SAY_LESS_GRANDFATHERED: readonly string[] = [];

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
        // The spellings the reader was blind to, each of which cost a release. All POSITIVE
        // controls: a reader that stopped matching one would go green here and quietly stop
        // covering a whole family, which is what it did to `invalidDocumentSlug` for four releases.
        'super("from a subclass", 400, "errors.e");',
        // The status as an EXPRESSION. Both OAuth token helpers spell it this way, and a reader
        // pinned to `\\d+` reports their key with one producer fewer than it has.
        'throw new AppError("computed status", cond ? 400 : 502, "errors.k");',
        'return { message: "built, thrown elsewhere", key: "errors.f", params: {} };',
        // KEY FIRST in these two, and the message second. The auth and admin surfaces answer with a
        // body instead of throwing, and the schema boundary renders its own.
        'return { error: translate("errors.g", "answered, not thrown") };',
        'error: translateWithLocale(locale, "errors.h", "rendered at the boundary"),',
        // NEGATIVE, and it is the false positive this reader was measured against: a key sitting
        // beside its neighbour in an ARRAY of keys is not a key beside its message. Read by
        // adjacency instead of by call, this line reports `i` as a refusal whose sentence is `j`.
        'const DOCUMENT_KEYS = ["errors.i", "errors.j"];',
        // NEGATIVE, and the reason the status matcher is bounded to one argument. A call that
        // passes no status is one comma away from the next key on the line: a matcher that only
        // stops at a comma pairs "keyless status" with `m` and loses `l` entirely.
        'throw new NotFoundError("keyless status", "errors.l"); log(ctx, "errors.m");',
      ].join("\n"),
      into,
      await throwSiteRes(),
    );
    expect([...into.keys()].sort()).toEqual([
      "a",
      "b",
      "c",
      "e",
      "f",
      "g",
      "h",
      "k",
      "l",
    ]);
    // The captured MESSAGE, not just the key: what feeds the rule above is whether the message
    // interpolates, so a reader that stripped the `${…}` on the way out would silence it.
    //
    // Asserted as a CHARACTER CODE (36 is `$`) rather than against a string built from `dollar`:
    // an expectation assembled from the same variable as the fixture moves with it, and blanking
    // `dollar` left both sides agreeing on `{x}` while nothing interpolated any more.
    const captured = [...(into.get("b") ?? [])][0] ?? "";
    expect(captured.charCodeAt(captured.indexOf("{") - 1)).toBe(36);
    expect(into.get("a")?.size).toBe(2);
    // The pairing, not just the presence: the bounded status matcher has to attach the message to
    // the key of its OWN call, and leave the neighbouring key alone.
    expect([...(into.get("l") ?? [])]).toEqual(["keyless status"]);
    expect(into.has("m")).toBe(false);
    // A message built from a variable has nothing to compare, so it is not a site.
    expect(into.has("d")).toBe(false);
  });

  test("a subclass that hard-codes its own refusal is read from the class", async () => {
    const into = new Map<string, Set<string>>();
    await subclassDefaults(into);
    // The live pairs, which is what makes this a positive control rather than a shape test: a reader
    // that stopped pairing the default with the key would answer with an empty map and pass any
    // assertion written about "no bad pairs".
    expect(into.get("proEdition")).toEqual(
      new Set(["This feature requires the Pro edition"]),
    );
    expect(into.get("tenantTargetRequired")).toEqual(
      new Set(["A target tenant is required"]),
    );
    // A class whose key is a PARAMETER pairs its default with nothing: `new NotFoundError("…")` can
    // carry any key, so its "Not found" is not the sentence of any one of them.
    expect(into.has("tenantNotFound")).toBe(false);
  });

  // The regression this derivation exists for: a subclass the alternation forgot is a whole family of
  // refusals the rule cannot see. `ConflictError` was that subclass.
  test("the reader covers every error class the module exports", async () => {
    const src = await readFile("src/lib/errors.ts", "utf8");
    const classes = [...src.matchAll(/export class (\w+)/g)].map(
      (m) => m[1] as string,
    );
    const res = await throwSiteRes();
    for (const cls of classes) {
      const into = new Map<string, Set<string>>();
      throwSites(`throw new ${cls}("m", 409, "errors.k");`, into, res);
      expect(
        [...into.keys()],
        `${cls} is not a throw site to the reader`,
      ).toEqual(["k"]);
    }
  });

  test("no key answers with less than its call sites already said", async () => {
    expect(
      keysThatSayLess(
        await allSites(),
        apiEn.errors as Record<string, string>,
        SAY_LESS_GRANDFATHERED,
      ),
    ).toEqual([]);
  });

  test("the computed-message reader finds every spelling, and reads no literal", async () => {
    const into = new Map<string, Set<string>>();
    // Same reason as the fixture above: the interpolation has to survive into the SOURCE this reads.
    const dollar = "$";
    throwSites(
      [
        'throw new AppError(problem, 400, "errors.a");',
        // the status is optional in the class form, and a call is as computed as an identifier
        'throw new NotFoundError(whyNot(id), "errors.b");',
        'return { message: parsed.reason, key: "errors.c", params: { reason } };',
        'return translate("errors.d", fallbackFor(row));',
        // a call that names NO key hands nothing over, however computed its message is
        "throw new AppError(computeIt(), 400, keyVariable);",
        // both literal spellings belong to the reader above, and neither may show up here
        'throw new AppError("plain", 400, "errors.lit");',
        `throw new AppError(\`with ${dollar}{x}\`, 502, "errors.tpl");`,
        'translateWithLocale(locale, "errors.e", buildIt());',
      ].join("\n"),
      into,
      await computedSiteRes(),
    );
    expect([...into.keys()].sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  test("the rule flags the entry with nowhere to put the reason, and only that one", () => {
    const catalog = {
      carries: "This document template is not valid: {{reason}}",
      cannot: "The document template name must be between 1 and 120 characters",
    };
    const computed = new Map([
      ["carries", new Set(["problem"])],
      ["cannot", new Set(["problem"])],
      // A key with no entry at all is the subject of the registration rules, not of this one.
      ["absent", new Set(["problem"])],
    ]);
    expect(keysThatCannotCarryTheirReason(computed, catalog)).toEqual([
      "cannot",
    ]);
  });

  test("no key answers a computed reason with a sentence that cannot hold it", async () => {
    const computed = await computedSites();
    expect(
      keysThatCannotCarryTheirReason(
        computed,
        apiEn.errors as Record<string, string>,
      ),
    ).toEqual([]);
    // A reader that stopped matching reports the same empty list as a tree that stopped offending.
    // Deliberately far below the eight measured: this is a liveness check, not a size pin, and a
    // number calibrated on THIS tree is a red build in the smaller one the public CI runs.
    expect(computed.size).toBeGreaterThan(3);
  });

  // WHAT THE READER STILL CANNOT SEE, and why each one is allowed to stay invisible.
  //
  // A rule that never RUNS on a key is worse than one that runs and waives it: the waiver is a
  // decision someone wrote down, and the blind spot is a number nobody knows. Issue #291 was drafted
  // from a list this reader produced while blind to one of its own spellings, so the list was short
  // by a key and wrong about another. This is the ledger that makes the blind spot a decision.
  //
  // NOT subtracted from the sweep, COMPARED to it, which is the difference that keeps it honest and
  // is why it needs no size pin (issue #293): appending a key that the reader CAN see fails this
  // test just as loudly as forgetting one it cannot. There is no direction to cheat in.
  const UNSEEN_BY_THE_READER: readonly string[] = [
    // NO MESSAGE AT ALL. A map from a reason enum to a key (src/lib/embedding-block.ts). The
    // sentence is chosen by whoever renders it, so there is nothing here for any reader to compare.
    "embeddingEmpty",
    "embeddingNotConfigured",
    "embeddingPending",
    // A MESSAGE BUILT FROM A VARIABLE. Still invisible to the reader above, which compares
    // SENTENCES and so needs a literal, and no longer unexamined: the computed-message rule asks
    // these eight the one question a varying message can be asked, and every one of them now has a
    // placeholder to put it in (issue #302 — four of them did not, and one answered a control
    // character in a five-character name with "must be between 1 and 120 characters").
    "invalidCompanyField",
    "invalidDocumentNumberPrefix",
    "invalidDocumentTemplateDescription",
    "invalidDocumentTemplateName",
    "invalidDocumentTemplateReason",
    "invalidDocumentValues",
    "invalidIdempotencyKey",
    "unstorableText",
    // A LITERAL NEITHER READER CAN SPAN: a template message holding a nested template
    // (src/modules/business-hours/service.ts writes `${x ? `${a}..${b}` : c}`), so the literal
    // reader's `[^`]*` stops at the inner backtick and the computed reader skips it for starting
    // with one. Its entry interpolates already, so the rule above would have nothing to say about
    // it; what is unread is the say-less comparison, and this line is what says so.
    "invalidBusinessHoursDate",
    // A third group stood here until review asked the obvious question: a subclass that hard-codes
    // its own refusal names nothing at the call site, and `errors.proEdition` was waived for it.
    // "Nothing to read at the call site" is not "nothing to read": the sentence is in the class, and
    // `subclassDefaults` now reads it there. The group is empty, so it is gone.
  ];

  test("every key the reader cannot see is named, with the reason it may stay invisible", async () => {
    const named = new Set<string>();
    const seen = await allSites();
    for (const f of await sourceFiles("src")) {
      const body = await readFile(f, "utf8");
      // A ledger comment declares a key, it does not produce one, and it is spelled in single
      // quotes. Skipping comment lines keeps this honest even if that ever changes.
      for (const line of body.split("\n")) {
        if (line.trimStart().startsWith("//")) continue;
        for (const m of line.matchAll(/"errors\.([A-Za-z0-9_]+)"/g))
          named.add(m[1] as string);
      }
    }
    // Takes anything that can answer "do you have this key": the sweep hands back a Map of
    // key -> messages, and the blinded control below is an empty Set.
    const unseenGiven = (visible: { has: (k: string) => boolean }): string[] =>
      [...named].filter((k) => !visible.has(k)).sort();
    // NO FLOOR ON EITHER COUNT, and that is the whole lesson of this assertion. The first version
    // pinned both above 150, which is true on THIS tree and false on the one the public CI runs:
    // both totals shrink with the edition (166 named / 153 seen here, 161 / 148 in the Free
    // projection, measured), while the ledger below is the same thirteen in every tree. A sentinel
    // calibrated against a tree that the derivation reshapes is a red build in the derived repo and
    // a green one here, which is the shape this file has been bitten by before.
    //
    // The comparison guards itself, so it needs no sentinel: a blinded reader reports every named
    // key as unseen, and that is not this ledger. Proven rather than claimed, because "it would have
    // failed" is exactly the kind of statement that turns out to be false.
    expect(unseenGiven(new Set())).not.toEqual(
      [...UNSEEN_BY_THE_READER].sort(),
    );
    expect(unseenGiven(seen)).toEqual([...UNSEEN_BY_THE_READER].sort());
  });

  test("the grandfathered list only names keys that still offend", async () => {
    const sites = await allSites();
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
    // NOTE: PER EDITION, and the question is asked of the CATALOG. Both ledgers hold entries
    // inside `@full-only` blocks, waiving keys the Free extractor prunes, so waiver and key leave
    // that tree together: two entries from one ledger, one from the other.
    //
    // Three cheaper signals were written first and every one of them is wrong somewhere, measured:
    // `IS_FREE` reads "full" in a derived Free tree, because the env var that flips
    // `config.edition` is set by the Dockerfile and not by the test runner; reading this file's own
    // `@full-only` markers reads nothing in PRO, because the derivation strips the marker lines from
    // both derived trees while keeping the Pro content; and a hand-kept list of the excluded names is
    // a second waiver ledger, where appending to it and to the ledger balances the count in every
    // tree. The catalog is not another proxy: these ledgers differ BECAUSE those keys do.
    //
    // The key it reads is one of the waived ones on purpose. Renamed or dropped, this reads "free"
    // in the full tree and the pin goes red there, where someone can see it.
    const hasProOnlyKeys =
      "faviconTitle" in (clientEn.branding as Record<string, unknown>);
    expectWaiverLedger(
      "CLIENT_IDENTICAL_BY_DESIGN",
      CLIENT_IDENTICAL_BY_DESIGN,
      hasProOnlyKeys ? 102 : 100,
    );
    // NOT per edition any more, and that is the point: the list is empty in every tree, so the two
    // editions can no longer differ on it. The one entry that used to make them differ was waived
    // because the Pro-only branding writer was its second producer; it now passes the same values
    // the other producer does, so the key stops offending in the full tree too (issue #292).
    expectWaiverLedger("SAY_LESS_GRANDFATHERED", SAY_LESS_GRANDFATHERED, 0);
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
// So the language is asserted structurally, at the CALL SITE and not from a table of expected
// params: a table proves what the table says, and the question here is whether the code hands the
// value over.
//
// READ BY POSITION, WHICH IS THE HALF THE FIRST VERSION GUESSED AT. It asked whether the line after
// the key closes the call, plus a hand-written list of classes that carry no params. Both are
// approximations of "what is in the params slot", and issue #291 measured the gap: of the fourteen
// sites it had to fix, that shape saw seven. It missed a single-line throw (nothing follows the key
// on its own line), a site passing `undefined` there to reach the `field` argument behind it, and a
// bag that is present and EMPTY (`params: {}`), which is the shape that would have let this very
// change go green with the catalogs edited and no call site touched.
describe("a key that interpolates is thrown with the values", () => {
  // The names an object literal binds, in BOTH spellings. `{ field: bad.what }` and `{ field }` are
  // the same fact written two ways, and a sweep that knew only the first is how a guard passes over
  // half its subject: measured on this repo in #245, on a bag written exactly like these.
  //
  // A spread is answered with `null`: unknown, not fine. Nothing spreads into a refusal today, and
  // a sweep that quietly approved the first one to do so would be worth less than no sweep.
  function bagNames(inner: string): Set<string> | null {
    const names = new Set<string>();
    let depth = 0;
    let part = "";
    const take = (raw: string): boolean => {
      const t = raw.trim();
      if (!t) return true;
      if (t.startsWith("...")) return false;
      const m = t.match(/^(\w+)/);
      if (m) names.add(m[1] as string);
      return true;
    };
    for (const c of inner) {
      if ("{[(".includes(c)) depth++;
      else if ("}])".includes(c)) depth--;
      if (c === "," && depth === 0) {
        if (!take(part)) return null;
        part = "";
      } else part += c;
    }
    return take(part) ? names : null;
  }

  // What sits in the params position, in every spelling a refusal is written in: the argument after
  // the key, the `params:` field of a refusal built to be thrown elsewhere, and the bag
  // `translateWithLocale` takes behind its English fallback. Anything else in that position, be it
  // `undefined`, a field name or the end of the call, is a site that hands nothing over.
  function bagAfterKey(rest: string): Set<string> | null {
    let s = rest;
    for (const re of [
      /^\s*,\s*/,
      /^params\s*:\s*/,
      /^(?:"(?:[^"\\]|\\.)*"|`[^`]*`)\s*,\s*/,
    ]) {
      const m = s.match(re);
      if (m) s = s.slice(m[0].length);
    }
    if (!s.startsWith("{")) return null;
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}") {
        depth--;
        if (depth === 0) return bagNames(s.slice(1, i));
      }
    }
    return null;
  }

  // Every place the key is WRITTEN, not every place it is thrown: a key used as a comparison token
  // carries no bag either, and that is the shape issue #256 was about. The ledger comments spell the
  // key in single quotes, so they are not sites and need no exception.
  function keySites(body: string, key: string): (Set<string> | null)[] {
    const needle = `"errors.${key}"`;
    const out: (Set<string> | null)[] = [];
    for (
      let i = body.indexOf(needle);
      i >= 0;
      i = body.indexOf(needle, i + 1)
    ) {
      out.push(bagAfterKey(body.slice(i + needle.length)));
    }
    return out;
  }

  test("the reader finds the bag, in every spelling, and says so when there is none", () => {
    // Proven against source that DOES offend before being pointed at a tree that does not: a reader
    // matching nothing passes a clean tree unchanged, which is a green that means nothing.
    expect(bagAfterKey(', { field: bad.what, codePoints: "1 2" })')).toEqual(
      new Set(["field", "codePoints"]),
    );
    expect(bagAfterKey(", { name })")).toEqual(new Set(["name"]));
    // A template literal inside the bag closes braces of its own, so the scan has to survive one.
    // Built from `dollar` for the same reason the throw-site fixture above is: the lint refuses a
    // literal interpolation written inside a plain string.
    const dollar = "$";
    expect(
      bagAfterKey(`, { date: x ? \`${dollar}{a}..${dollar}{b}\` : c })`),
    ).toEqual(new Set(["date"]));
    expect(bagAfterKey(",\n      params: { tool, name },")).toEqual(
      new Set(["tool", "name"]),
    );
    expect(
      bagAfterKey(', "The value sent in {{field}} is not valid.", { field })'),
    ).toEqual(new Set(["field"]));
    // The four ways a site hands nothing over, three of which the previous shape read as fine.
    expect(bagAfterKey(");")).toBeNull();
    expect(bagAfterKey(", undefined, field)")).toBeNull();
    expect(bagAfterKey(', "slug")')).toBeNull();
    expect(bagAfterKey(", params: {},")).toEqual(new Set());
    // …and the spread that cannot be read is unknown, not approved.
    expect(bagAfterKey(", { ...whatever })")).toBeNull();
    expect(keySites('new AppError(m, 400, "errors.x", { a });', "x")).toEqual([
      new Set(["a"]),
    ]);
    expect(keySites("// translate('errors.x', 'nope')", "x")).toEqual([]);
  });

  test("every interpolating key is thrown with its values", async () => {
    const en = apiEn.errors as Record<string, string>;
    const wanted = new Map(
      Object.entries(en)
        .map(
          ([k, v]) =>
            [
              k,
              [...v.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1] as string),
            ] as [string, string[]],
        )
        .filter(([, ph]) => ph.length > 0),
    );
    const unfilled: string[] = [];
    const seen = new Set<string>();
    for (const f of await sourceFiles("src")) {
      const body = await readFile(f, "utf8");
      for (const [key, expected] of wanted) {
        for (const bag of keySites(body, key)) {
          seen.add(key);
          const absent = expected.filter((p) => !bag?.has(p));
          if (absent.length) unfilled.push(`${f}: ${key} <- ${absent.join()}`);
        }
      }
    }
    expect(unfilled).toEqual([]);
    // A sweep whose subject went missing reports the same empty list as a clean tree.
    expect(seen.size).toBeGreaterThan(10);
  });
});
