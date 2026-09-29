import { describe, expect, spyOn, test } from "bun:test";
import { NotFoundError as ElysiaNotFoundError } from "elysia";
import logger from "@/api/lib/logger";
import { errors } from "@/api/lib/openapi";
import EN_CATALOG from "@/api/locales/en.json";
import { buildApp } from "@/app";
import { REJECTED_TENANT_SELECTOR_HEADER } from "@/lib/console-params";
import {
  ActiveTenantNotFoundError,
  AppError,
  type ErrorTranslationKey,
  NotFoundError,
} from "@/lib/errors";
import { SettingsTextTooLongError } from "@/modules/agents/service";
import { refuseUnstorable } from "@/modules/rag/documents";
import { expectWaiverLedger } from "@/tests/utils/ledger";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The refusal as the CLIENT receives it, through the `onError` registered in src/app.ts. The
// declared-response route asserts that an error body survives Elysia's `normalize`, which strips
// what a schema does not declare and exempts only a raw `Response`.
setupPrismaMock();
// ITS OWN APP, NOT THE PROCESS'S: Elysia compiles its router on first use, so routes this file
// added to the shared export after another file's request would fall through to the `/*` SPA
// handler. `buildApp()` is the builder the server runs, so the `onError` arm is the real one.
const app = await buildApp();

app.get("/__refusal/named", () => {
  throw new SettingsTextTooLongError(
    "guardrails.output.templateMessage",
    5000,
    2000,
  );
});
app.get(
  "/__refusal/declared",
  () => {
    throw new SettingsTextTooLongError("kanban.instructions", 5000, 2000);
  },
  { response: errors(400) },
);
app.get("/__refusal/unnamed", () => {
  throw new AppError("Forbidden", 403);
});
// The ambient refusal: nothing in the request named this tenant, it is the selector the session has
// been carrying all along.
app.get("/__refusal/ambient-tenant", () => {
  throw new ActiveTenantNotFoundError(1234n);
});
// The shared refusal for a character Postgres will not store, reached by every document, approval
// and knowledge-base write. The body must name the field (`title`, `text`) for the console to key on.
app.get("/__refusal/unstorable", () => {
  refuseUnstorable([
    ["title", "fine"],
    ["text", `has a ${NUL} in it`],
  ]);
});
// The caller-named refusal, spelled exactly as `getTenant` spells it.
app.get("/__refusal/named-tenant", () => {
  throw new NotFoundError("Tenant not found", "errors.tenantNotFound");
});
const NUL = "\u0000";

const refusal = async (
  path: string,
  lang: string,
): Promise<{
  status: number;
  rejected: string | null;
  body: Record<string, unknown>;
}> => {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      headers: { "accept-language": lang },
    }),
  );
  return {
    status: res.status,
    rejected: res.headers.get(REJECTED_TENANT_SELECTOR_HEADER),
    body: (await res.json()) as Record<string, unknown>,
  };
};

describe("a refusal over the wire", () => {
  test("carries the field the server refused, next to the sentence it localized", async () => {
    const { status, body } = await refusal("/__refusal/named", "en");
    expect(status).toBe(400);
    expect(body.field).toBe("guardrails.output.templateMessage");
    expect(body.error).toBe(
      "The text in guardrails.output.templateMessage is too long: 5000 characters (limit 2000).",
    );
  });

  test("the sentence follows Accept-Language and the field does not", async () => {
    const en = await refusal("/__refusal/named", "en");
    const pt = await refusal("/__refusal/named", "pt-BR");
    expect(pt.body.error).not.toBe(en.body.error);
    expect(pt.body.error).toContain("longo demais");
    // Named, not merely equal: two absent fields are also equal, and that is the state this test
    // exists to fail on.
    expect(en.body.field).toBe("guardrails.output.templateMessage");
    expect(pt.body.field).toBe("guardrails.output.templateMessage");
  });

  test("survives a route that DECLARES its error responses (normalize does not strip it)", async () => {
    const { status, body } = await refusal("/__refusal/declared", "en");
    expect(status).toBe(400);
    expect(body.field).toBe("kanban.instructions");
  });

  test("the unstorable-character refusal names the field it is about", async () => {
    // The one the client wiring for documents and approvals depends on: `DOC_FIELDS` declares
    // `title` and `text`, and neither can be placed if the body carries no name.
    const { status, body } = await refusal("/__refusal/unstorable", "en");
    expect(status).toBe(400);
    expect(body.field).toBe("text");
    expect(body.error).toContain("U+0000");
  });

  test("a refusal that names no field answers the same body it answers today", async () => {
    const { status, body } = await refusal("/__refusal/unnamed", "en");
    expect(status).toBe(403);
    expect(body).toEqual({ error: "Forbidden" });
  });
});

