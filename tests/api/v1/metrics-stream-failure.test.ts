import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import type { StreamEvent } from "@/modules/analytics/rollup/stream";
import {
  type MockUserEntity,
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// A STREAM THAT FAILS PARTWAY ENDS ON A REFUSAL, NOT MID-CHUNK. Past its first event the response is
// already a 200, so an error that is no refusal (the database out of connections) thrown out of the
// generator would cut the chunked body (ERR_INCOMPLETE_CHUNKED_ENCODING in the browser) and leave
// every block in error with no retry. The REAL route over a stream that fails after its first
// snapshot: the body reads to its end, and its last event is a refusal with status 500.
setupPrismaMock();

const progress = {
  total: 1,
  ready: 1,
  computing: null,
  pending: [],
  families: Object.fromEntries(
    ["conv", "ledger", "log", "know"].map((f) => [
      f,
      { total: 1, ready: 1, noData: 0, gaps: [] },
    ]),
  ),
} as unknown as Extract<StreamEvent, { kind: "snapshot" }>["progress"];
const stream = await import("@/modules/analytics/rollup/stream");
const streamFigures = spyOn(stream, "streamFigures").mockImplementation(
  async function* () {
    yield { kind: "snapshot", progress, figures: {}, done: false };
    throw new Error("remaining connection slots are reserved");
  } as unknown as typeof stream.streamFigures,
);
const app = (await import("@/app")).default;
afterAll(() => streamFigures.mockRestore());

const admin: MockUserEntity = { ...mockUser, role: "TENANT_ADMIN" };

describe("GET /v1/metrics/stream failing partway", () => {
  test("ends on a refusal event the page can retry, with the body whole", async () => {
    mockFindUnique.mockImplementation(() => Promise.resolve(admin));
    const { token } = (await (
      await new Elysia()
        .use(authPlugin)
        .post("/mint", async ({ setAuthCookie }) => ({
          token: await setAuthCookie(admin, admin.passwordHash),
        }))
        .handle(new Request("http://localhost/mint", { method: "POST" }))
    ).json()) as { token: string };
    const BunReq = (globalThis as unknown as { BunRequest: typeof Request })
      .BunRequest;
    const res = await app.handle(
      new BunReq("http://localhost/api/v1/metrics/stream?blocks=kpis", {
        headers: { cookie: `fazerai_auth_token=${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"done":false');
    expect(body).toContain("event: refused");
    expect(body).toContain('"status":500');
  });
});
