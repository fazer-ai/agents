import { afterEach, describe, expect, jest, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { ChatwootClient } from "@/modules/chatwoot/client";
import { listCredentialCalendars } from "@/modules/integrations/google-calendar.service";
import { listCredentialDriveFolders } from "@/modules/integrations/google-drive.service";
import { asaasToolpack } from "@/modules/integrations/toolpacks/asaas";
import { googleCalendarToolpack } from "@/modules/integrations/toolpacks/google-calendar";
import { googleDriveToolpack } from "@/modules/integrations/toolpacks/google-drive";
import type {
  IntegrationSelection,
  ToolpackCtx,
} from "@/modules/integrations/toolpacks/types";
import {
  exchangeCodeForTokens,
  revokeGoogleToken,
} from "@/modules/vault/google-oauth";
import { discoverOAuthServer } from "@/modules/vault/mcp-oauth";

// Every outbound caller in this family bounds the WHOLE exchange, the body included: a provider
// that answers its headers and then stalls its body must end the call at the caller's budget
// instead of holding a turn, a console request or a disconnect forever. Each caller below is handed
// exactly that provider and a fake clock, which is advanced far past any budget; the call has to
// settle. The HTTP tool is held to the same rule in tests/graph/tools-http-body-bound.test.ts.

const enc = new TextEncoder();

// Headers at once, one chunk of body, then nothing until the request's own signal aborts.
const stalledBody = (async (_url: string | URL | Request, init?: RequestInit) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('{"items":['));
        init?.signal?.addEventListener("abort", () =>
          c.error(new Error("The operation was aborted.")),
        );
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )) as unknown as typeof fetch;

const PENDING = "still waiting on the body";

// Advances the fake clock in large steps, letting the call's own awaits run between them. Answers
// with what the call settled to (the error's message, or the value a tool returned, since a tool
// reports a failure as text) and how many advances it took: a call that settles with the clock
// standing still never waited on the body, so it proves nothing about the bound. Ten minutes covers
// every budget in the family several times.
async function settlesOnTheClock(
  call: () => Promise<unknown>,
): Promise<{ outcome: string; advances: number }> {
  jest.useFakeTimers();
  let outcome: string = PENDING;
  let advances = 0;
  try {
    call().then(
      (value) => {
        outcome = String(value);
      },
      (err: unknown) => {
        outcome = err instanceof Error ? err.message : String(err);
      },
    );
    for (let i = 0; i < 50; i++) await Promise.resolve();
    while (advances < 20 && outcome === PENDING) {
      jest.advanceTimersByTime(30_000);
      advances += 1;
      for (let i = 0; i < 50; i++) await Promise.resolve();
    }
  } finally {
    jest.useRealTimers();
  }
  return { outcome, advances };
}

// What a cut exchange says: the bound, never a stream's own "aborted" and never a hang.
const CUT = /did not answer within \d+(\.\d+)?s/;

afterEach(() => {
  jest.useRealTimers();
});

const ctx = { tenantId: 1n, userId: null, role: "TENANT_ADMIN" } as const;
const noBase = undefined as unknown as PrismaClient;

function toolpackCtx(over: Partial<ToolpackCtx> = {}): ToolpackCtx {
  return {
    tenantId: 1n,
    base: noBase,
    threadId: "1:1:1",
    contactDbId: 7n,
    resolveCredential: async () => "tok_live",
    assertSafe: async () => undefined,
    fetchImpl: stalledBody,
    ...over,
  };
}

function sel(
  catalogType: IntegrationSelection["catalogType"],
  tool: string,
): IntegrationSelection {
  return {
    instanceId: 1n,
    catalogType,
    config: {},
    credentialRef: "cred",
    enabledTools: [tool],
  };
}

// Waited on the body, and was cut by the clock rather than by anything else.
function expectCut(
  r: { outcome: string; advances: number },
  says: RegExp = CUT,
): void {
  expect(r.advances).toBeGreaterThan(0);
  expect(r.outcome).toMatch(says);
}

