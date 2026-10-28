// Passkeys end to end: registration, sign-in, management and the switch, through the real routes
// against real rows, with a software authenticator driving the real WebAuthn library.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Elysia } from "elysia";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { dbProbeFailed } from "@/tests/db-gate";
import { fakeAuthenticator } from "@/tests/utils/fake-authenticator";
import { waitUntilBlocked } from "@/tests/utils/pg-waits";
import { until } from "@/tests/utils/poll";

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

// The app's own client against the test database. Restored as a fresh literal, the way
// biome-plugins/no-module-mock-live-namespace.grit requires.
const originalPrisma = (await import("@/api/lib/prisma")).default;
mock.module("@/api/lib/prisma", () => ({ default: appDb }));
afterAll(() => {
  mock.module("@/api/lib/prisma", () => ({ default: originalPrisma }));
});

const api = (await import("@/api")).default;
const server = (await import("@/app")).default;
const { hashPassword } = await import("@/api/features/auth/auth.service");
const { authPlugin } = await import("@/api/lib/auth");
const { refusalBody } = await import("@/api/lib/refusal");
const { isCredentialRequest } = await import("@/api/middlewares/rateLimit");
const service = await import("@/api/features/passkeys/passkeys.service");
const keys = await import("@/modules/api-keys/service");

// The api under /api with the app's answer to an AppError, and without the app's limiters: the
// credential budget is shared by every request this process makes, and these tests sign in far more
// often than it allows. The limiter's own coverage of these routes is asserted separately below.
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
const tag = `pk-${process.pid}`;

const relyingParty = () => {
  const url = new URL(config.publicUrl);
  return { rpId: url.hostname, origin: url.origin };
};
const authenticator = (
  opts: { fixedCounter?: boolean; credentialIdBytes?: number } = {},
) => fakeAuthenticator({ ...relyingParty(), ...opts });
type Authenticator = Awaited<ReturnType<typeof authenticator>>;

type Reply = {
  status: number;
  session: string | null;
  json: Record<string, unknown>;
};