// The one 404 about the BROWSER'S OWN STATE. `errors.tenantNotFound` means either the session's
// ambient selector is dead (`requireTenantExists`) or a tenant the request NAMED does not exist;
// only the first obliges the client to drop its selection, so key or status alone cannot decide.
// The signal is a HEADER because `onResponse` in src/client/lib/api.ts reads the `Response` before
// Eden parses it, and reading the body there would consume Eden's stream.
describe("a 404 about the tenant selector the session is carrying", () => {
  test("names the id it refused, so the client can match it against what it holds", async () => {
    const { status, rejected } = await refusal(
      "/__refusal/ambient-tenant",
      "en",
    );
    expect(status).toBe(404);
    expect(rejected).toBe("1234");
  });

  test("the body is the one it answers today", async () => {
    // The signal rides beside the body, not in it: readers of this refusal keep the same
    // keys, and `field` stays for refusals about an input.
    const { body } = await refusal("/__refusal/ambient-tenant", "en");
    expect(body).toEqual({ error: "Tenant not found" });
  });

  test("the sentence follows Accept-Language and the id does not", async () => {
    const en = await refusal("/__refusal/ambient-tenant", "en");
    const pt = await refusal("/__refusal/ambient-tenant", "pt-BR");
    expect(pt.body.error).not.toBe(en.body.error);
    expect(en.rejected).toBe("1234");
    expect(pt.rejected).toBe("1234");
  });

  test("a 404 about a tenant the REQUEST named carries no such id", async () => {
    // Same status, key and sentence, and the browser must not touch its selection over it.
    const { status, rejected, body } = await refusal(
      "/__refusal/named-tenant",
      "en",
    );
    expect(status).toBe(404);
    expect(rejected).toBeNull();
    expect(body).toEqual({ error: "Tenant not found" });
  });
});

// ── unhandled errors ─────────────────────────────────────────────────────────────────────────────
// The failures the app did not plan for. Outside development src/app.ts answers every thrown value
// that is not a refusal Elysia raised with "Something went wrong", whatever `code` it carries,
// because an unhandled error's message can hold anything.

// Stands in for anything an unhandled error's message can carry: a connection string, a query
// fragment, a filesystem path, a third-party SDK payload. The assertions look for THIS, so they fail
// on the disclosure itself rather than on a particular phrasing of the refusal.
const SECRET = "postgres://user:hunter2@db.internal:5432/agents";

