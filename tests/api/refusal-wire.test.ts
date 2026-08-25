import { describe, expect, spyOn, test } from "bun:test";
import { NotFoundError as ElysiaNotFoundError } from "elysia";
import logger from "@/api/lib/logger";
import { errors } from "@/api/lib/openapi";
import EN_CATALOG from "@/api/locales/en.json";
import { REJECTED_TENANT_SELECTOR_HEADER } from "@/lib/console-params";
import {
  ActiveTenantNotFoundError,
  AppError,
  type ErrorTranslationKey,
  NotFoundError,
} from "@/lib/errors";
import { SettingsTextTooLongError } from "@/modules/agents/service";
import { expectWaiverLedger } from "@/tests/utils/ledger";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The refusal as the CLIENT receives it, through the app the process actually serves.
//
// It goes through the REAL app rather than a rebuilt one because the branch under test is the
// `onError` registered in src/app.ts, and an app built here would pin this file's own ordering
// instead of the app's. The declared-response route is the second half: Elysia's `normalize` strips
// what a schema does not declare, and an error body is only exempt because the handler answers with
// a raw `Response`. That exemption is asserted, not assumed. Issue #231.
setupPrismaMock();
const app = (await import("@/app")).default;

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
// The caller-named refusal, spelled exactly as `getTenant` spells it today.
app.get("/__refusal/named-tenant", () => {
  throw new NotFoundError("Tenant not found", "errors.tenantNotFound");
});
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

  test("a refusal that names no field answers the same body it answers today", async () => {
    const { status, body } = await refusal("/__refusal/unnamed", "en");
    expect(status).toBe(403);
    expect(body).toEqual({ error: "Forbidden" });
  });
});

// The one 404 that says something about the BROWSER'S OWN STATE, told apart from the six that do
// not, on the same wire.
//
// `errors.tenantNotFound` is thrown from seven places and names two different facts: the ambient
// selector this session is sending is dead (`requireTenantExists`, inside `runScopedOn`), or a
// tenant the request NAMED does not exist (`GET /v1/tenants/:id` and the admin services). Only the
// first obliges the client to drop what it is holding, and a client that reconciled on the key or on
// the status alone would clear a perfectly good selection whenever the operator opened a tenant that
// had just been deleted from the tenants list — a routine thing to do on that page.
//
// It rides in a HEADER rather than in the body because of who has to read it: `onResponse` in
// src/client/lib/api.ts sees the `Response` before Eden parses it, and reading the body there
// consumes the stream Eden is about to read. The body's one machine-readable key is `field`, whose
// contract above is an INPUT the operator can go and fix; an ambient target is not one. Issue #252.
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
    // The signal rides beside the body, not in it: every existing reader of this refusal keeps
    // reading the same keys, and `field` stays for refusals that are about an input.
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
    // The decision this whole shape exists for. Same status, same key, same sentence — and the
    // browser must not touch its selection over it.
    const { status, rejected, body } = await refusal(
      "/__refusal/named-tenant",
      "en",
    );
    expect(status).toBe(404);
    expect(rejected).toBeNull();
    expect(body).toEqual({ error: "Tenant not found" });
  });
});