describe("a stalled body ends the call at its budget", () => {
  test("an Asaas tool", async () => {
    const [tool] = asaasToolpack.build(
      sel("ASAAS", "asaas_payment_status"),
      toolpackCtx(),
    );
    expectCut(
      await settlesOnTheClock(() =>
        (tool as NonNullable<typeof tool>).invoke({ paymentLinkId: "p1" }),
      ),
      /Failed to reach the payment provider/,
    );
  });

  test("a Google Calendar tool", async () => {
    const [tool] = googleCalendarToolpack.build(
      {
        ...sel("GOOGLE_CALENDAR", "calendar_list_events"),
        config: { calendarIds: ["primary"] },
      },
      toolpackCtx(),
    );
    const r = await settlesOnTheClock(() =>
      (tool as NonNullable<typeof tool>).invoke({}),
    );
    expect(r.advances).toBeGreaterThan(0);
    expect(r.outcome).not.toBe(PENDING);
  });

  test("a Google Drive search", async () => {
    const [tool] = googleDriveToolpack.build(
      sel("GOOGLE_DRIVE", "drive_find_file"),
      toolpackCtx(),
    );
    expectCut(
      await settlesOnTheClock(() =>
        (tool as NonNullable<typeof tool>).invoke({ query: "manual" }),
      ),
      /Failed to reach Google Drive/,
    );
  });

  // The download is the second request of the tool: the metadata answers whole, the bytes stall.
  test("a Google Drive download", async () => {
    const metadataThenStall = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const u = String(url);
      if (u.includes("alt=media") || u.includes("/export")) {
        return stalledBody(url, init);
      }
      return new Response(
        JSON.stringify({
          name: "manual.pdf",
          mimeType: "application/pdf",
          size: "5",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const sent: unknown[] = [];
    const [tool] = googleDriveToolpack.build(
      sel("GOOGLE_DRIVE", "drive_send_file"),
      toolpackCtx({
        fetchImpl: metadataThenStall,
        chatwoot: {
          client: {
            muted: false,
            sendFileAttachment: async (...args: unknown[]) => {
              sent.push(args);
              return {};
            },
          } as never,
          conversationId: 5,
        },
      }),
    );
    expectCut(
      await settlesOnTheClock(() =>
        (tool as NonNullable<typeof tool>).invoke({ fileId: "f1" }),
      ),
      /Failed to download the file from Google Drive/,
    );
    expect(sent).toEqual([]);
  });

  test("the console's calendar list", async () => {
    expectCut(
      await settlesOnTheClock(() =>
        listCredentialCalendars(
          ctx as unknown as TenantContext,
          "vault:1",
          noBase,
          {
            resolveEntry: async () => ({ kind: "google_oauth" }),
            resolveToken: async () => "tok",
            assertSafe: async () => undefined,
            fetchImpl: stalledBody,
          },
        ),
      ),
    );
  });

  test("the console's Drive folder list", async () => {
    expectCut(
      await settlesOnTheClock(() =>
        listCredentialDriveFolders(
          ctx as unknown as TenantContext,
          "vault:1",
          noBase,
          {
            resolveEntry: async () => ({ kind: "google_oauth" }),
            resolveToken: async () => "tok",
            assertSafe: async () => undefined,
            fetchImpl: stalledBody,
          },
        ),
      ),
    );
  });

  test("the Google token exchange", async () => {
    globalThis.fetch = stalledBody;
    expectCut(
      await settlesOnTheClock(() =>
        exchangeCodeForTokens({
          code: "c",
          clientId: "id",
          clientSecret: "secret",
          redirectUri: "https://203.0.113.10/cb",
          codeVerifier: "v",
        }),
      ),
    );
  });

  test("the MCP authorization-server discovery", async () => {
    globalThis.fetch = stalledBody;
    expectCut(
      await settlesOnTheClock(() =>
        discoverOAuthServer("https://203.0.113.10/mcp", {
          allowPrivate: false,
          allowHttp: false,
        }),
      ),
    );
  });

  // A different mechanism, the same property: `AbortSignal.timeout` stays armed through the body
  // read, so there is no timer for the client to clear too early.
  test("a Chatwoot read", async () => {
    const client = new ChatwootClient(
      {
        baseUrl: "https://chat.example.com",
        accountId: 5,
        adminToken: "admin",
        botToken: "bot",
      },
      stalledBody,
    );
    const r = await settlesOnTheClock(() => client.getMessages(9));
    expect(r.advances).toBeGreaterThan(0);
    expect(r.outcome).not.toBe(PENDING);
  });
});

// The revoke reads no answer at all, so it must not wait for one: the disconnect awaits it before
// it removes the local tokens. It settles with the clock standing still.
test("the Google revoke does not wait for a body nobody reads", async () => {
  globalThis.fetch = stalledBody;
  let settled = false;
  const revoke = revokeGoogleToken("refresh").then(() => {
    settled = true;
  });
  for (let i = 0; i < 50 && !settled; i++) await Promise.resolve();
  await Promise.race([revoke, Bun.sleep(20)]);
  expect(settled).toBe(true);
});
