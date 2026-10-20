import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { SignJWT } from "jose";
import logger from "@/api/lib/logger";
import config from "@/config";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The instance-wide limiter on a route that declares 429: its refusal must reach the caller as a 429
// in the error shape, not fail the route's response schema and turn into a 500. Driven on the SDK's
// turn, where other traffic from the same address can spend the shared budget while the SDK's own
// lookup budget is still open, and where the app's page must be able to read the refusal.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();

const ORIGIN = "https://app.exemplo.com";
const KEY = "chave-da-aplicacao-de-teste-0123456789";
const APP = {
  id: 77n,
  tenantId: 5n,
  agentId: 9n,
  publicId: "app_teste",
  allowedOrigins: [ORIGIN],
  anonymousEnabled: false,
  anonSessionsPerHour: 20,
  anonMessagesPerMin: 10,
  monthlyCeilingCents: null,
  turnstileSecret: null,
  keys: new Map([["key_a", KEY]]),
};

const apps = { ...(await import("@/modules/client-apps/service")) };
mock.module("@/modules/client-apps/service", () => ({
  ...apps,
  resolveClientApp: async (publicId: string) =>
    publicId === APP.publicId ? APP : null,
}));

const wasEnabled = config.clientChannel.enabled;
const wasBudget = config.rateLimit.userPerMin;
config.clientChannel.enabled = true;
config.rateLimit.userPerMin = 2;
// An app of its own, built after the budget is set: the limiters read it when they are
// constructed, and the module's default app may already exist for another file.
const { buildApp } = await import("@/app");
const server = await buildApp();

afterAll(() => {
  config.clientChannel.enabled = wasEnabled;
  config.rateLimit.userPerMin = wasBudget;
  mock.module("@/modules/client-apps/service", () => apps);
});

test("the shared budget spent elsewhere answers the SDK turn with a readable 429, not a 500", async () => {
  for (let i = 0; i < 2; i++)
    await server.handle(
      new BunRequest("http://localhost/api/v1/nao-existe", { method: "GET" }),
    );
  // NOTE: the SDK's own lookup budget is a separate bucket, so the address still passes it here.
  config.rateLimit.userPerMin = 1000;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", kid: "key_a" })
    .setAudience(APP.publicId)
    .setSubject("42")
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(KEY));
  const post = () =>
    server.handle(
      new BunRequest(`http://localhost/api/v1/sdk/${APP.publicId}/turn`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "oi", clientTools: [] }),
      }),
    );
  const logged: string[] = [];
  const spy = spyOn(logger, "info").mockImplementation(((
    ...args: unknown[]
  ) => {
    logged.push(args.map(String).join(" "));
  }) as never);
  const first = await post();
  const second = await post();
  await new Promise((r) => setTimeout(r, 20));
  spy.mockRestore();
  const answers = [];
  for (const res of [first, second])
    answers.push({
      status: res.status,
      body: await res.json(),
      acao: res.headers.get("access-control-allow-origin"),
    });
  const refused = {
    status: 429,
    body: { error: "Rate limit exceeded. Please try again later." },
    acao: ORIGIN,
  };
  expect(answers).toEqual([refused, refused]);
  expect(
    logged.filter((l) => l.includes("/api/v1/sdk/") && l.endsWith(" 429"))
      .length,
  ).toBe(2);
});