// ── issue #263 ───────────────────────────────────────────────────────────────────────────────────
// The other half of what this app puts on the wire when something goes wrong. The refusals above are
// the ones it MEANS to answer; these are the ones it did not plan for.
//
// `src/app.ts` redacts a 500 to "Something went wrong" outside development, but only in the
// `INTERNAL_SERVER_ERROR` arm — and an unhandled error does not arrive with that code. It arrives as
// `UNKNOWN`, falls through `default:`, and Elysia's built-in handler answers with the error's own
// text, so whatever the message happened to carry went to the client.
//
// These live in THIS file rather than their own, and that is not filing convenience. A second test
// file that drives the exported app singleton makes the routes registered above stop matching (they
// answer 200 from the SPA catch-all instead of the refusal), reproducible with a six-line file and
// not avoided by registering in `beforeAll`. Until that is understood, one file owns this app.

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
// The shapes a two-name list walked past: the thrown value already carries a `code`, and Elysia
// hands THAT to the handler instead of UNKNOWN. These are the errors whose message actually holds
// something — a query fragment, a filesystem path.
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
// The NUMERIC half of the same hole: Elysia copies these into `code` too, and a rule that read a
// numeric code as "a status the handler chose" passed both straight through.
app.get("/__unhandled/domexception", () => {
  throw new DOMException(`connection failed: ${SECRET}`, "DataCloneError");
});
app.get("/__unhandled/numericcode", () => {
  throw Object.assign(new Error(`connection failed: ${SECRET}`), { code: 23 });
});
// Not a throw at all: the handler returns fine and the FAILURE happens while the response is
// serialized. This is the shape that surfaced the bug (issue #253), and the one that answered with
// the error's class name rather than a bare message.
app.get("/__unhandled/serialize", () => ({ id: 1n }));
// An unhandled error that carries its OWN `status`. Elysia seeds `set.status` from that property
// before this handler runs, and the access log reads `set.status`, not the Response's — so the two
// disagree unless the arm syncs it.
app.get("/__logged/carries-status", () => {
  throw Object.assign(new Error(`connection failed: ${SECRET}`), {
    status: 401,
  });
});
// Not this PR's arm, but the same invariant, found by sweeping for it: the BigInt guard answers a
// raw 400 and was logging 500.
// An unhandled failure that CALLS ITSELF one of Elysia's refusals. Elysia forwards the thrown
// value's own `code`, so each of these used to be routed by the branch that reads `code` — the
// VALIDATION one was answered 422 in the app's schema vocabulary and the NOT_FOUND one 404, neither
// of which is what they are.
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
  // NOTE: Elysia's, aliased — this file already imports the APP's NotFoundError for the #252 block,
  // and that one is an AppError answered by an entirely different arm.
  throw new ElysiaNotFoundError();
});
// A genuine NotFoundError carrying a `status` of its own. Elysia seeds `set.status` from that
// property, so this is the 404 arm's version of the `status: 401` case below: the wire says 404 and
// the access log says 418 unless that arm syncs `set.status` too.
app.get("/__real/notfound-status", () => {
  throw Object.assign(new ElysiaNotFoundError(), { status: 418 });
});
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

  // The finding itself.
  test.each([...UNHANDLED])("%s does not leak the message", async (shape) => {
    const { body } = await unhandled(shape);
    expect(body).not.toContain(SECRET);
    expect(body).not.toContain("connection failed");
  });

  // Asserted positively, not as another "does not contain": the serialize shape answered
  // `{"name":"TypeError","message":…}`, so a body carrying no secret can still name the class that
  // failed. Pinning the whole body rules both out at once.
  test.each([...UNHANDLED])(
    "%s answers the redaction, nothing else",
    async (shape) => {
      expect((await unhandled(shape)).body).toBe("Something went wrong");
    },
  );
});

// The complement, and the reason the arm lists UNKNOWN and stops there. Both of these are rejected
// before the handler and already have a specific, correct answer; folding them into the 500 arm
// replaces a usable refusal with "Something went wrong". Measured while mutation-testing the fix:
// adding either code to the arm changed nothing any test could see, which is what a guard with no
// coverage looks like.
// A status the handler CHOSE has to survive the redaction, or the guard would swallow deliberate
// answers along with the accidents. This is the one member of the pass-through list that is not a
// refusal Elysia raised on the caller's behalf, so it is asserted rather than assumed.
app.get("/__chosen/teapot", ({ status }) => status(418, "deliberate"));

// NOTE: Elysia freezes its route table on the first request it serves, and the app is a singleton
// several test files import. A route registered after some OTHER file has already called `handle`
// is silently dropped and answers the SPA catch-all instead, so the tests here passed or failed on
// file ordering. Measured: two files that each register a route and hit it, run together, and the
// one that registered second answered 200 `{}`. `compile()` rebuilds the table, and it has to stay
// below the LAST route this file registers.
//
// Moved down here when the #263 block arrived below it. Measured with it left in place: every route
// registered after it was missing, and 19 of this file's tests failed running the file ALONE. The
// note above already said "below the LAST route"; the call simply stopped being there.

