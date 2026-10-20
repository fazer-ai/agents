import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Blob as NativeBlob } from "node:buffer";
import { SignJWT } from "jose";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The widget's microphone at the request boundary: the page sends a recording with the same token as
// the turn, and the instance answers the agent's transcription of it. The token is verified for real,
// the anonymous session is minted for real; the app lookup, the transcription and the spend figures
// are replaced. What this file proves: the door is the turn's (origin, token, budget, ceilings), the
// recording reaches the agent's speech-to-text under the app's tenant, told whether it is anonymous,
// a recording too large is refused before it is read or charged, and a refusal of the agent's
// speech-to-text reaches the page as its key.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();

const ORIGIN = "https://app.exemplo.com";
const KEY = "chave-da-aplicacao-de-teste-0123456789";
const base = {
  tenantId: 5n,
  agentId: 9n,
  allowedOrigins: [ORIGIN],
  anonymousEnabled: true,
  anonSessionsPerHour: 20,
  anonMessagesPerMin: 10,
  monthlyCeilingCents: null,
  turnstileSecret: null,
  keys: new Map([["key_a", KEY]]),
};
const APP = { ...base, id: 91n, publicId: "app_microfone" };
// Its agent has speech-to-text off.
const MUTE = { ...base, id: 92n, publicId: "app_sem_stt", agentId: 10n };
const CAPPED = {
  ...base,
  id: 93n,
  publicId: "app_microfone_teto",
  monthlyCeilingCents: 1000,
};
const TIGHT = { ...base, id: 94n, publicId: "app_microfone_justa" };
// At its ceiling, and its agent has speech-to-text off.
const MUTE_CAPPED = {
  ...CAPPED,
  id: 96n,
  publicId: "app_sem_stt_teto",
  agentId: MUTE.agentId,
};
const APPS = new Map(
  [APP, MUTE, CAPPED, TIGHT, MUTE_CAPPED].map((a) => [a.publicId, a]),
);

const apps = await import("@/modules/client-apps/service");
const realApps = { ...apps };
mock.module("@/modules/client-apps/service", () => ({
  ...realApps,
  resolveClientApp: async (publicId: string) => APPS.get(publicId) ?? null,
}));

const stt = await import("@/modules/stt/service");
const realStt = { ...stt };
const heard: Array<
  Parameters<typeof realStt.transcribeClientAudio>[0] & { size: number }
> = [];
mock.module("@/modules/stt/service", () => ({
  ...realStt,
  transcribeClientAudio: async (
    p: Parameters<typeof realStt.transcribeClientAudio>[0],
  ) => {
    // As the real one: the agent's speech-to-text is checked first, and the ceilings the caller
    // hands over are asked immediately before the provider.
    if (p.agentId === MUTE.agentId)
      throw new AppError(
        "speech-to-text is not configured",
        400,
        "errors.sttNotConfigured",
      );
    await p.beforeCall?.();
    heard.push({ ...p, size: p.audio.byteLength });
    return "quero ver minhas notas";
  },
}));

const channel = await import("@/modules/client-channel/service");
const realChannel = { ...channel };
mock.module("@/modules/client-channel/service", () => ({
  ...realChannel,
  runClientTurn: async () => ({
    threadId: "t1",
    status: "done" as const,
    reply: "oi",
  }),
}));

const spend = await import("@/modules/spend-ceiling/service");
const realSpend = { ...spend };
mock.module("@/modules/spend-ceiling/service", () => ({
  ...realSpend,
  readSpendSnapshot: async (_t: bigint, source: string) =>
    source === `app:${CAPPED.id}` || source === `app:${MUTE_CAPPED.id}`
      ? {
          costUsd: 10,
          polledAt: new Date(),
          pollError: null,
          pollFailedAt: null,
        }
      : null,
}));

const server = (await import("@/app")).default;

const was = { ...config.clientChannel, sdk: { ...config.clientChannel.sdk } };
afterAll(() => {
  config.clientChannel.enabled = was.enabled;
  config.clientChannel.sdk = was.sdk;
  mock.module("@/modules/client-apps/service", () => realApps);
  mock.module("@/modules/stt/service", () => realStt);
  mock.module("@/modules/client-channel/service", () => realChannel);
  mock.module("@/modules/spend-ceiling/service", () => realSpend);
});