async function send(
  target: { handle: (r: Request) => Promise<Response> },
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<Reply> {
  const res = await target.handle(
    new nativeGlobals.BunRequest(`http://localhost/api${path}`, {
      method,
      headers: {
        "accept-language": "en",
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extra,
      },
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );
  const text = await res.text();
  const session =
    res.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${COOKIE}=`) && !c.startsWith(`${COOKIE}=;`))
      ?.split(";")[0] ?? null;
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { text };
  }
  return { status: res.status, session, json };
}

const call = (
  cookie: string | null,
  method: string,
  path: string,
  body?: unknown,
) => send(harness, cookie, method, path, body);

type Options = {
  challengeId: string;
  options: {
    challenge: string;
    rp?: { id: string };
    rpId?: string;
    user?: { id: string };
    excludeCredentials?: { id: string }[];
    allowCredentials?: unknown[];
    userVerification?: string;
    authenticatorSelection?: {
      residentKey?: string;
      userVerification?: string;
    };
  };
};

type Person = {
  id: bigint;
  email: string;
  passwordHash: string | null;
  cookie: string;
};

let tenantId = 0n;
let seq = 0;
const created: bigint[] = [];

const minter = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie, body }) => {
    const b = body as { id: string; email: string; hash: string | null };
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
    );
  });

// A session as a login issues it, carrying no sign-in method.
async function sessionFor(user: {
  id: bigint;
  email: string;
  passwordHash: string | null;
}) {
  const res = await minter.handle(
    new nativeGlobals.BunRequest("http://localhost/mint", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: user.id.toString(),
        email: user.email,
        hash: user.passwordHash,
      }),
    }),
  );
  return `${COOKIE}=${await res.text()}`;
}

async function createUser(
  name: string,
  { password = true, google = false } = {},
): Promise<Person> {
  seq += 1;
  const email = `${tag}-${name}-${seq}@x.test`;
  const user = await suDb.user.create({
    data: {
      email,
      passwordHash: password ? await hashPassword(PASSWORD) : null,
      googleId: google ? `google-${email}` : null,
    },
  });
  created.push(user.id);
  await suDb.tenantUser.create({
    data: { tenantId, userId: user.id, role: "AGENT" },
  });
  return { ...user, cookie: await sessionFor(user) };
}

async function register(
  who: { cookie: string },
  key: Authenticator,
  name?: string,
) {
  const o = await call(who.cookie, "POST", "/auth/passkeys/register/options", {
    password: PASSWORD,
  });
  expect(o.status).toBe(200);
  const { challengeId, options } = o.json as unknown as Options;
  return call(who.cookie, "POST", "/auth/passkeys/register", {
    challengeId,
    response: await key.register(options.challenge, options.user?.id),
    ...(name ? { name } : {}),
  });
}

async function loginOptions() {
  const o = await call(null, "POST", "/auth/passkeys/login/options");
  expect(o.status).toBe(200);
  return o.json as unknown as Options;
}

async function loginWith(key: Authenticator) {
  const { challengeId, options } = await loginOptions();
  return call(null, "POST", "/auth/passkeys/login", {
    challengeId,
    response: await key.login(options.challenge),
  });
}

async function me(session: string | null) {
  const r = await call(session, "GET", "/auth/me");
  return (r.json.user as { email: string } | null)?.email ?? null;
}

const hashOf = (challenge: string) =>
  new Bun.CryptoHasher("sha256").update(challenge).digest("hex");
const spentMarks = (challenge: string) =>
  suDb.webauthnConsumedChallenge.count({
    where: { challengeHash: hashOf(challenge) },
  });
const passkeysOf = (...users: { id: bigint }[]) =>
  suDb.passkey.count({ where: { userId: { in: users.map((u) => u.id) } } });

const setFlag = (on: boolean) => {
  (config as { passkeysEnabled: boolean }).passkeysEnabled = on;
};
const flagBefore = config.passkeysEnabled;

describe.skipIf(!dbUp)("passkeys", () => {
  let ana: Person;
  let bia: Person;

  beforeAll(async () => {
    (globalThis as { Response: typeof Response }).Response =
      nativeGlobals.BunResponse;
    setFlag(true);
    tenantId = (
      await suDb.tenant.create({
        data: { name: "Passkeys", slug: tag },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    (globalThis as { Response: typeof Response }).Response = happyResponse;
    setFlag(flagBefore);
    if (created.length > 0) {
      await suDb.apiKey.deleteMany({
        where: { createdByUserId: { in: created } },
      });
      await suDb.user.deleteMany({ where: { id: { in: created } } });
    }
    if (tenantId) await suDb.tenant.delete({ where: { id: tenantId } });
  });

  const fresh = async () => {
    ana = await createUser("ana");
    bia = await createUser("bia");
  };

  test("registers, lists and signs in, and the session it issues is valid", async () => {
    await fresh();
    const key = await authenticator();
    const r = await register(ana, key, "Laptop");
    expect(r.status).toBe(200);
    expect((r.json.passkey as { name: string }).name).toBe("Laptop");

    const list = await call(ana.cookie, "GET", "/auth/passkeys");
    expect((list.json.passkeys as { id: string }[]).map((p) => p.id)).toEqual([
      key.id,
    ]);

    const login = await loginWith(key);
    expect(login.status).toBe(200);
    expect((login.json.user as { email: string }).email).toBe(ana.email);
    expect(await me(login.session)).toBe(ana.email);

    const stored = await suDb.passkey.findUniqueOrThrow({
      where: { id: key.id },
    });
    expect(stored.counter).toBe(1n);
    expect(stored.lastUsedAt).not.toBeNull();
    await until("lastLoginAt after a passkey sign-in", async () => {
      const row = await suDb.user.findUniqueOrThrow({ where: { id: ana.id } });
      return row.lastLoginAt;
    });
  });

  test("the options carry the promised shape", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);
    const { rpId } = relyingParty();

    const reg = await call(
      ana.cookie,
      "POST",
      "/auth/passkeys/register/options",
      { password: PASSWORD },
    );
    const { options } = reg.json as unknown as Options;
    expect(options.rp?.id).toBe(rpId);
    expect(options.authenticatorSelection?.residentKey).toBe("required");
    expect(options.authenticatorSelection?.userVerification).toBe("required");
    expect(options.excludeCredentials?.map((c) => c.id)).toEqual([key.id]);

    const login = await loginOptions();
    expect(login.options.userVerification).toBe("required");
    expect(login.options.allowCredentials ?? []).toEqual([]);
    expect(login.options.rpId).toBe(rpId);
  });

  test("the user handle is random per account, not the account id, and stable across registrations", async () => {
    await fresh();
    const handleOf = async (who: { cookie: string }) => {
      const o = await call(
        who.cookie,
        "POST",
        "/auth/passkeys/register/options",
        { password: PASSWORD },
      );
      return (o.json as unknown as Options).options.user?.id as string;
    };
    const first = await handleOf(ana);
    expect(await handleOf(ana)).toBe(first);
    expect(await handleOf(bia)).not.toBe(first);
    expect(first).not.toBe(
      Buffer.from(ana.id.toString()).toString("base64url"),
    );
    expect(Buffer.from(first, "base64url").length).toBe(32);
  });

  test("a challenge is single use: the same response does not sign in twice", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);

    const { challengeId, options } = await loginOptions();
    const response = await key.login(options.challenge);
    const first = await call(null, "POST", "/auth/passkeys/login", {
      challengeId,
      response,
    });
    expect(first.status).toBe(200);
    const replay = await call(null, "POST", "/auth/passkeys/login", {
      challengeId,
      response,
    });
    expect(replay.status).toBe(400);
    expect(replay.session).toBeNull();
  });

  test("a rejected response spends the challenge too", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);

    const { challengeId, options } = await loginOptions();
    const wrongOrigin = await call(null, "POST", "/auth/passkeys/login", {
      challengeId,
      response: await key.login(options.challenge, {
        from: "https://elsewhere.example",
      }),
    });
    expect(wrongOrigin.status).toBe(401);
    const after = await call(null, "POST", "/auth/passkeys/login", {
      challengeId,
      response: await key.login(options.challenge),
    });
    expect(after.status).toBe(400);
  });

  test("an expired challenge is refused", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);

    const { challengeId, options } = await service.loginOptions({
      now: Date.now() - 6 * 60 * 1000,
    });
    const r = await call(null, "POST", "/auth/passkeys/login", {
      challengeId,
      response: await key.login(options.challenge),
    });
    expect(r.status).toBe(400);
    expect(r.session).toBeNull();
  });

  test("asking for sign-in options writes nothing", async () => {
    const a = await loginOptions();
    const b = await loginOptions();
    for (const o of [a, b]) {
      expect(await spentMarks(o.options.challenge)).toBe(0);
      expect(
        await suDb.webauthnChallenge.count({
          where: { challenge: o.options.challenge },
        }),
      ).toBe(0);
    }
  });

  test("two verifications of one challenge at once: only one signs in", async () => {
    await fresh();
    const key = await authenticator({ fixedCounter: true });
    expect((await register(ana, key)).status).toBe(200);

    const { challengeId, options } = await loginOptions();
    const response = await key.login(options.challenge);
    const results = await Promise.all(
      [0, 1].map(() =>
        call(null, "POST", "/auth/passkeys/login", { challengeId, response }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  test("a forged challenge, or a registration's, does not sign in", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);

    const { challengeId, options } = await loginOptions();
    const cut = challengeId.lastIndexOf(".") + 1;
    const signature = challengeId.slice(cut);
    const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
    const forged = await call(null, "POST", "/auth/passkeys/login", {
      challengeId: `${challengeId.slice(0, cut)}${flipped}`,
      response: await key.login(options.challenge),
    });
    expect(forged.status).toBe(400);
    expect(forged.session).toBeNull();

    const reg = await call(
      ana.cookie,
      "POST",
      "/auth/passkeys/register/options",
      { password: PASSWORD },
    );
    const registration = reg.json as unknown as Options;
    const crossed = await call(null, "POST", "/auth/passkeys/login", {
      challengeId: registration.challengeId,
      response: await key.login(registration.options.challenge),
    });
    expect(crossed.status).toBe(400);
    expect(crossed.session).toBeNull();
  });

  test("spent challenges are swept once they expire", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);

    const stale = `${tag}-spent-long-ago`;
    await suDb.webauthnConsumedChallenge.create({
      data: {
        challengeHash: stale,
        expiresAt: new Date(Date.now() - 60 * 1000),
      },
    });
    const { challengeId, options } = await loginOptions();
    const r = await call(null, "POST", "/auth/passkeys/login", {
      challengeId,
      response: await key.login(options.challenge),
    });
    expect(r.status).toBe(200);
    expect(
      await suDb.webauthnConsumedChallenge.count({
        where: { challengeHash: stale },
      }),
    ).toBe(0);
    const mark = await suDb.webauthnConsumedChallenge.findUniqueOrThrow({
      where: { challengeHash: hashOf(options.challenge) },
    });
    expect(mark.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("a challenge past expiry cannot be recorded, so a swept mark never reopens it", async () => {
    await fresh();
    const key = await authenticator({ fixedCounter: true });
    expect((await register(ana, key)).status).toBe(200);

    const past = Date.now() - 6 * 60 * 1000;
    const old = await service.loginOptions({ now: past });
    const response = (await key.login(
      old.options.challenge,
    )) as unknown as Parameters<typeof service.loginWithPasskey>[1];
    await expect(
      service.loginWithPasskey(old.challengeId, response, { now: past }),
    ).rejects.toMatchObject({ code: "challenge" });
    expect(await spentMarks(old.options.challenge)).toBe(0);
  });

  test("a replay that waited for a sweep to remove the mark is still refused", async () => {
    await fresh();
    const key = await authenticator({ fixedCounter: true });
    expect((await register(ana, key)).status).toBe(200);

    const { challengeId, options } = await service.loginOptions({
      now: Date.now() - (5 * 60 * 1000 - 2000),
    });
    const response = await key.login(options.challenge);
    const first = await call(null, "POST", "/auth/passkeys/login", {
      challengeId,
      response,
    });
    expect(first.status).toBe(200);
    const marker = await suDb.webauthnConsumedChallenge.findUniqueOrThrow({
      where: { challengeHash: hashOf(options.challenge) },
    });

    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sweeperPid = -1;
    const sweeper = suDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          DELETE FROM webauthn_consumed_challenges
          WHERE challenge_hash = ${marker.challengeHash}`;
        const [row] = await tx.$queryRaw<{ pid: number }[]>`
          SELECT pg_backend_pid() AS pid`;
        sweeperPid = row?.pid ?? -1;
        markHeld();
        await released;
      },
      { timeout: 20_000 },
    );
    await held;

    const replay = service
      .loginWithPasskey(
        challengeId,
        response as unknown as Parameters<typeof service.loginWithPasskey>[1],
      )
      .then(
        () => "signed in",
        (error: { code?: string }) => error.code ?? "threw",
      );
    expect(await waitUntilBlocked(suDb, sweeperPid, 1)).toBeGreaterThanOrEqual(
      0,
    );
    await until("the challenge past expiry by the database clock", async () => {
      const [row] = await suDb.$queryRaw<{ past: boolean }[]>`
        SELECT (clock_timestamp() AT TIME ZONE 'UTC') > ${marker.expiresAt} AS past`;
      return row?.past;
    });
    release();
    await sweeper;
    expect(await replay).toBe("challenge");
  });

  test("one account's registration challenge does not register for another", async () => {
    await fresh();
    const o = await call(
      ana.cookie,
      "POST",
      "/auth/passkeys/register/options",
      {
        password: PASSWORD,
      },
    );
    const { challengeId, options } = o.json as unknown as Options;
    const key = await authenticator();
    const r = await call(bia.cookie, "POST", "/auth/passkeys/register", {
      challengeId,
      response: await key.register(options.challenge, options.user?.id),
    });
    expect(r.status).toBe(400);
    expect(await passkeysOf(ana, bia)).toBe(0);
  });

  test("an expired registration challenge is refused, and nothing is stored", async () => {
    await fresh();
    const o = await call(
      ana.cookie,
      "POST",
      "/auth/passkeys/register/options",
      {
        password: PASSWORD,
      },
    );
    const { challengeId, options } = o.json as unknown as Options;
    // NOTE: past its expiry but not yet swept, which only happens on the next insert.
    await suDb.webauthnChallenge.updateMany({
      where: { userId: ana.id },
      data: { expiresAt: new Date(Date.now() - 60 * 1000) },
    });
    const key = await authenticator();
    const r = await call(ana.cookie, "POST", "/auth/passkeys/register", {
      challengeId,
      response: await key.register(options.challenge, options.user?.id),
    });
    expect(r.status).toBe(400);
    expect(await passkeysOf(ana)).toBe(0);
  });

  test("a sign-in challenge does not serve a registration", async () => {
    await fresh();
    const { challengeId, options } = await loginOptions();
    const key = await authenticator();
    const r = await call(ana.cookie, "POST", "/auth/passkeys/register", {
      challengeId,
      response: await key.register(options.challenge, "c29tZW9uZQ"),
    });
    expect(r.status).toBe(400);
    expect(await passkeysOf(ana)).toBe(0);
  });

  test("a refused registration answers 400, not 401: the session stays", async () => {
    await fresh();
    const o = await call(
      ana.cookie,
      "POST",
      "/auth/passkeys/register/options",
      {
        password: PASSWORD,
      },
    );
    const { challengeId, options } = o.json as unknown as Options;
    const key = await authenticator();
    const r = await call(ana.cookie, "POST", "/auth/passkeys/register", {
      challengeId,
      response: await key.register(options.challenge, options.user?.id, {
        from: "https://elsewhere.example",
      }),
    });
    expect(r.status).toBe(400);
    expect(await passkeysOf(ana)).toBe(0);
    expect(await me(ana.cookie)).toBe(ana.email);
  });

  test("an unknown passkey does not sign in", async () => {
    const r = await loginWith(await authenticator());
    expect(r.status).toBe(401);
    expect(r.session).toBeNull();
  });

  test("a sign-in with no userHandle, or another account's, is refused", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);

    const biaOptions = await call(
      bia.cookie,
      "POST",
      "/auth/passkeys/register/options",
      { password: PASSWORD },
    );
    const biaHandle = (biaOptions.json as unknown as Options).options.user?.id;
    expect(biaHandle).toBeTruthy();
    for (const userHandle of [null, biaHandle as string]) {
      const { challengeId, options } = await loginOptions();
      const r = await call(null, "POST", "/auth/passkeys/login", {
        challengeId,
        response: await key.login(options.challenge, { userHandle }),
      });
      expect(r.status).toBe(401);
      expect(r.session).toBeNull();
    }
  });

  test("a signature by another key is refused and leaves the counter alone", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);
    const intruder = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );

    const { challengeId, options } = await loginOptions();
    const r = await call(null, "POST", "/auth/passkeys/login", {
      challengeId,
      response: await key.login(options.challenge, {
        signWith: intruder.privateKey,
      }),
    });
    expect(r.status).toBe(401);
    const stored = await suDb.passkey.findUniqueOrThrow({
      where: { id: key.id },
    });
    expect(stored.counter).toBe(0n);
    expect(stored.lastUsedAt).toBeNull();
  });

  test("an assertion without user verification is refused", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);
    const { challengeId, options } = await loginOptions();
    const r = await call(null, "POST", "/auth/passkeys/login", {
      challengeId,
      response: await key.login(options.challenge, { userVerified: false }),
    });
    expect(r.status).toBe(401);
    expect(r.session).toBeNull();
  });

  test("a passkey with the longest credential id WebAuthn allows registers, signs in and is removed", async () => {
    await fresh();
    const key = await authenticator({ credentialIdBytes: 1023 });
    expect(key.id.length).toBe(1364);
    expect((await register(ana, key)).status).toBe(200);
    expect((await loginWith(key)).status).toBe(200);
    expect(
      (await call(ana.cookie, "DELETE", `/auth/passkeys/${key.id}`)).status,
    ).toBe(200);
  });

  test("an authenticator with no counter (always 0) signs in more than once", async () => {
    await fresh();
    const key = await authenticator({ fixedCounter: true });
    expect((await register(ana, key)).status).toBe(200);
    expect((await loginWith(key)).status).toBe(200);
    expect((await loginWith(key)).status).toBe(200);
  });

  // An open transaction writes `concurrent` and holds the row lock. The sign-in reads the committed 0,
  // verifies its own counter against it and blocks on its write until the commit; the write
  // conditioned on 0 then finds no row and the sign-in decides on what was stored meanwhile.
  async function loginRacing(concurrent: number, ownCounter: number) {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);
    const { challengeId, options } = await loginOptions();
    let response = await key.login(options.challenge);
    for (let n = 1; n < ownCounter; n++) {
      response = await key.login(options.challenge);
    }
    let login: Promise<Reply> | undefined;
    let holderPid = -1;
    await suDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE passkeys SET counter = ${concurrent} WHERE id = ${key.id}`;
        const [row] = await tx.$queryRaw<{ pid: number }[]>`
          SELECT pg_backend_pid() AS pid`;
        holderPid = row?.pid ?? -1;
        login = call(null, "POST", "/auth/passkeys/login", {
          challengeId,
          response,
        });
        expect(
          await waitUntilBlocked(suDb, holderPid, 1),
        ).toBeGreaterThanOrEqual(0);
      },
      { timeout: 20_000 },
    );
    const r = await (login as Promise<Reply>);
    const stored = await suDb.passkey.findUniqueOrThrow({
      where: { id: key.id },
    });
    return { r, counter: stored.counter };
  }

  test("a sign-in whose counter fell behind one written meanwhile is refused, and the counter does not move back", async () => {
    const { r, counter } = await loginRacing(5, 1);
    expect(r.status).toBe(401);
    expect(r.session).toBeNull();
    expect(r.json.error).toMatch(/could not be verified/);
    expect(counter).toBe(5n);
  });

  test("a sign-in still ahead of a counter written meanwhile retries and signs in", async () => {
    const { r, counter } = await loginRacing(2, 3);
    expect(r.status).toBe(200);
    expect(r.session).not.toBeNull();
    expect(counter).toBe(3n);
  });

  test("nobody lists, renames or removes another account's passkey", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key, "Ana's phone")).status).toBe(200);

    const list = await call(bia.cookie, "GET", "/auth/passkeys");
    expect(list.json.passkeys).toEqual([]);
    const rename = await call(bia.cookie, "PATCH", `/auth/passkeys/${key.id}`, {
      name: "mine now",
    });
    expect(rename.status).toBe(404);
    const remove = await call(bia.cookie, "DELETE", `/auth/passkeys/${key.id}`);
    expect(remove.status).toBe(404);
    const stored = await suDb.passkey.findUniqueOrThrow({
      where: { id: key.id },
    });
    expect(stored.name).toBe("Ana's phone");

    const own = await call(ana.cookie, "DELETE", `/auth/passkeys/${key.id}`);
    expect(own.status).toBe(200);
    expect(await passkeysOf(ana)).toBe(0);
    expect((await loginWith(key)).status).toBe(401);
  });

  test("a rename persists, and an empty name clears it", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);
    const renamed = await call(
      ana.cookie,
      "PATCH",
      `/auth/passkeys/${key.id}`,
      { name: "  Work laptop  " },
    );
    expect(renamed.status).toBe(200);
    expect(
      (await suDb.passkey.findUniqueOrThrow({ where: { id: key.id } })).name,
    ).toBe("Work laptop");
    await call(ana.cookie, "PATCH", `/auth/passkeys/${key.id}`, { name: "" });
    expect(
      (await suDb.passkey.findUniqueOrThrow({ where: { id: key.id } })).name,
    ).toBeNull();
  });

  test("managing passkeys needs a session", async () => {
    expect((await call(null, "GET", "/auth/passkeys")).status).toBe(401);
    expect(
      (await call(null, "POST", "/auth/passkeys/register/options", {})).status,
    ).toBe(401);
    expect((await call(null, "DELETE", "/auth/passkeys/x")).status).toBe(401);
    expect(
      (await call(null, "PATCH", "/auth/passkeys/x", { name: "y" })).status,
    ).toBe(401);
  });

  test("an API key is refused on every route a session uses, and plants nothing", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);
    const { token } = await keys.createApiKey(
      { tenantId, userId: ana.id, role: "TENANT_ADMIN" },
      { displayName: `${tag} key` },
      appDb,
    );
    const bearer = { authorization: `Bearer ${token}` };
    const calls: [string, string, unknown?][] = [
      ["GET", "/auth/passkeys"],
      ["POST", "/auth/passkeys/register/options", { password: PASSWORD }],
      [
        "POST",
        "/auth/passkeys/register",
        {
          challengeId: "x",
          response: {
            id: "a",
            rawId: "a",
            type: "public-key",
            response: {},
            clientExtensionResults: {},
          },
        },
      ],
      ["GET", "/auth/passkeys/offer"],
      ["POST", "/auth/passkeys/offer/dismiss"],
      ["PATCH", `/auth/passkeys/${key.id}`, { name: "by key" }],
      ["DELETE", `/auth/passkeys/${key.id}`],
    ];
    for (const [method, path, body] of calls) {
      const r = await send(server, null, method, path, body, bearer);
      expect({ path, status: r.status }).toEqual({ path, status: 403 });
    }
    const stored = await suDb.passkey.findUniqueOrThrow({
      where: { id: key.id },
    });
    expect(stored.name).toBeNull();
    expect(await passkeysOf(ana)).toBe(1);
    expect(
      await suDb.webauthnChallenge.count({ where: { userId: ana.id } }),
    ).toBe(0);
    const row = await suDb.user.findUniqueOrThrow({ where: { id: ana.id } });
    expect(row.passkeyPromptDismissCount).toBe(0);
  });

  test("an account with a password, or with Google sign-in on, can remove its only passkey", async () => {
    await fresh();
    const dora = await createUser("dora", { password: false, google: true });
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);
    expect(
      (await call(ana.cookie, "DELETE", `/auth/passkeys/${key.id}`)).status,
    ).toBe(200);
    // NOTE: written straight to the table: registering through the API takes a Google sign-in,
    // which a test cannot mint.
    await suDb.passkey.create({
      data: {
        id: `${tag}-dora-key`,
        userId: dora.id,
        publicKey: Buffer.from([1]),
        deviceType: "multiDevice",
        backedUp: true,
      },
    });
    const original = config.googleOAuthEnabled;
    config.googleOAuthEnabled = true;
    try {
      expect(
        (await call(dora.cookie, "DELETE", `/auth/passkeys/${tag}-dora-key`))
          .status,
      ).toBe(200);
    } finally {
      config.googleOAuthEnabled = original;
    }
  });

  test("the last passkey of an account with no other usable way in cannot be removed", async () => {
    const dora = await createUser("dora", { password: false, google: true });
    const ids = [`${tag}-dora-1`, `${tag}-dora-2`];
    for (const id of ids) {
      await suDb.passkey.create({
        data: {
          id,
          userId: dora.id,
          publicKey: Buffer.from([1]),
          deviceType: "multiDevice",
          backedUp: true,
        },
      });
    }
    const original = config.googleOAuthEnabled;
    config.googleOAuthEnabled = false;
    try {
      const results = await Promise.all(
        ids.map((id) => call(dora.cookie, "DELETE", `/auth/passkeys/${id}`)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await passkeysOf(dora)).toBe(1);
    } finally {
      config.googleOAuthEnabled = original;
    }
  });

  test("registering asks for the account's own credential, not just the session", async () => {
    await fresh();
    for (const body of [{}, { password: "not-the-password" }]) {
      const r = await call(
        ana.cookie,
        "POST",
        "/auth/passkeys/register/options",
        body,
      );
      expect(r.status).toBe(400);
    }
    expect(
      await suDb.webauthnChallenge.count({ where: { userId: ana.id } }),
    ).toBe(0);

    const dora = await createUser("dora", { password: false, google: true });
    const doraUser = {
      id: dora.id,
      email: dora.email,
      name: null,
      googleId: `google-${dora.email}`,
      role: "AGENT" as const,
      tenantId,
    };
    const asks = (
      proof: { password?: string; googleCredential?: string },
      sub: string,
    ) => service.proveAccountOwner(doraUser, proof, async () => ({ sub }));
    const original = config.googleOAuthEnabled;
    config.googleOAuthEnabled = true;
    try {
      expect(
        await asks({ googleCredential: "t" }, `google-${dora.email}`),
      ).toBe(true);
      expect(await asks({ googleCredential: "t" }, "google-someone-else")).toBe(
        false,
      );
      // NOTE: an account with no password cannot be proven by one.
      expect(await asks({ password: "" }, `google-${dora.email}`)).toBe(false);
    } finally {
      config.googleOAuthEnabled = original;
    }
  });

  test("a password change revokes a session the passkey opened, and the passkey still signs in", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);
    const login = await loginWith(key);
    expect(await me(login.session)).toBe(ana.email);

    const change = await call(ana.cookie, "PATCH", "/auth/password", {
      currentPassword: PASSWORD,
      newPassword: "new-password-456",
    });
    expect(change.status).toBe(200);
    expect(await me(login.session)).toBeNull();

    const again = await loginWith(key);
    expect(await me(again.session)).toBe(ana.email);
  });

  test("a logout ends a session the passkey opened", async () => {
    await fresh();
    const key = await authenticator();
    expect((await register(ana, key)).status).toBe(200);
    const login = await loginWith(key);
    expect(await me(login.session)).toBe(ana.email);
    const ended = await suDb.endedSession.count({ where: { userId: ana.id } });

    expect((await call(login.session, "POST", "/auth/logout")).status).toBe(
      200,
    );
    expect(await me(login.session)).toBeNull();
    expect(await suDb.endedSession.count({ where: { userId: ana.id } })).toBe(
      ended + 1,
    );
  });

  test("the sign-in and the registration that takes a password are on the credential budget, and the options are not", () => {
    const at = (method: string, path: string) =>
      isCredentialRequest(
        new nativeGlobals.BunRequest(`http://localhost${path}`, { method }),
      );
    expect(at("POST", "/api/auth/passkeys/login")).toBe(true);
    expect(at("POST", "/api/auth/passkeys/register/options")).toBe(true);
    expect(at("POST", "/api/auth/passkeys/login/options")).toBe(false);
  });

  test("with the switch off every route answers as a route that does not exist, and /auth/me says so", async () => {
    setFlag(false);
    try {
      const calls: [string, string, unknown?][] = [
        ["POST", "/auth/passkeys/login/options"],
        ["POST", "/auth/passkeys/login", "{not json"],
        ["POST", "/auth/passkeys/login", { challengeId: "x" }],
        ["GET", "/auth/passkeys"],
        ["POST", "/auth/passkeys/register/options", { password: PASSWORD }],
        ["GET", "/auth/passkeys/offer"],
        ["DELETE", "/auth/passkeys/x"],
      ];
      for (const [method, path, body] of calls) {
        const r = await send(server, null, method, path, body);
        expect({ path, status: r.status, json: r.json }).toEqual({
          path,
          status: 404,
          json: { error: "Not Found" },
        });
      }
      const meOff = await send(server, null, "GET", "/auth/me");
      expect(meOff.json.passkeysEnabled).toBe(false);
    } finally {
      setFlag(true);
    }
    const meOn = await send(server, null, "GET", "/auth/me");
    expect(meOn.json.passkeysEnabled).toBe(true);
  });
});
