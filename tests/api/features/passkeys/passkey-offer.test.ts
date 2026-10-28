// The passkey offer after a password sign-in, and the recent sign-in window that lets registering skip
// the password: through the real routes against real rows, with the app clock moved.

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Elysia } from "elysia";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { dbProbeFailed } from "@/tests/db-gate";
import { fakeAuthenticator } from "@/tests/utils/fake-authenticator";

const nativeGlobals = globalThis as unknown as {
  BunRequest: typeof Request;
  BunResponse: typeof Response;
};
const happyResponse = globalThis.Response;

const suUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let appDb: PrismaClient | undefined;
if (suUrl && appUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    appDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await appDb.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;

const originalPrisma = (await import("@/api/lib/prisma")).default;
mock.module("@/api/lib/prisma", () => ({ default: appDb }));
afterAll(() => {
  mock.module("@/api/lib/prisma", () => ({ default: originalPrisma }));
});

const api = (await import("@/api")).default;
const { hashPassword } = await import("@/api/features/auth/auth.service");
const { authPlugin } = await import("@/api/lib/auth");
type SignInMethod = import("@/api/lib/auth").SignInMethod;
const { refusalBody } = await import("@/api/lib/refusal");
const { PASSKEY_OFFER } = await import("@/api/features/passkeys/offer");

// The api with the app's answer to an AppError and without its limiters, whose credential budget is
// shared by every request this process makes (see passkeys.test.ts).
const harness = new Elysia()
  .onError(({ error, request }) => {
    if (!(error instanceof AppError)) return;
    return Response.json(
      refusalBody(error, request.headers.get("accept-language")),
      { status: error.statusCode },
    );
  })
  .group("/api", (app) => app.use(api));

const COOKIE = "fazerai_auth_token";
const PASSWORD = "old-password-123";
const tag = `pko-${process.pid}`;

const relyingParty = () => {
  const url = new URL(config.publicUrl);
  return { rpId: url.hostname, origin: url.origin };
};
const authenticator = () => fakeAuthenticator(relyingParty());
type Authenticator = Awaited<ReturnType<typeof authenticator>>;

type Reply = {
  status: number;
  session: string | null;
  json: Record<string, unknown>;
};

async function call(
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Reply> {
  const res = await harness.handle(
    new nativeGlobals.BunRequest(`http://localhost/api${path}`, {
      method,
      headers: {
        "accept-language": "en",
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  const session =
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${COOKIE}=`) && !c.startsWith(`${COOKIE}=;`))
      ?.split(";")[0] ?? null;
  return {
    status: res.status,
    session,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

type RegistrationOptions = {
  challengeId: string;
  options: {
    challenge: string;
    user?: { id: string };
    authenticatorSelection?: { userVerification?: string };
  };
};

async function passwordLogin(email: string) {
  const r = await call(null, "POST", "/auth/login", {
    email,
    password: PASSWORD,
  });
  expect(r.status).toBe(200);
  return r.session as string;
}

async function registerWith(
  session: string,
  key: Authenticator,
  body: Record<string, unknown> = {},
  presence: { userPresent?: boolean; userVerified?: boolean } = {},
) {
  const o = await call(
    session,
    "POST",
    "/auth/passkeys/register/options",
    body,
  );
  if (o.status !== 200) return o;
  const { challengeId, options } = o.json as unknown as RegistrationOptions;
  return call(session, "POST", "/auth/passkeys/register", {
    challengeId,
    response: await key.register(options.challenge, options.user?.id, presence),
  });
}

async function offerAnswer(session: string) {
  const r = await call(session, "GET", "/auth/passkeys/offer");
  expect(r.status).toBe(200);
  return r.json as { offer: boolean; expiresAt: string | null };
}

const offered = async (session: string) => (await offerAnswer(session)).offer;

let tenantId = 0n;
let seq = 0;
const created: bigint[] = [];

// A session as the Google route issues it, without a Google token to verify: the method is what the
// window reads.
const minter = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie, body }) => {
    const b = body as {
      id: string;
      email: string;
      hash: string | null;
      method: SignInMethod;
    };
    return setAuthCookie(
      {
        id: BigInt(b.id),
        email: b.email,
        name: null,
        googleId: null,
        role: "AGENT",
        tenantId,
      },
      b.hash,
      { method: b.method },
    );
  });

async function sessionVia(
  user: { id: bigint; email: string; passwordHash: string | null },
  method: SignInMethod,
) {
  const res = await minter.handle(
    new nativeGlobals.BunRequest("http://localhost/mint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: user.id.toString(),
        email: user.email,
        hash: user.passwordHash,
        method,
      }),
    }),
  );
  return `${COOKIE}=${await res.text()}`;
}

// The app clock is moved from here, but a passkey sign-in records its challenge against the DATABASE
// clock, so T0 is the real now, rounded to the second, rather than a fixed date past every expiry.
const T0 = new Date(Math.floor(Date.now() / 1000) * 1000);
const later = (ms: number) => new Date(T0.getTime() + ms);

const flagBefore = config.passkeysEnabled;

describe.skipIf(!dbUp)("passkey offer after a password sign-in", () => {
  let ana: { id: bigint; email: string; passwordHash: string | null };

  beforeAll(async () => {
    (globalThis as { Response: typeof Response }).Response =
      nativeGlobals.BunResponse;
    (config as { passkeysEnabled: boolean }).passkeysEnabled = true;
    tenantId = (
      await suDb.tenant.create({
        data: { name: "Passkey offer", slug: tag },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    setSystemTime();
    (globalThis as { Response: typeof Response }).Response = happyResponse;
    (config as { passkeysEnabled: boolean }).passkeysEnabled = flagBefore;
    if (created.length > 0) {
      await suDb.user.deleteMany({ where: { id: { in: created } } });
    }
    if (tenantId) await suDb.tenant.delete({ where: { id: tenantId } });
  });

  const fresh = async () => {
    setSystemTime(T0);
    seq += 1;
    ana = await suDb.user.create({
      data: {
        email: `${tag}-ana-${seq}@x.test`,
        passwordHash: await hashPassword(PASSWORD),
      },
    });
    created.push(ana.id);
    await suDb.tenantUser.create({
      data: { tenantId, userId: ana.id, role: "AGENT" },
    });
  };

  afterEach(() => {
    setSystemTime();
  });

  test("right after a password sign-in, registering skips the password, and only inside the window", async () => {
    await fresh();
    const session = await passwordLogin(ana.email);
    expect((await registerWith(session, await authenticator())).status).toBe(
      200,
    );

    setSystemTime(later(PASSKEY_OFFER.freshSignInMs + 15_000));
    const stale = await call(
      session,
      "POST",
      "/auth/passkeys/register/options",
      {},
    );
    expect(stale.status).toBe(400);
    expect((await call(session, "GET", "/auth/me")).json.user).not.toBeNull();
    const withPassword = await call(
      session,
      "POST",
      "/auth/passkeys/register/options",
      { password: PASSWORD },
    );
    expect(withPassword.status).toBe(200);
  });

  test("a password change does not open the recent sign-in window", async () => {
    await fresh();
    const stale = await sessionVia(ana, "password");
    setSystemTime(later(PASSKEY_OFFER.freshSignInMs * 2));
    const changed = await call(stale, "PATCH", "/auth/password", {
      currentPassword: PASSWORD,
      newPassword: "new-password-456",
    });
    expect(changed.status).toBe(200);
    const reissued = changed.session as string;
    expect(reissued).toBeTruthy();
    expect(
      (await call(reissued, "POST", "/auth/passkeys/register/options", {}))
        .status,
    ).toBe(400);
  });

  test("a session a passkey opened does not skip the password", async () => {
    await fresh();
    const key = await authenticator();
    const first = await passwordLogin(ana.email);
    expect((await registerWith(first, key)).status).toBe(200);

    const o = await call(null, "POST", "/auth/passkeys/login/options");
    const { challengeId, options } = o.json as unknown as RegistrationOptions;
    const login = await call(null, "POST", "/auth/passkeys/login", {
      challengeId,
      response: await key.login(options.challenge),
    });
    expect(login.status).toBe(200);
    const r = await call(
      login.session,
      "POST",
      "/auth/passkeys/register/options",
      {},
    );
    expect(r.status).toBe(400);
  });

  test("a wrong password inside the window is still a wrong password", async () => {
    await fresh();
    const session = await passwordLogin(ana.email);
    const r = await call(session, "POST", "/auth/passkeys/register/options", {
      password: "not-the-password",
    });
    expect(r.status).toBe(400);
  });

  test("the offer is made after a password sign-in with no passkey, and not after a passkey sign-in", async () => {
    await fresh();
    const session = await passwordLogin(ana.email);
    expect(await offered(session)).toBe(true);

    const key = await authenticator();
    expect((await registerWith(session, key)).status).toBe(200);
    expect(await offered(session)).toBe(false);

    const lo = await call(null, "POST", "/auth/passkeys/login/options");
    const { challengeId, options } = lo.json as unknown as RegistrationOptions;
    const viaPasskey = await call(null, "POST", "/auth/passkeys/login", {
      challengeId,
      response: await key.login(options.challenge),
    });
    expect(viaPasskey.status).toBe(200);
    // NOTE: with the passkey gone, only the sign-in method is left to refuse.
    await suDb.passkey.deleteMany({ where: { userId: ana.id } });
    expect(await offered(viaPasskey.session as string)).toBe(false);
  });

  test("a fresh Google sign-in skips the password but is not offered a passkey", async () => {
    await fresh();
    const viaGoogle = await sessionVia(ana, "google");
    expect(await offered(viaGoogle)).toBe(false);
    expect((await registerWith(viaGoogle, await authenticator())).status).toBe(
      200,
    );
  });

  test("the offer is only made inside the window after the sign-in, and says when it closes", async () => {
    await fresh();
    const session = await passwordLogin(ana.email);
    expect((await offerAnswer(session)).expiresAt).toBe(
      later(PASSKEY_OFFER.freshSignInMs).toISOString(),
    );
    setSystemTime(later(PASSKEY_OFFER.freshSignInMs + 1));
    expect(await offered(session)).toBe(false);
  });

  test("'not now' is recorded on the account: hidden for the cooldown, then back, and gone after the last allowed dismissal", async () => {
    await fresh();
    const session = await passwordLogin(ana.email);
    expect(
      (await call(session, "POST", "/auth/passkeys/offer/dismiss")).status,
    ).toBe(200);
    // NOTE: a retry after a lost response, or a second tab, inside the cooldown does not spend
    // another of the allowed refusals.
    setSystemTime(later(60_000));
    expect(
      (await call(session, "POST", "/auth/passkeys/offer/dismiss")).status,
    ).toBe(200);
    setSystemTime(T0);
    const row = await suDb.user.findUniqueOrThrow({ where: { id: ana.id } });
    expect(row.passkeyPromptDismissCount).toBe(1);
    expect(row.passkeyPromptDismissedAt?.getTime()).toBe(T0.getTime());

    // NOTE: a new browser is a new session; the refusal still holds.
    setSystemTime(later(PASSKEY_OFFER.cooldownMs - 60_000));
    expect(await offered(await passwordLogin(ana.email))).toBe(false);

    setSystemTime(later(PASSKEY_OFFER.cooldownMs + 1));
    expect(await offered(await passwordLogin(ana.email))).toBe(true);

    await suDb.user.update({
      where: { id: ana.id },
      data: {
        passkeyPromptDismissCount: PASSKEY_OFFER.maxDismissals,
        passkeyPromptDismissedAt: new Date(0),
      },
    });
    expect(await offered(await passwordLogin(ana.email))).toBe(false);
  });

  test("dismissing needs a session", async () => {
    expect(
      (await call(null, "POST", "/auth/passkeys/offer/dismiss")).status,
    ).toBe(401);
    expect((await call(null, "GET", "/auth/passkeys/offer")).status).toBe(401);
  });

  test("a conditional registration accepts no presence or verification; an ordinary one still requires both", async () => {
    await fresh();
    const session = await passwordLogin(ana.email);
    const silent = { userPresent: false, userVerified: false };

    const ordinary = await registerWith(
      session,
      await authenticator(),
      {},
      silent,
    );
    expect(ordinary.status).toBe(400);

    const o = await call(session, "POST", "/auth/passkeys/register/options", {
      conditional: true,
    });
    expect(o.status).toBe(200);
    expect(
      (o.json as unknown as RegistrationOptions).options.authenticatorSelection
        ?.userVerification,
    ).toBe("preferred");
    const conditional = await registerWith(
      session,
      await authenticator(),
      { conditional: true },
      silent,
    );
    expect(conditional.status).toBe(200);
    expect(await suDb.passkey.count({ where: { userId: ana.id } })).toBe(1);
  });
});