async function sign(app = APP.publicId, sub = "42") {
  return new SignJWT({ name: "Ana" })
    .setProtectedHeader({ alg: "HS256", kid: "key_a" })
    .setAudience(app)
    .setSubject(sub)
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(KEY));
}

// A recording as the widget's form carries it.
function recording(bytes = 2048, type = "audio/webm", name = "voz.webm") {
  return { bytes, type, name };
}

// The multipart written out by hand: Bun's Request does not serialize happy-dom's FormData, and
// `t.File` checks `instanceof Blob` against the global, which happy-dom replaced.
function multipart(audio: { bytes: number; type: string; name: string }) {
  const boundary = "----voz-boundary";
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${audio.name}"\r\nContent-Type: ${audio.type}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + audio.bytes + tail.length);
  body.set(head, 0);
  body.set(tail, head.length + audio.bytes);
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

async function transcribe(
  opts: {
    app?: string;
    origin?: string | null;
    token?: string;
    audio?: { bytes: number; type: string; name: string };
    // The length the request declares, when it is not the body's own.
    declaredLength?: number;
  } = {},
) {
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  const { body, type } = multipart(opts.audio ?? recording());
  const happyDomBlob = globalThis.Blob;
  globalThis.Blob = NativeBlob as unknown as typeof Blob;
  try {
    return await server.handle(
      new BunRequest(
        `http://localhost/api/v1/sdk/${opts.app ?? APP.publicId}/transcribe`,
        {
          method: "POST",
          headers: {
            "content-type": type,
            // NOTE: a browser always declares a Blob or FormData body's length; Bun's Request here does not.
            "content-length": String(opts.declaredLength ?? body.length),
            ...(origin ? { origin } : {}),
            ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          },
          body,
        },
      ),
    );
  } finally {
    globalThis.Blob = happyDomBlob;
  }
}

function turn(token: string, app = APP.publicId) {
  return server.handle(
    new BunRequest(`http://localhost/api/v1/sdk/${app}/turn`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "oi", clientTools: [] }),
    }),
  );
}

async function anonymousToken(app = APP.publicId): Promise<string> {
  const res = await server.handle(
    new BunRequest(`http://localhost/api/v1/sdk/${app}/session`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "{}",
    }),
  );
  return ((await res.json()) as { token: string }).token;
}

const acao = (r: Response) => r.headers.get("access-control-allow-origin");

