import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import { MAX_DB_ID } from "@/lib/db-id";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// What a route does with an id in its BODY that is not one (route-id-refusal.test.ts covers the
// path and query). `BigInt` is lenient both ways: it takes spellings a column does not (`0x11` is
// 17n, `" 7 "` is 7n), handing a body that named no row one, and values past 2^63-1, which Postgres
// refuses at bind time as a 500. The refusal is a JSON 400 naming the field, in the caller's locale.
// The whole spelling set goes to ONE route and every other route gets only the out-of-range one:
// the limiter is one 600/min bucket shared by every file in the worker (see the note in
// tests/api/v1/route-id-refusal.test.ts).

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();
const app = (await import("@/app")).default;

const fleetUser = { ...mockUser, tenantId: 1n, role: "SUPER_ADMIN" as const };
mockFindUnique.mockImplementation(() => Promise.resolve(fleetUser));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(fleetUser, fleetUser.passwordHash),
  }));
const { token } = (await (
  await tokenApp.handle(
    new Request("http://localhost/mint", { method: "POST" }),
  )
).json()) as { token: string };

const send = (
  method: string,
  path: string,
  body: unknown,
  lang = "en",
): Promise<Response> =>
  app
    .handle(
      new BunRequest(`http://localhost${path}`, {
        method,
        headers: {
          cookie: `fazerai_auth_token=${token}`,
          "content-type": "application/json",
          "X-Tenant-Id": "1",
          "accept-language": lang,
        },
        body: JSON.stringify(body),
      }),
    )
    .then((res) => {
      // NOTE: the limiter's budget is one 600/min bucket shared by every test file in the worker, so
      // a 429 here is a statement about how much the SUITE spent, not about this route. Named, because
      // "Expected 400, Received 429" reads as a broken assertion in whichever file happens to fail.
      if (res.status === 429) {
        throw new Error(
          `rate-limit budget exhausted before ${method} ${path}: the worker's shared bucket ran out, ` +
            "not a failure of this route",
        );
      }
      return res;
    });

// Every route whose body carries a database id, with the name the refusal has to say back. The
// surrounding fields are whatever that route needs to REACH the id: a body its schema refuses is
// answered 422 before any handler runs, which would make this file green by measuring nothing.
interface BodyIdRoute {
  method: string;
  path: string;
  field: string;
  body: (id: string) => Record<string, unknown>;
}

const ROUTES: BodyIdRoute[] = [
  {
    method: "POST",
    path: "/api/v1/experiments/",
    field: "agentId",
    body: (id) => ({ name: "e", agentId: id, variants: [] }),
  },
  {
    method: "PATCH",
    path: "/api/v1/experiments/7",
    field: "agentId",
    body: (id) => ({ agentId: id }),
  },
  {
    method: "PATCH",
    path: "/api/v1/chatwoot/inboxes/7",
    field: "agentId",
    body: (id) => ({ agentId: id }),
  },
  {
    method: "POST",
    path: "/api/v1/knowledge/search",
    field: "knowledgeBaseIds",
    body: (id) => ({ query: "q", knowledgeBaseIds: [id] }),
  },
  {
    method: "POST",
    path: "/api/v1/knowledge/suggestions",
    field: "knowledgeBaseId",
    body: (id) => ({ knowledgeBaseId: id, content: "c" }),
  },
  {
    method: "POST",
    path: "/api/admin/invitations",
    field: "tenantId",
    body: (id) => ({ email: "a@b.co", role: "AGENT", tenantId: id }),
  },
  {
    method: "POST",
    path: "/api/v1/agents/",
    field: "businessHoursId",
    body: (id) => ({ name: "a", businessHoursId: id }),
  },
  {
    method: "PATCH",
    path: "/api/v1/agents/7",
    field: "followUpHoursId",
    body: (id) => ({ followUpHoursId: id }),
  },
];

const PAST_THE_COLUMN = (MAX_DB_ID + 1n).toString();

describe("the refusal a malformed body id produces", () => {
  test("every route refuses an id past what the column holds, naming the field", async () => {
    const wrong: string[] = [];
    for (const route of ROUTES) {
      const res = await send(
        route.method,
        route.path,
        route.body(PAST_THE_COLUMN),
      );
      const body = (await res.json().catch(() => null)) as unknown;
      const want = { error: `Not a valid ${route.field}` };
      if (res.status !== 400 || JSON.stringify(body) !== JSON.stringify(want)) {
        wrong.push(
          `${route.method} ${route.path} -> ${res.status} ${JSON.stringify(body)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  // The spelling half, spent on one route. `BigInt` converts every one of these, and four of them
  // convert to a DIFFERENT ROW than the caller typed: `0x11` is 17, `" 7 "` is 7, `+7` is 7, `1e3`
  // is 1000. On a PATCH that is an edit applied to a row nobody named.
  test("the spellings BigInt would silently convert are refused", async () => {
    const wrong: string[] = [];
    for (const raw of ["", "abc", "0x11", "+7", " 7 ", "1e3", "7.0", "-7"]) {
      const res = await send("PATCH", "/api/v1/experiments/7", {
        agentId: raw,
      });
      const body = (await res.json().catch(() => null)) as unknown;
      if (
        res.status !== 400 ||
        (body as { error?: string })?.error !== "Not a valid agentId"
      ) {
        wrong.push(
          `${JSON.stringify(raw)} -> ${res.status} ${JSON.stringify(body)}`,
        );
      }
    }
    expect(wrong).toEqual([]);
  });

  // A malformed id and a well-formed id for a row that is gone are different situations, and only
  // one of them is the caller's to fix, so a malformed id is a 400 on every field, never a 404.
  test("a malformed hours id is refused, not reported as a missing row", async () => {
    const res = await send("PATCH", "/api/v1/agents/7", {
      businessHoursId: "abc",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Not a valid businessHoursId" });
  });

  // The half the status cannot show: a plain-text body has no `error` key, so `apiErrorMessage`
  // (src/client/lib/apiError.ts) would fall back to its generic English transport sentence.
  test("it is JSON, and localized", async () => {
    const res = await send(
      "POST",
      "/api/v1/knowledge/suggestions",
      { knowledgeBaseId: "abc", content: "c" },
      "pt-BR",
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({
      error: "Não é um knowledgeBaseId válido",
    });
  });

  // The control, on the one route this file's mocked client can carry past the id. Refusing a
  // malformed id must not turn an OPTIONAL id into a required one, and the proof has to be a route
  // answering in its OWN vocabulary rather than merely not answering 400 — a 500 from somewhere
  // else satisfies "not the refusal" just as well, which is how a control goes quietly vacuous.
  test("omitting the id leaves the route's own answer alone", async () => {
    const res = await send("POST", "/api/admin/invitations", {
      email: "a@b.co",
      role: "AGENT",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "A target tenant is required" });
  });
});