app.get("/__unhandled/sync", () => {
  throw new Error(`connection failed: ${SECRET}`);
});
app.get("/__unhandled/async", async () => {
  await Promise.resolve();
  throw new TypeError(`connection failed: ${SECRET}`);
});
app.get("/__unhandled/nonerror", () => {
  throw `connection failed: ${SECRET}`;
});
// Thrown values that already carry a string `code`, which Elysia hands the handler instead of
// UNKNOWN, so a redact-list keyed on `code` would miss them.
app.get("/__unhandled/prisma", () => {
  throw Object.assign(new Error(`connection failed: ${SECRET}`), {
    code: "P2025",
  });
});
app.get("/__unhandled/fs", () => {
  throw Object.assign(new Error(`connection failed: ${SECRET}`), {
    code: "EACCES",
  });
});
// A NUMERIC `code`, which Elysia copies too: a rule reading it as "a status the handler chose"
// would pass these straight through.
app.get("/__unhandled/domexception", () => {
  throw new DOMException(`connection failed: ${SECRET}`, "DataCloneError");
});
app.get("/__unhandled/numericcode", () => {
  throw Object.assign(new Error(`connection failed: ${SECRET}`), { code: 23 });
});
// Not a throw at all: the handler returns fine and the FAILURE happens while the response is
// serialized, a shape whose unredacted answer names the error's class.
app.get("/__unhandled/serialize", () => ({ id: 1n }));
// An unhandled error that carries its OWN `status`. Elysia seeds `set.status` from that property
// before this handler runs, and the access log reads `set.status`, not the Response's — so the two
// disagree unless the arm syncs it.
app.get("/__logged/carries-status", () => {
  throw Object.assign(new Error(`connection failed: ${SECRET}`), {
    status: 401,
  });
});
// An unhandled failure that CALLS ITSELF one of Elysia's refusals. Elysia forwards the thrown
// value's own `code`, so a branch that read `code` would answer these 422 or 404 instead of 500.
const IMPOSTOR = [
  "VALIDATION",
  "NOT_FOUND",
  "PARSE",
  "INVALID_COOKIE_SIGNATURE",
  "INVALID_FILE_TYPE",
  "INTERNAL_SERVER_ERROR",
] as const;
for (const code of IMPOSTOR) {
  app.get(`/__impostor/${code}`, () => {
    throw Object.assign(new Error(`connection failed: ${SECRET}`), { code });
  });
}
// The genuine article, to prove the guard tells them apart rather than just answering 500 to
// everything: this one MUST keep its 404.
app.get("/__real/notfound", () => {
  // NOTE: Elysia's, aliased: the APP's NotFoundError imported above is an AppError answered by a
  // different arm.
  throw new ElysiaNotFoundError();
});
// A genuine NotFoundError carrying a `status` of its own. Elysia seeds `set.status` from that
// property, so this is the 404 arm's version of the `status: 401` case below: the wire says 404 and
// the access log says 418 unless that arm syncs `set.status` too.
app.get("/__real/notfound-status", () => {
  throw Object.assign(new ElysiaNotFoundError(), { status: 418 });
});
// A `SyntaxError` from a bare `BigInt` is an unhandled throw. No arm recognises it by its message:
// such a catch-all is a net under every handler that forgot to parse, turning a missing parse into
// an answer the caller cannot read.
app.get("/__logged/bigint", () => {
  throw new SyntaxError("Cannot convert 9007199254740993x to a BigInt");
});

const UNHANDLED = [
  "sync",
  "async",
  "nonerror",
  "serialize",
  "prisma",
  "fs",
  "domexception",
  "numericcode",
] as const;

const unhandled = async (
  shape: string,
): Promise<{ status: number; body: string }> => {
  const res = await app.handle(
    new Request(`http://localhost/__unhandled/${shape}`),
  );
  return { status: res.status, body: await res.text() };
};

describe("an unhandled error, whatever shape it arrives in", () => {
  test.each([...UNHANDLED])("%s still answers 500", async (shape) => {
    expect((await unhandled(shape)).status).toBe(500);
  });

  test.each([...UNHANDLED])("%s does not leak the message", async (shape) => {
    const { body } = await unhandled(shape);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("connection failed");
  });

  // NOTE: asserted positively, not as another "does not contain": an unredacted serialize failure
  // answers `{"name":"TypeError",…}`, which carries no secret but names the class.
  test.each([...UNHANDLED])(
    "%s answers the redaction, nothing else",
    async (shape) => {
      expect((await unhandled(shape)).body).toBe("Something went wrong");
    },
  );
});

// A status the handler CHOSE has to survive the redaction, or the guard would swallow deliberate
// answers along with the accidents.
app.get("/__chosen/teapot", ({ status }) => status(418, "deliberate"));

// Elysia freezes its route table on the first request it serves, and a route registered after that
// is silently dropped (the SPA catch-all answers 200 `{}`). `compile()` rebuilds the table, so it
// stays below the LAST route this file registers.

