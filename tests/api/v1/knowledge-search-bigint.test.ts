import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import type { SearchParams } from "@/modules/rag/service";
import type { ChunkHit } from "@/modules/rag/sql";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// `POST /v1/knowledge/search` must stringify every bigint column of a hit: `JSON.stringify` refuses a
// BigInt, so a missed one answers 500 on every search that MATCHES, while the empty result passes.
//
// Driven through the REAL app rather than a mirrored route, because what matters is what the route
// puts on the wire: a copy of the handler would assert its own mapping, not the endpoint's.

// happy-dom's Request DROPS the Cookie header (forbidden), so a cookie-authenticated route driven
// through app.handle() needs Bun's native constructor. See tests/dom-setup.ts.
const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();

// One hit, every field a ChunkHit carries: the typed literal is what makes a bigint column added
// later show up here as a compile error instead of as a 500 in production.
const HIT: ChunkHit = {
  id: 10n,
  knowledgeBaseId: 20n,
  knowledgeBaseName: "Support",
  documentId: 30n,
  documentTitle: "Refund policy",
  documentUrl: null,
  content: "Refunds are issued within 5 business days.",
  metadata: { sourceUrl: "https://example.com/refunds" },
  distance: 0.12,
};

const ragService = await import("@/modules/rag/service");
const searchKnowledge = mock(
  async (_params: SearchParams): Promise<ChunkHit[]> => [HIT],
);
// A SPY ON THE MODULE OBJECT, NOT A `mock.module`. The registry rewrite is process-global and its
// undo is a second rewrite, so whether another file sees the stub depends on when that file's
// imports resolve relative to this file's `afterAll`, an ordering nobody controls. A leaked stub
// silences tests/modules/tenant-selector-entry-points.test.ts, which calls the real `searchKnowledge`
// to prove it refuses a dead tenant selector.
const spy = spyOn(ragService, "searchKnowledge").mockImplementation(
  searchKnowledge,
);

const app = (await import("@/app")).default;

// The spy outlives this file for every other test in the same worker, so it is restored here.
afterAll(() => {
  spy.mockRestore();
});

// The session the route runs under: an AGENT with a tenant, which is what `requireAuth: true` asks
// for. Minted with the app's own signer, not hand-rolled.
mockFindUnique.mockImplementation(() => Promise.resolve(mockUser));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(mockUser, mockUser.passwordHash),
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
    // NOTE: the response already came back as JSON, so nothing in it CAN be a bigint; the assertion that
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