describe("the SDK's transcription at the request boundary", () => {
  beforeEach(() => {
    config.clientChannel.enabled = true;
    config.clientChannel.sdk = { userPerMin: 1000, appPerMin: 1000 };
    heard.length = 0;
  });

  test("a signed-in user's recording is transcribed by the app's agent, under the app's tenant, as the client channel", async () => {
    const res = await transcribe({ token: await sign() });
    const p = heard[0];
    expect({
      status: res.status,
      acao: acao(res),
      body: await res.json(),
      tenant: p?.ctx.tenantId,
      agent: p?.agentId,
      mime: p?.mimeType,
      size: p?.size,
      anonymous: p?.anonymous,
    }).toEqual({
      status: 200,
      acao: ORIGIN,
      body: { text: "quero ver minhas notas" },
      tenant: 5n,
      agent: 9n,
      mime: "audio/webm",
      size: 2048,
      anonymous: false,
    });
  });

  test("an anonymous visitor's token transcribes too, and the transcription is told so", async () => {
    const res = await transcribe({ token: await anonymousToken() });
    expect({
      status: res.status,
      anonymous: heard[0]?.anonymous,
    }).toEqual({ status: 200, anonymous: true });
  });

  test("a foreign origin is refused with no CORS header, and no token is refused as the turn refuses it", async () => {
    const foreign = await transcribe({
      token: await sign(),
      origin: "https://outro.exemplo.com",
    });
    const tokenless = await transcribe();
    expect({
      foreign: foreign.status,
      foreignAcao: acao(foreign),
      tokenless: tokenless.status,
      tokenlessAcao: acao(tokenless),
      heard: heard.length,
    }).toEqual({
      foreign: 403,
      foreignAcao: null,
      tokenless: 401,
      tokenlessAcao: ORIGIN,
      heard: 0,
    });
  });

  test("an agent with speech-to-text off answers its key, for the widget to say so", async () => {
    const res = await transcribe({
      app: MUTE.publicId,
      token: await sign(MUTE.publicId),
    });
    expect({
      status: res.status,
      acao: acao(res),
      code: ((await res.json()) as { error?: string }).error,
    }).toEqual({
      status: 400,
      acao: ORIGIN,
      code: "Speech-to-text is not configured for this workspace.",
    });
  });

  test("a recording over the ceiling is refused with 413 before it is charged, by its declared length or once read", async () => {
    config.clientChannel.sdk = { userPerMin: 1, appPerMin: 1000 };
    const token = await sign(APP.publicId, "grande");
    // Over by its declared length, refused on the header alone, before the multipart is read; and
    // over by a byte, which only the read file shows.
    const declared = await transcribe({
      token,
      declaredLength: 5 * 1024 * 1024,
    });
    const read = await transcribe({
      token,
      audio: recording(4 * 1024 * 1024 + 1),
    });
    const after = await transcribe({ token });
    expect({
      declared: declared.status,
      read: read.status,
      acao: acao(read),
      error: ((await read.json()) as { error?: string }).error,
      after: after.status,
      heard: heard.length,
    }).toEqual({
      declared: 413,
      read: 413,
      acao: ORIGIN,
      error: "Audio file is too large",
      after: 200,
      heard: 1,
    });
  });

  test("something that is not audio is refused with 415", async () => {
    const res = await transcribe({
      token: await sign(),
      audio: recording(10, "text/plain", "notas.txt"),
    });
    expect({ status: res.status, heard: heard.length }).toEqual({
      status: 415,
      heard: 0,
    });
  });

  test("an app at its monthly ceiling is refused before anything is transcribed", async () => {
    const res = await transcribe({
      app: CAPPED.publicId,
      token: await sign(CAPPED.publicId),
    });
    expect({
      status: res.status,
      code: ((await res.json()) as { error?: string }).error,
      heard: heard.length,
    }).toEqual({
      status: 429,
      code: "This application has reached its monthly spend ceiling",
      heard: 0,
    });
  });

  test("an app at its ceiling whose agent takes no voice is told the agent takes no voice", async () => {
    const res = await transcribe({
      app: MUTE_CAPPED.publicId,
      token: await sign(MUTE_CAPPED.publicId),
    });
    expect({
      status: res.status,
      error: ((await res.json()) as { error?: string }).error,
    }).toEqual({
      status: 400,
      error: "Speech-to-text is not configured for this workspace.",
    });
  });

  test("a transcription spends the same per-user budget as the turn", async () => {
    config.clientChannel.sdk = { userPerMin: 2, appPerMin: 1000 };
    const token = await sign(TIGHT.publicId, "falante");
    const first = await transcribe({ app: TIGHT.publicId, token });
    const second = await turn(token, TIGHT.publicId);
    const third = await transcribe({ app: TIGHT.publicId, token });
    expect({
      statuses: [first.status, second.status, third.status],
      retryAfter: third.headers.get("retry-after") !== null,
    }).toEqual({ statuses: [200, 200, 429], retryAfter: true });
  });

  // `app.handle` runs with no server, so a stand-in records what the handler asks of it: Bun's idle
  // timeout (Elysia's 30 s) would cut a provider call that takes up to its own 60 s.
  test("a transcription lifts the idle timeout, as the turn does, so a slow provider is not cut", async () => {
    type StandIn = {
      requestIP: (r: Request) => { address: string };
      timeout: (r: Request, s: number) => void;
    };
    const withServer = server as unknown as { server: StandIn | null };
    const real = withServer.server;
    const asked: number[] = [];
    withServer.server = {
      requestIP: () => ({ address: "198.51.100.7" }),
      timeout: (_r, seconds) => asked.push(seconds),
    };
    try {
      const res = await transcribe({
        token: await sign(APP.publicId, "lento"),
      });
      expect({ status: res.status, asked }).toEqual({
        status: 200,
        asked: [0],
      });
    } finally {
      withServer.server = real;
    }
  });

  test("off, the route answers what a missing route answers", async () => {
    config.clientChannel.enabled = false;
    const res = await transcribe({ token: await sign() });
    expect(res.status).toBe(404);
  });
});