// Telling a refusal from something wearing its name. The table in tests/api/lib/unhandled-error
// .test.ts states that an error calling itself VALIDATION is an unhandled failure; these assert the
// app actually routes it that way, which is a different claim and the one that was false — every
// branch that read `code` answered the impostor as though it were the real thing.
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

// file ordering. Measured: two files that each register a route and hit it, run together, and the
// one that registered second answered 200 `{}`. `compile()` rebuilds the table, and it has to stay
// below the LAST route this file registers.
// The sweep's route, registered HERE and not next to its own describe below, because of the note
// directly above: everything this file serves must be declared before `compile()` freezes the table.
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

// What the ACCESS LOG says happened, which is a different question from what the client got.
// `onAfterResponse` logs `set.status`; a raw `Response` alone does not move it. Elysia seeds it from
// the thrown value's own `status`, so an error carrying `status: 401` is answered 500 and recorded
// as 401 — the response is right and the log is wrong, which is the worse of the two failures
// because nothing on the wire shows it.
describe("the access log records the status actually answered", () => {
  // `onAfterResponse` runs after `handle` has already resolved, so the line is not there yet when
  // the await returns. Poll for it and THROW when it never arrives: a bare timeout would let a
  // missing access log read as `undefined` and turn a real regression into a wording mismatch.
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

  test("the BigInt guard's raw 400 is logged as 400, not 500", async () => {
    expect(await wireStatusFor("/__logged/bigint")).toBe(400);
    expect(await loggedStatusFor("/__logged/bigint")).toBe("400");
  });
});

// The sentence a refusal answered, or a THROW naming why there is none.
//
// A status other than the 400 the route raises means the request never reached the handler: the rate
// limiter answering 429 (this file shares the app singleton, and its 600/min bucket, with every
// other file in the worker), or the SPA catch-all answering a route registered after `compile()`.
// Both hand back a body with no `error`, which would otherwise read as "the catalog answered
// nothing" for all 161 keys at once — a harness failure reported as a catalog finding. Measured:
// moving the route below `compile()` produces exactly that, 200 with `{}`.
//
// A function, and not an inline `if`, because live data never trips it: with the route where it
// belongs every answer is a 400, so a blinded check would pass the sweep unchanged. The control is
// below.
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

// Empty, and it has to stay argued rather than merely true: an API refusal is a sentence written for
// a reader, so two languages spelling one identically means one of them was never written. A short
// UI label can legitimately be the same word in both (the client catalog has those); this catalog
// has none, and a key arriving here is a translation that was skipped, not a coincidence.
const WIRE_IDENTICAL_IN_BOTH: string[] = [];

// ONE pass over the catalog, shared by the assertions below, because the requests are real: they go
// through the app's own middleware chain, rate limiter included (600/min, src/config.ts). Two passes
// over 158 keys in two locales is 632 requests and trips it — which is itself the evidence that
// these are not calls to a helper dressed up as a request.
// LAZY, and deliberately not a module-level IIFE: `app.get` above recompiles Elysia's router, and a
// sweep that starts at module load races that registration — every request 404s with no `error`
// field, so all 161 keys come back "" and the failure reads like a broken catalog rather than a
// broken harness. Building it on first use puts it after the module body has run.
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
    // The two shapes measured on this file: the limiter, and a route the router never learned.
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
    // The control for a sweep whose expected result is "nothing found": an app that stopped honouring
    // Accept-Language, or a harness answering "" to everything, lands every key in `sameInBoth`
    // rather than here. Without this line both states read as a pass.
    expect(differed.length).toBe(
      (await runSweep()).size - WIRE_IDENTICAL_IN_BOTH.length,
    );
  });

  // The ledger above is subtracted from a set derived from the catalog, so appending to it silences
  // a key that was never translated AND keeps the assertion above true. Pinned at the size it was
  // argued into, which here is zero: this ledger has to refuse its FIRST entry.
  // tests/utils/ledger.ts carries the measurement (issue #293).
  test("the wire-identical ledger may only shrink", () => {
    expectWaiverLedger("WIRE_IDENTICAL_IN_BOTH", WIRE_IDENTICAL_IN_BOTH, 0);
  });
});
