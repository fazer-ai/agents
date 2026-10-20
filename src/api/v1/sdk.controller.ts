import { fileURLToPath } from "node:url";
import { Elysia, t } from "elysia";
import { clientTurnFields } from "@/api/lib/client-turn-body";
import { doc, errors } from "@/api/lib/openapi";
import basePrisma from "@/api/lib/prisma";
import { clientKey } from "@/api/middlewares/rateLimit";
import config from "@/config";
import { getCheckpointer } from "@/graph/checkpointer";
import type { ClientToolAnswer, ClientToolSpec } from "@/graph/client-tools";
import { parseDbId } from "@/lib/db-id";
import { AppError, ForbiddenError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  anonUserId,
  mintAnonSession,
  mintAnonToken,
  readAnonSession,
} from "@/modules/client-apps/anonymous";
import {
  assertAppSpendCeiling,
  chargeAnonSession,
  chargeSdkLookup,
  chargeSdkRequest,
  SdkRateLimitError,
} from "@/modules/client-apps/limits";
import {
  type ResolvedClientApp,
  resolveClientApp,
} from "@/modules/client-apps/service";
import {
  invalidToken,
  verifyClientAppToken,
} from "@/modules/client-apps/token";
import { verifyTurnstile } from "@/modules/client-apps/turnstile";
import {
  handOverAnonymousThreads,
  listClientThreads,
  readClientTranscript,
  type ThreadCursor,
} from "@/modules/client-channel/identity";
import { runClientTurn } from "@/modules/client-channel/service";
import { streamClientTurn } from "@/modules/client-channel/stream";
import { transcribeClientAudio } from "@/modules/stt/service";
import { normalizeAudioUpload } from "@/modules/stt/upload";

// The client channel's turn as the SDK calls it: from the embedding application's browser, with a
// JWT its server signed (docs/client-channel.md, "Embedding with the SDK"). The app is named in the
// path so the preflight, which carries no token, can be answered for its origins. CORS is this
// route's own: the instance-wide policy covers the console, not an app's pages.
// translate('errors.clientAppTokenInvalid', 'Invalid token')
// translate('errors.clientAppOriginRefused', 'This origin is not allowed for the application')
// translate('errors.clientAppAnonymousDisabled', 'This application does not allow anonymous visitors')
// translate('errors.clientAppSpendCeilingReached', 'This application has reached its monthly spend ceiling')
// translate('errors.clientAppSessionUnknown', 'This anonymous session is not known; open a new one')
// translate('errors.threadCursorInvalid', 'This page cursor is not valid; ask for the list again')
// translate('errors.clientAppTurnstileFailed', 'This application needs a human check before a new anonymous session: complete the challenge and try again')

// A voice message from the widget: two minutes at the bitrate it records at fit in well under this.
const SDK_AUDIO_MAX_BYTES = 4 * 1024 * 1024;
// The multipart's boundary and part headers around the recording, allowed for in the length check.
const MULTIPART_OVERHEAD = 16 * 1024;

const ALLOWED_HEADERS = "authorization, content-type, accept, accept-language";

function originAllowed(
  app: ResolvedClientApp | null,
  origin: string | null,
): boolean {
  return origin !== null && app?.allowedOrigins.includes(origin) === true;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-max-age": "600",
    "access-control-expose-headers": "Retry-After",
    vary: "Origin",
  };
}

// The context a turn runs under: the app's tenant, with no principal behind it. The person is the
// app's user, recorded as the thread's owner, never as an actor.
function appCtx(app: ResolvedClientApp): TenantContext {
  return {
    tenantId: app.tenantId,
    userId: null,
    role: "TENANT_ADMIN",
    actorType: "system",
  };
}

// The routes a page calls from its own origin, and so the ones with the app's CORS.
const SDK_TURN_PATH =
  /^\/api\/v1\/sdk\/([^/]+)\/(turn|transcribe|threads|threads\/[^/]+\/messages|session|session\/claim)\/?$/;

// A page of the widget's list of conversations, and where the next one starts: the last thread's
// activity (epoch ms) and its id, which the list is ordered by. Opaque to the page.
const THREADS_PAGE = 20;
const THREAD_CURSOR = /^(\d{1,15})_(\d+:client:\d+:[0-9a-f-]{36})$/;

