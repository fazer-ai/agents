import { describe, expect, test } from "bun:test";
import { errors } from "@/api/lib/openapi";
import { REJECTED_TENANT_SELECTOR_HEADER } from "@/lib/console-params";
import {
  ActiveTenantNotFoundError,
  AppError,
  NotFoundError,
} from "@/lib/errors";
import { SettingsTextTooLongError } from "@/modules/agents/service";
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
// NOTE: Elysia freezes its route table on the first request it serves, and the app is a singleton
// several test files import. A route registered after some OTHER file has already called `handle`
// is silently dropped and answers the SPA catch-all instead, so the tests below passed or failed on
// file ordering. Measured: two files that each register a route and hit it, run together, and the
// one that registered second answered 200 `{}`. `compile()` rebuilds the table, and it has to stay
// below the LAST route this file registers.
app.compile();

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
