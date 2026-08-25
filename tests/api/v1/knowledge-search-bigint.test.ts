import { afterAll, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import type { SearchParams } from "@/modules/rag/service";
import type { ChunkHit } from "@/modules/rag/sql";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// Issue #253. `POST /v1/knowledge/search` answered 500 on every search that MATCHED something: the
// handler spread the row and stringified two of its three bigint columns, so `documentId` reached
// the serializer as a BigInt and `JSON.stringify` refused it. The empty-result case serialized fine,
// which is why the endpoint looked half-alive.
//
// Driven through the REAL app rather than a mirrored route, because the defect is not in the
// projection alone: it is in what the route puts on the wire. A copy of the handler here would have
// asserted its own mapping and said nothing about the endpoint's.

// happy-dom's Request DROPS the Cookie header (forbidden), so a cookie-authenticated route driven
// through app.handle() needs Bun's native constructor. See tests/dom-setup.ts.
const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();

// One hit, every field a ChunkHit carries — the typed literal is what makes a bigint column added
// later show up here as a compile error instead of as a 500 in production.
const HIT: ChunkHit = {
  id: 10n,
  knowledgeBaseId: 20n,
  knowledgeBaseName: "Support",
  documentId: 30n,
  documentTitle: "Refund policy",
  content: "Refunds are issued within 5 business days.",
  metadata: { sourceUrl: "https://example.com/refunds" },
  distance: 0.12,
};

const ragService = await import("@/modules/rag/service");
const searchKnowledge = mock(
  async (_params: SearchParams): Promise<ChunkHit[]> => [HIT],
);
// Spread the real module: the controller imports a dozen other names from it, and replacing the
// whole module with one function would break the route graph at import time.
mock.module("@/modules/rag/service", () => ({
  ...ragService,
  searchKnowledge,
}));

const app = (await import("@/app")).default;

// `mock.module` is GLOBAL to the process and outlives this file for every other test in the same
// worker. Spreading the real module already keeps the leak inert (only `searchKnowledge` differs,
// and no other suite calls it), but put the module back anyway so file order can never matter.
afterAll(() => {
  mock.module("@/modules/rag/service", () => ragService);
});

// The session the route runs under: an AGENT with a tenant, which is what `requireAuth: true` asks
// for. Minted with the app's own signer, not hand-rolled.
mockFindUnique.mockImplementation(() => Promise.resolve(mockUser));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(mockUser),
  }));
const { token } = (await (
  await tokenApp.handle(
    new Request("http://localhost/mint", { method: "POST" }),
  )
).json()) as { token: string };

async function search(): Promise<Response> {
  return app.handle(
    new BunRequest("http://localhost/api/v1/knowledge/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `fazerai_auth_token=${token}`,
      },
      body: JSON.stringify({ query: "refund" }),
    }),
  );
}

describe("POST /v1/knowledge/search with a matching chunk", () => {
  test("answers 200, not the BigInt serialization 500", async () => {
    const res = await search();
    expect(res.status).toBe(200);
  });

  test("every id reaches the client as a string, documentId included", async () => {
    const body = (await (await search()).json()) as {
      hits: Array<Record<string, unknown>>;
    };
    expect(body.hits).toHaveLength(1);
    const hit = body.hits[0] as Record<string, unknown>;
    expect(hit.id).toBe("10");
    expect(hit.knowledgeBaseId).toBe("20");
    expect(hit.documentId).toBe("30");
  });

  test("no field of the response is left as a BigInt", async () => {
    const body = (await (await search()).json()) as {
      hits: Array<Record<string, unknown>>;
    };
    // The response already came back as JSON, so nothing in it CAN be a bigint — the assertion that
    // carries weight is on the value the handler built, which is what the status test above covers.
    // This one pins the field set, so a bigint column added to ChunkHit cannot ride the spread out
    // unnoticed: it would appear here and have to be given a spelling on purpose.
    expect(Object.keys(body.hits[0] as object).sort()).toEqual(
      Object.keys(HIT).sort(),
    );
  });

  test("the payload the client asked for is what the service was called with", () => {
    expect(searchKnowledge).toHaveBeenCalled();
    expect(searchKnowledge.mock.calls[0]?.[0]?.query).toBe("refund");
  });
});