// A page of a reopened conversation's messages, from the newest back; `before` is a message id.
const TRANSCRIPT_PAGE = 50;

function encodeThreadCursor(cursor: ThreadCursor): string {
  return `${cursor.before.getTime()}_${cursor.beforeId}`;
}

function decodeThreadCursor(raw: string): ThreadCursor {
  const match = THREAD_CURSOR.exec(raw);
  if (!match)
    throw new AppError("invalid cursor", 400, "errors.threadCursorInvalid");
  return { before: new Date(Number(match[1])), beforeId: match[2] as string };
}

// The public id as the path spells it, or null for a segment no app's id can be: ids are base64url
// (`app_…`), so a percent-encoded or otherwise foreign segment names no app and is never decoded.
function publicIdOf(segment: string): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(segment) ? segment : null;
}

async function lookUp(publicId: string | null) {
  return publicId === null ? null : await resolveClientApp(publicId);
}

// The SDK turn's preflight, answered on `onRequest` because the instance-wide CORS plugin answers
// every OPTIONS there, before routing, with the console's policy. Registered after the client channel
// gate, so with the channel off the preflight is the gate's 404 like the route itself.
export async function sdkPreflight({
  request,
  server,
}: {
  request: Request;
  server: { requestIP?: unknown } | null;
}): Promise<Response | undefined> {
  if (request.method !== "OPTIONS") return;
  const match = SDK_TURN_PATH.exec(new URL(request.url).pathname);
  if (!match) return;
  try {
    chargeSdkLookup(clientKey(request, server));
  } catch (e) {
    if (!(e instanceof SdkRateLimitError)) throw e;
    return new Response(null, {
      status: 429,
      headers: { "retry-after": String(e.retryAfterS) },
    });
  }
  const origin = request.headers.get("origin");
  const publicId = publicIdOf(match[1] as string);
  const app = await lookUp(publicId);
  if (publicId !== null) rememberOrigins(publicId, app);
  if (!originAllowed(app, origin)) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin as string),
  });
}

// The headers the instance-wide CORS plugin writes on every response, the console's policy. An SDK
// turn's answer carries none of them, only the app's.
const INSTANCE_CORS_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
  "access-control-max-age",
  "vary",
];

// What `sdkCors` resolved for a request, so the handler reads the app once.
const resolvedFor = new WeakMap<Request, ResolvedClientApp | null>();

// The origins each existing app had at its last lookup, so a request refused by the address budget,
// which reads nothing, can still carry the app's CORS headers and reach its page readable (users
// behind one NAT share that budget). Only apps that exist are kept, so it holds one entry per app.
const ORIGINS_SEEN_TTL_MS = 5 * 60_000;
const originsSeen = new Map<string, { origins: string[]; at: number }>();

function rememberOrigins(publicId: string, app: ResolvedClientApp | null) {
  if (app)
    originsSeen.set(publicId, { origins: app.allowedOrigins, at: Date.now() });
  else originsSeen.delete(publicId);
}

function originSeenAllowed(publicId: string, origin: string | null): boolean {
  const seen = originsSeen.get(publicId);
  return (
    origin !== null &&
    seen !== undefined &&
    Date.now() - seen.at < ORIGINS_SEEN_TTL_MS &&
    seen.origins.includes(origin)
  );
}

// The SDK turn's CORS headers, on `onRequest` and registered AFTER the instance-wide CORS plugin
// (src/app.ts), so it replaces what that plugin wrote and so every answer carries them: the body's
// validation refusal and the parse error come before the handler runs, and a page must be able to
// read those as well as a 401 (to renew its token) or a 429.
export async function sdkCors({
  request,
  set,
  server,
}: {
  request: Request;
  set: { headers: Record<string, string | number> };
  server: { requestIP?: unknown } | null;
}): Promise<void> {
  if (request.method === "OPTIONS") return;
  const match = SDK_TURN_PATH.exec(new URL(request.url).pathname);
  if (!match) return;
  for (const name of INSTANCE_CORS_HEADERS) delete set.headers[name];
  const publicId = publicIdOf(match[1] as string);
  const origin = request.headers.get("origin");
  try {
    chargeSdkLookup(clientKey(request, server));
  } catch (e) {
    if (e instanceof SdkRateLimitError) {
      set.headers["retry-after"] = String(e.retryAfterS);
      if (publicId !== null && originSeenAllowed(publicId, origin))
        Object.assign(set.headers, corsHeaders(origin as string));
    }
    throw e;
  }
  const app = await lookUp(publicId);
  if (publicId !== null) rememberOrigins(publicId, app);
  resolvedFor.set(request, app);
  if (originAllowed(app, origin))
    Object.assign(set.headers, corsHeaders(origin as string));
  // NOTE: a recording is refused by its declared length here, before the body parser reads the
  // multipart into memory; one sent with no length is bounded again once read.
  if (
    match[2] === "transcribe" &&
    Number(request.headers.get("content-length")) >
      SDK_AUDIO_MAX_BYTES + MULTIPART_OVERHEAD
  )
    throw new AppError("audio too large", 413, "errors.audioTooLarge");
}