// The table in tests/api/lib/unhandled-error.test.ts says an error calling itself VALIDATION is an
// unhandled failure; these assert the app actually routes it that way.
describe("an error that calls itself a framework refusal", () => {
  test.each([...IMPOSTOR])(
    "code %s is still an unhandled failure",
    async (code) => {
      const res = await app.handle(
        new Request(`http://localhost/__impostor/${code}`),
      );
      const body = await res.text();
      expect(res.status).toBe(500);
      expect(body).toBe("Something went wrong");
      expect(body).not.toContain(SECRET);
    },
  );

  test("while the real NotFoundError keeps its 404", async () => {
    const res = await app.handle(
      new Request("http://localhost/__real/notfound"),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });
});

// The sweep's route, registered HERE and not next to its describe below: everything this file serves
// is declared before `compile()`.
const UNTRANSLATED = "UNTRANSLATED FALLBACK";

app.get("/__refusal/key", ({ query }) => {
  const params = JSON.parse((query.params as string) ?? "{}") as Record<
    string,
    string | number
  >;
  throw new AppError(
    UNTRANSLATED,
    400,
    query.key as ErrorTranslationKey,
    params,
  );
});

app.compile();

describe("a status the handler chose is not an unhandled failure", () => {
  test("it keeps its own code and body", async () => {
    const res = await app.handle(
      new Request("http://localhost/__chosen/teapot"),
    );
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("deliberate");
  });
});

describe("a request refused before the handler keeps its own answer", () => {
  const login = async (body: string): Promise<number> =>
    (
      await app.handle(
        new Request("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      )
    ).status;

  test("a body that is not JSON stays 400 (PARSE)", async () => {
    expect(await login("{ not json at all")).toBe(400);
  });

  test("a body the schema refuses stays 422 (VALIDATION)", async () => {
    expect(await login(JSON.stringify({ nope: 1 }))).toBe(422);
  });
});

// What the ACCESS LOG says happened. `onAfterResponse` logs `set.status`, which a raw `Response`
// does not move and Elysia seeds from the thrown value's own `status`: without the arm syncing it,
// the wire says 500 and the log says 401, a failure nothing on the wire shows.
describe("the access log records the status actually answered", () => {
  // `onAfterResponse` runs after `handle` resolves, so poll for the line and THROW when it
  // never arrives: a bare timeout would turn a missing log into a wording mismatch.
  const loggedStatusFor = async (path: string): Promise<string> => {
    const spy = spyOn(logger, "info");
    try {
      await (await app.handle(new Request(`http://localhost${path}`))).text();
      for (let i = 0; i < 100; i++) {
        const call = spy.mock.calls.findLast((c) => c[0] === "%s %s [%s]");
        if (call) return String(call[3]);
        await Bun.sleep(5);
      }
      throw new Error(`no access log line for ${path} after 500ms`);
    } finally {
      spy.mockRestore();
    }
  };

  const wireStatusFor = async (path: string): Promise<number> =>
    (await app.handle(new Request(`http://localhost${path}`))).status;

  test("an error carrying status: 401 is answered 500 and logged 500", async () => {
    expect(await wireStatusFor("/__logged/carries-status")).toBe(500);
    expect(await loggedStatusFor("/__logged/carries-status")).toBe("500");
  });

  test("the 404 arm logs 404 even when the error carries another status", async () => {
    expect(await wireStatusFor("/__real/notfound-status")).toBe(404);
    expect(await loggedStatusFor("/__real/notfound-status")).toBe("404");
  });

  // An unparsed id reaches the generic arm and is answered and recorded as unhandled. Every
  // caller-supplied id has its own parse (tests/lib/caller-id-spelling.test.ts sweeps for one that
  // skips it), so nothing on an HTTP path throws this.
  test("a bare BigInt throw is answered 500 and logged 500", async () => {
    expect(await wireStatusFor("/__logged/bigint")).toBe(500);
    expect(await loggedStatusFor("/__logged/bigint")).toBe("500");
  });
});

// The sentence a refusal answered, or a THROW naming why there is none. Any status but the route's
// 400 means the handler was never reached (the rate limiter's 429, or the SPA catch-all for a route
// registered after `compile()`), which would otherwise read as every key answering nothing. A
// function rather than an inline `if` so the control below can trip it: live data never does.
async function sentenceOf(
  res: Response,
  key: string,
  lang: string,
): Promise<string> {
  if (res.status !== 400) {
    throw new Error(
      `${key} (${lang}) answered ${res.status}, not the route's 400: ${(await res.text()).slice(0, 120)}`,
    );
  }
  return ((await res.json()) as { error?: string }).error ?? "";
}

// A value per placeholder the template declares, so nothing is left unfilled by the CALLER — the
// failure this looks for is the catalog's, not the fixture's.
const paramsFor = (template: string): Record<string, string> =>
  Object.fromEntries(
    [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => [
      m[1] as string,
      `<${m[1]}>`,
    ]),
  );

// Empty on purpose: an API refusal is a sentence, so identical spellings in both languages mean one
// was never written. Unlike a short UI label in the client catalog, a key here is a skipped
// translation.
const WIRE_IDENTICAL_IN_BOTH: string[] = [];

// ONE pass over the catalog, shared by the assertions below: the requests go through the real
// middleware chain, and two passes in two locales trip the 600/min rate limiter. LAZY rather than a
// module-level IIFE, which would race the route registration above and read as a broken catalog.
let sweepOnce: Promise<Map<string, { en: string; pt: string }>> | null = null;
const runSweep = (): Promise<Map<string, { en: string; pt: string }>> => {
  sweepOnce ??= (async () => {
    const rendered = new Map<string, { en: string; pt: string }>();
    for (const key of Object.keys(EN_CATALOG.errors)) {
      const template = (EN_CATALOG.errors as Record<string, string>)[
        key
      ] as string;
      const params = encodeURIComponent(JSON.stringify(paramsFor(template)));
      const say = async (lang: string): Promise<string> => {
        const res = await app.handle(
          new Request(
            `http://localhost/__refusal/key?key=errors.${key}&params=${params}`,
            { headers: { "accept-language": lang } },
          ),
        );
        return sentenceOf(res, `errors.${key}`, lang);
      };
      rendered.set(key, { en: await say("en"), pt: await say("pt-BR") });
    }
    return rendered;
  })();
  return sweepOnce;
};

describe("every registered key, over the wire", () => {
  test("a harness failure is named as one, never reported as a silent catalog", async () => {
    // NOTE: the two harness failures: the limiter, and a route the router never learned.
    await expect(
      sentenceOf(
        new Response("Rate limit exceeded.", { status: 429 }),
        "errors.x",
        "en",
      ),
    ).rejects.toThrow(/answered 429/);
    await expect(
      sentenceOf(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        "errors.x",
        "en",
      ),
    ).rejects.toThrow(/answered 200/);
    // …and a real refusal passes straight through.
    expect(
      await sentenceOf(
        new Response(JSON.stringify({ error: "Agente não encontrado" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
        "errors.agentNotFound",
        "pt-BR",
      ),
    ).toBe("Agente não encontrado");
  });

  test("the sweep read the catalog the app reads, and reached every key", async () => {
    const rendered = await runSweep();
    expect(rendered.size).toBe(Object.keys(EN_CATALOG.errors).length);
    expect(rendered.size).toBeGreaterThan(100);
    expect(rendered.has("settingsTextTooLong")).toBe(true);
  });

  test("no key answers the untranslated fallback, the bare key, or an unfilled placeholder", async () => {
    const offenders: string[] = [];
    for (const [key, { en, pt }] of await runSweep()) {
      for (const [lang, sentence] of [
        ["en", en],
        ["pt-BR", pt],
      ] as const) {
        if (
          sentence === UNTRANSLATED ||
          sentence === `errors.${key}` ||
          sentence.includes("{{") ||
          sentence.trim() === ""
        ) {
          offenders.push(
            `${lang} errors.${key} -> ${JSON.stringify(sentence)}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("pt-BR answers a different sentence than en, for every key", async () => {
    const sameInBoth: string[] = [];
    const differed: string[] = [];
    for (const [key, { en, pt }] of await runSweep()) {
      if (en === pt) sameInBoth.push(key);
      else differed.push(key);
    }
    expect(sameInBoth).toEqual(WIRE_IDENTICAL_IN_BOTH);
    // NOTE: the control for a sweep whose expected result is "nothing found": an app ignoring
    // Accept-Language, or a harness answering "", lands every key in `sameInBoth` instead.
    expect(differed.length).toBe(
      (await runSweep()).size - WIRE_IDENTICAL_IN_BOTH.length,
    );
  });

  // Appending to the ledger silences an untranslated key and keeps the assertion above true, so it
  // is pinned at zero and refuses its FIRST entry (tests/utils/ledger.ts).
  test("the wire-identical ledger may only shrink", () => {
    expectWaiverLedger("WIRE_IDENTICAL_IN_BOTH", WIRE_IDENTICAL_IN_BOTH, 0);
  });
});