// The widget's script (src/sdk/agent.ts), bundled once per process on first request. Built at run
// time rather than by `bun run build`, which bundles only the console: the deploy runs the TypeScript
// sources, so the entry is there.
let widgetBundle: Promise<string> | null = null;
function widgetScript(): Promise<string> {
  widgetBundle ??= (async () => {
    const out = await Bun.build({
      entrypoints: [
        fileURLToPath(new URL("../../sdk/agent.ts", import.meta.url)),
      ],
      target: "browser",
      format: "iife",
      minify: true,
    });
    const file = out.outputs[0];
    if (!out.success || !file) throw new Error("the widget did not bundle");
    return await file.text();
  })().catch((e) => {
    widgetBundle = null;
    throw e;
  });
  return widgetBundle;
}

// What the turn and the transcription both ask before anything else: the page's origin, the token,
// and the user's and the app's request budget (an anonymous visitor's by the app's own setting).
async function admit(
  appId: string,
  request: Request,
  set: { headers: Record<string, string | number> },
) {
  const origin = request.headers.get("origin");
  // The app `sdkCors` resolved, and whose CORS headers it wrote on this response.
  const app = resolvedFor.has(request)
    ? (resolvedFor.get(request) ?? null)
    : await resolveClientApp(appId);
  if (origin !== null && !originAllowed(app, origin))
    throw new ForbiddenError(
      "origin not allowed",
      "errors.clientAppOriginRefused",
    );
  const { anonymous, ...user } = await verifyClientAppToken(
    app,
    request.headers.get("authorization"),
  );
  const resolved = app as ResolvedClientApp;
  try {
    chargeSdkRequest(
      resolved.id,
      user.id,
      Date.now(),
      anonymous
        ? {
            ...config.clientChannel.sdk,
            userPerMin: resolved.anonMessagesPerMin,
          }
        : config.clientChannel.sdk,
    );
  } catch (e) {
    if (e instanceof SdkRateLimitError)
      set.headers["retry-after"] = String(e.retryAfterS);
    throw e;
  }
  return { resolved, user, anonymous };
}

const appParam = t.Object({
  app: t.String({
    maxLength: 64,
    description: "The application's public id (`app_…`), the JWT's `aud`.",
  }),
});

export const sdkController = new Elysia({
  prefix: "/v1/sdk",
  tags: ["Client channel"],
})
  .get(
    "/agent.js",
    async () =>
      new Response(await widgetScript(), {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=300",
          // NOTE: loaded by other origins' pages; helmet's default is same-origin.
          "cross-origin-resource-policy": "cross-origin",
        },
      }),
    { detail: { hide: true } },
  )
  .post(
    "/:app/turn",
    async ({ params, body, request, server, set }) => {
      const { resolved, user } = await admit(params.app, request, set);
      await assertAppSpendCeiling(resolved);
      // NOTE: as on the proxy route, a turn has no overall deadline, so Bun's idle timeout would
      // cut a long one; each model call and tool bounds itself.
      server?.timeout(request, 0);
      const turn = {
        ctx: appCtx(resolved),
        agentId: resolved.agentId,
        threadId: body.threadId,
        user,
        message: body.message,
        voice: body.voice,
        answers: body.answers as Record<string, ClientToolAnswer> | undefined,
        context: body.context,
        clientTools: body.clientTools as ClientToolSpec[],
      };
      if (!request.headers.get("accept")?.includes("text/event-stream"))
        return await runClientTurn(turn);
      return await streamClientTurn(
        (onEvent) => runClientTurn({ ...turn, onEvent }),
        { acceptLanguage: request.headers.get("accept-language") },
      );
    },
    {
      detail: {
        ...doc(
          "Run client channel turn from the browser",
          "The client channel's turn as an embedding application's page calls it, authenticated by `Authorization: Bearer <JWT>` that the application's server signs with the app's key (HS256, `kid` naming the key, `aud` the app's public id, `sub` the user, `exp` at most one hour ahead; optional `name`, `email` and `scope`). Callable only from the app's allowed origins. The body and the answer are those of the proxy route, without `user`: the token names the user. Requests are limited per user and per app.",
        ),
        hide: !config.clientChannel.enabled,
      },
      response: errors(400, 401, 403, 404, 409, 422, 429, 500, 502),
      params: appParam,
      body: t.Object({
        threadId: t.Optional(t.String()),
        ...clientTurnFields,
        voice: t.Optional(
          t.Boolean({
            description:
              "The message is the transcription of a voice message, shown with its mark when the conversation is reopened.",
          }),
        ),
      }),
    },
  )
  .get(
    "/:app/threads",
    async ({ params, query, request, set }) => {
      const cursor =
        query.cursor === undefined
          ? undefined
          : decodeThreadCursor(query.cursor);
      const { resolved, user } = await admit(params.app, request, set);
      const page = await listClientThreads({
        ctx: appCtx(resolved),
        agentId: resolved.agentId,
        user,
        base: basePrisma,
        limit: THREADS_PAGE,
        cursor,
      });
      return {
        threads: page.threads.map((thread) => ({
          threadId: thread.threadId,
          title: thread.title,
          lastTurnAt: thread.lastTurnAt.toISOString(),
        })),
        nextCursor: page.next ? encodeThreadCursor(page.next) : null,
      };
    },
    {
      detail: {
        ...doc(
          "List the user's client channel conversations",
          "The widget's list of earlier conversations: the token's user's own threads with the app's agent, in the token's scope, newest first, 20 per page (pass `nextCursor` back as `cursor` for the next). Each is named by the user's first message, cut short (`title`, null for a thread that has none), with its last activity. Exactly the threads a turn lets this user resume, so no other user's, scope's or agent's thread is listed. Authenticated and limited as the turn is, and counts against the same request budget.",
        ),
        hide: !config.clientChannel.enabled,
      },
      response: {
        200: t.Object({
          threads: t.Array(
            t.Object({
              threadId: t.String(),
              title: t.Nullable(t.String()),
              lastTurnAt: t.String({ format: "date-time" }),
            }),
          ),
          nextCursor: t.Nullable(t.String()),
        }),
        ...errors(400, 401, 403, 404, 422, 429),
      },
      params: appParam,
      query: t.Object({
        cursor: t.Optional(
          t.String({
            maxLength: 128,
            description: "`nextCursor` from the previous page.",
          }),
        ),
      }),
    },
  )
  .get(
    "/:app/threads/:threadId/messages",
    async ({ params, query, request, set }) => {
      const before =
        query.before === undefined ? undefined : parseDbId(query.before);
      if (before === null)
        throw new AppError("invalid cursor", 400, "errors.threadCursorInvalid");
      const { resolved, user } = await admit(params.app, request, set);
      const page = await readClientTranscript({
        ctx: appCtx(resolved),
        agentId: resolved.agentId,
        user,
        base: basePrisma,
        threadId: params.threadId,
        limit: TRANSCRIPT_PAGE,
        before,
      });
      return {
        recorded: page.recorded,
        messages: page.messages.map((m) => ({
          role: m.role,
          text: m.text,
          ...(m.voice ? { voice: true } : {}),
          at: m.createdAt.toISOString(),
        })),
        before: page.next === null ? null : String(page.next),
      };
    },
    {
      detail: {
        ...doc(
          "Read a client channel conversation",
          "What the token's user was shown on one of their threads, to reopen it: their messages as sent and the replies as delivered (after the guardrails), in order, the newest 50 (pass `before` back for the 50 before them). `recorded` is false for a thread from before transcripts were kept, whose earlier messages are not available. A thread the user could not resume (another user's, scope's or agent's) is not found. Authenticated and limited as the turn is.",
        ),
        hide: !config.clientChannel.enabled,
      },
      response: {
        200: t.Object({
          recorded: t.Boolean(),
          messages: t.Array(
            t.Object({
              role: t.Union([t.Literal("user"), t.Literal("agent")]),
              text: t.String(),
              voice: t.Optional(t.Boolean()),
              at: t.String({ format: "date-time" }),
            }),
          ),
          before: t.Nullable(t.String()),
        }),
        ...errors(400, 401, 403, 404, 422, 429),
      },
      params: t.Object({
        ...appParam.properties,
        threadId: t.String({
          maxLength: 128,
          description: "The thread's id.",
        }),
      }),
      query: t.Object({
        before: t.Optional(
          t.String({
            maxLength: 32,
            description: "`before` from the previous page.",
          }),
        ),
      }),
    },
  )
  .post(
    "/:app/transcribe",
    async ({ params, body, request, server, set }) => {
      // A recording refused for its size or type is refused before it is charged, as a body the
      // schema refuses is.
      const { bytes, mimeType } = await normalizeAudioUpload(
        body.audio,
        SDK_AUDIO_MAX_BYTES,
      );
      const { resolved, anonymous } = await admit(params.app, request, set);
      // NOTE: Bun's idle timeout would cut a provider call before its own deadline, which bounds it.
      server?.timeout(request, 0);
      return {
        text: await transcribeClientAudio({
          ctx: appCtx(resolved),
          agentId: resolved.agentId,
          audio: bytes,
          mimeType,
          anonymous,
          // NOTE: the app's ceiling is asked where the channel's is, once the agent's speech-to-text
          // is known to run.
          beforeCall: () => assertAppSpendCeiling(resolved),
        }),
      };
    },
    {
      detail: {
        ...doc(
          "Transcribe a voice message from the browser",
          "The widget's microphone: a recording from the app's page, sent as multipart `audio`, transcribed with the speech-to-text the app's agent has configured. Answers the text, which the page then sends as the turn's message; an empty text means nothing was heard. Authenticated, limited and refused at the spend ceilings as the turn is, and counts against the same request budget. A recording over 4 MiB is refused with 413; an agent with speech-to-text off or without a usable credential with 400 (`errors.sttNotConfigured`, `errors.sttCredentialMissing`).",
        ),
        hide: !config.clientChannel.enabled,
      },
      response: {
        200: t.Object({ text: t.String() }),
        ...errors(400, 401, 403, 404, 413, 415, 422, 429, 502),
      },
      params: appParam,
      body: t.Object({
        audio: t.File({
          description:
            "The recording (`audio/webm`, `audio/ogg`, `audio/mp4`…), at most 4 MiB.",
        }),
      }),
    },
  )
  .post(
    "/:app/session",
    async ({ params, body, request, server, set }) => {
      const origin = request.headers.get("origin");
      const app = resolvedFor.has(request)
        ? (resolvedFor.get(request) ?? null)
        : await resolveClientApp(params.app);
      // NOTE: unlike the turn, no Origin is no pass here: nothing but the origin vouches for this call.
      if (!app || !originAllowed(app, origin))
        throw new ForbiddenError(
          "origin not allowed",
          "errors.clientAppOriginRefused",
        );
      if (!app.anonymousEnabled)
        throw new ForbiddenError(
          "anonymous sessions are off for this app",
          "errors.clientAppAnonymousDisabled",
        );
      const held =
        body.session === undefined
          ? null
          : readAnonSession(app.id, body.session);
      let session = body.session as string;
      let id = held;
      // NOTE: a page that only wants to resume (the panel showing an earlier conversation on open)
      // is told the session is gone instead of being handed, and charged for, a new one.
      if (id === null && body.renew)
        throw new AppError(
          "the anonymous session is not known",
          404,
          "errors.clientAppSessionUnknown",
        );
      if (id === null) {
        // Named by its field, so the page knows to show the challenge and ask again.
        const challengeFailed = () =>
          new AppError(
            "the human check did not pass",
            403,
            "errors.clientAppTurnstileFailed",
            undefined,
            "turnstile",
          );
        // NOTE: no token is refused BEFORE the charge: it calls nobody, and charging it would let a
        // page whose stored credential the instance no longer knows spend the allowance on the probe
        // and then be refused the solved retry.
        if (app.turnstileSecret !== null && body.turnstile === undefined)
          throw challengeFailed();
        const ip = clientKey(request, server);
        try {
          chargeAnonSession(app.id, ip, app.anonSessionsPerHour);
        } catch (e) {
          if (e instanceof SdkRateLimitError)
            set.headers["retry-after"] = String(e.retryAfterS);
          throw e;
        }
        // NOTE: after the charge, so a page that keeps failing the challenge also spends its hourly
        // allowance, and Cloudflare is not called past it.
        if (
          app.turnstileSecret !== null &&
          body.turnstile !== undefined &&
          !(await verifyTurnstile(app.turnstileSecret, body.turnstile, ip))
        )
          throw challengeFailed();
        ({ id, session } = mintAnonSession(app.id));
      }
      return { session, token: await mintAnonToken(app, id) };
    },
    {
      detail: {
        ...doc(
          "Open an anonymous client channel session",
          "For an app that allows anonymous visitors, called by its page when no user is signed in. Answers a session credential, which the page keeps, and a token for the turn that lives ten minutes. Sent back with `session`, it answers a new token for the same session, so the same browser resumes its conversation; an unrecognized credential gets a new session, or a 404 with `renew`, which asks only to resume. Callable only from the app's allowed origins. New sessions are limited per address per hour by the app's setting. When the app turns on its Turnstile challenge, a new session also needs `turnstile`, the token the page's challenge answered; renewing a session does not.",
        ),
        hide: !config.clientChannel.enabled,
      },
      response: {
        200: t.Object({ session: t.String(), token: t.String() }),
        ...errors(400, 403, 404, 422, 429),
      },
      params: appParam,
      body: t.Object({
        session: t.Optional(
          t.String({
            maxLength: 200,
            description: "The credential an earlier call answered.",
          }),
        ),
        renew: t.Optional(
          t.Boolean({
            description:
              "Only resume the session `session` names: an unrecognized or missing one is refused with 404 instead of opening a new one.",
          }),
        ),
        turnstile: t.Optional(
          t.String({
            maxLength: 2048,
            description:
              "The Cloudflare Turnstile token, required for a new session when the app's challenge is on.",
          }),
        ),
      }),
    },
  )
  .post(
    "/:app/session/claim",
    async ({ params, body, request, set }) => {
      const origin = request.headers.get("origin");
      const app = resolvedFor.has(request)
        ? (resolvedFor.get(request) ?? null)
        : await resolveClientApp(params.app);
      if (origin !== null && !originAllowed(app, origin))
        throw new ForbiddenError(
          "origin not allowed",
          "errors.clientAppOriginRefused",
        );
      const { anonymous, ...user } = await verifyClientAppToken(
        app,
        request.headers.get("authorization"),
      );
      // NOTE: the session goes to a signed-in user, which an anonymous token is not.
      if (anonymous) throw invalidToken();
      const resolved = app as ResolvedClientApp;
      try {
        chargeSdkRequest(resolved.id, user.id);
      } catch (e) {
        if (e instanceof SdkRateLimitError)
          set.headers["retry-after"] = String(e.retryAfterS);
        throw e;
      }
      const sessionId = readAnonSession(resolved.id, body.session);
      if (sessionId === null) return { threadIds: [] };
      return {
        threadIds: await handOverAnonymousThreads({
          ctx: appCtx(resolved),
          agentId: resolved.agentId,
          from: anonUserId(resolved.id, sessionId),
          to: user,
          base: basePrisma,
          checkpointer: await getCheckpointer(),
        }),
      };
    },
    {
      detail: {
        ...doc(
          "Hand an anonymous session over to the signed-in user",
          "Called once by the page when a visitor who talked anonymously signs in, with the app's JWT for the signed-in user and the anonymous session's credential. The session's conversations with the app's agent become that user's, in the token's `scope`; one a turn holds now, or suspended on calls the browser will not answer, stays behind. Answers the threads handed over, newest first. An unrecognized credential, or one already handed over, hands over nothing.",
        ),
        hide: !config.clientChannel.enabled,
      },
      response: {
        200: t.Object({ threadIds: t.Array(t.String()) }),
        ...errors(400, 401, 403, 404, 422, 429),
      },
      params: appParam,
      body: t.Object({
        session: t.String({
          maxLength: 200,
          description: "The anonymous session's credential.",
        }),
      }),
    },
  );
