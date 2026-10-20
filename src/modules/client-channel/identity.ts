// Who the client channel is talking to. The host application's SERVER calls with the tenant's API
// key and states its signed-in user; the key already trusts that server, so the statement is taken as
// given (docs/client-channel.md, "Trust model"). What the agents enforces on top is ownership: a
// thread belongs to the user and scope it was minted for, and any other caller is told it does not
// exist.
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import {
  isValidDetachedThread,
  newDetachedThreadId,
} from "@/graph/detached-thread";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// What a thread being expired is claimed with, for good (`leaseClientThread` only takes a claim that
// ran out): such a thread is on its way out, so nothing else waits on it.
export const EXPIRY_CLAIM = "expire";

export const EXTERNAL_CHANNELS = ["client"] as const;
export type ExternalChannel = (typeof EXTERNAL_CHANNELS)[number];

export interface ExternalIdentity {
  // The host's own stable id for its user.
  id: string;
  name?: string;
  // What the host scopes the conversation to, such as an organization.
  scope?: string;
  // How the team reaches the user outside the host, when the agent opens a case in its inbox.
  email?: string;
}

export interface ClaimedThread {
  threadId: string;
  externalUserId: bigint;
}

function threadNotFound(): AppError {
  return new AppError("thread not found", 404, "errors.threadNotFound");
}

type ScopedDb = Parameters<Parameters<typeof runScopedOn>[2]>[0];

// The user's row, created on first sight; name and email refreshed when sent, never cleared when
// omitted.
async function recordUser(
  db: ScopedDb,
  tenantId: bigint,
  user: ExternalIdentity,
  now: Date,
): Promise<{ id: bigint }> {
  return db.externalUser.upsert({
    where: {
      tenantId_channel_externalId: {
        tenantId,
        channel: "client",
        externalId: user.id,
      },
    },
    create: {
      tenantId,
      channel: "client",
      externalId: user.id,
      name: user.name ?? null,
      email: user.email ?? null,
      lastSeenAt: now,
    },
    update: {
      lastSeenAt: now,
      ...(user.name !== undefined ? { name: user.name } : {}),
      ...(user.email !== undefined ? { email: user.email } : {}),
    },
    select: { id: true },
  });
}

// Records the user (name and email refreshed when sent, never cleared when omitted) and returns the thread the
// turn runs on: the caller's, when it is this agent's client thread minted for this user and scope;
// a new one bound to them when the caller named none. Any other named thread is not found, with the
// same answer whether it is malformed, unknown or someone else's, so the answer leaks nothing.
export async function claimClientThread(params: {
  ctx: TenantContext;
  agentId: bigint;
  threadId: string | undefined;
  user: ExternalIdentity;
  base: PrismaClient;
  now?: Date;
}): Promise<ClaimedThread> {
  const { ctx, agentId, threadId, user } = params;
  const tenantId = ctx.tenantId as bigint;
  const now = params.now ?? new Date();
  const scope = user.scope ?? null;
  if (threadId && !isValidDetachedThread("client", threadId, tenantId, agentId))
    throw threadNotFound();

  return runScopedOn(params.base, ctx, async (db) => {
    // The agent is asked first so a missing one answers 404 before anything is written, rather
    // than as the foreign key refusing the thread row.
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });
    if (!agent)
      throw new NotFoundError("agent not found", "errors.agentNotFound");
    const person = await recordUser(db, tenantId, user, now);

    if (!threadId) {
      const fresh = newDetachedThreadId("client", tenantId, agentId);
      await db.detachedThread.create({
        data: {
          threadId: fresh,
          tenantId,
          agentId,
          kind: "client",
          externalUserId: person.id,
          scope,
          lastTurnAt: now,
        },
      });
      return { threadId: fresh, externalUserId: person.id };
    }

    // The agent and the kind are in the id itself, checked above by its shape; what the row
    // adds is the owner.
    const bound = await db.detachedThread.updateMany({
      where: { threadId, externalUserId: person.id, scope },
      data: { lastTurnAt: now },
    });
    if (bound.count !== 1) throw threadNotFound();
    return { threadId, externalUserId: person.id };
  });
}

// Claims the thread for one round-trip. Refused while another round-trip holds it and its claim has
// not expired, so the browser's late answers and the user's next message cannot both act on the same
// suspended turn. The expiry frees a thread whose process died mid-turn. With `owner`, the claim
// holds only while the thread is still that user's in that scope, in the same write: a request let
// in before the thread changed hands (an anonymous visitor's, after they signed in) is told the
// thread does not exist.
export async function leaseClientThread(params: {
  ctx: TenantContext;
  threadId: string;
  turnId: string;
  base: PrismaClient;
  leaseMs: number;
  owner?: { externalUserId: bigint; scope: string | null };
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const owned = params.owner
    ? { externalUserId: params.owner.externalUserId, scope: params.owner.scope }
    : {};
  return runScopedOn(params.base, params.ctx, async (db) => {
    const claimed = await db.detachedThread.updateMany({
      where: {
        threadId: params.threadId,
        ...owned,
        OR: [{ activeTurnId: null }, { activeUntil: { lt: now } }],
      },
      data: {
        activeTurnId: params.turnId,
        activeUntil: new Date(now.getTime() + params.leaseMs),
      },
    });
    if (claimed.count === 1) return true;
    if (
      params.owner &&
      (await db.detachedThread.count({
        where: { threadId: params.threadId, ...owned },
      })) === 0
    )
      throw threadNotFound();
    return false;
  });
}

// Pushes the claim's expiry forward while its round-trip is still running, so a long round-trip
// keeps the thread. False when the claim is no longer this round-trip's.
export async function renewClientThread(params: {
  ctx: TenantContext;
  threadId: string;
  turnId: string;
  base: PrismaClient;
  leaseMs: number;
}): Promise<boolean> {
  const renewed = await runScopedOn(params.base, params.ctx, (db) =>
    db.detachedThread.updateMany({
      where: { threadId: params.threadId, activeTurnId: params.turnId },
      data: { activeUntil: new Date(Date.now() + params.leaseMs) },
    }),
  );
  return renewed.count === 1;
}

// Gives the claim back, only when it is still this round-trip's: a claim that expired and was taken
// by another round-trip is that one's to release.
export async function releaseClientThread(params: {
  ctx: TenantContext;
  threadId: string;
  turnId: string;
  base: PrismaClient;
}): Promise<void> {
  await runScopedOn(params.base, params.ctx, (db) =>
    db.detachedThread.updateMany({
      where: { threadId: params.threadId, activeTurnId: params.turnId },
      data: { activeTurnId: null, activeUntil: null },
    }),
  );
}

// How long the hand-over holds a thread: a checkpoint read and one write.
const HAND_OVER_LEASE_MS = 30_000;

// Whether the thread's last turn stopped on calls for the browser and is still waiting for them.
export async function isThreadSuspended(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
): Promise<boolean> {
  const tuple = await checkpointer.getTuple({
    configurable: { thread_id: threadId },
  });
  return (tuple?.pendingWrites ?? []).some(
    ([, channel]) => channel === "__interrupt__",
  );
}

// An anonymous visitor who signs in takes their conversations along: this agent's client threads of
// the anonymous user become the signed-in user's, in the scope their token names. A thread a
// round-trip holds now, or one suspended on calls the browser will never answer, stays behind. The
// caller proves it held the anonymous session; the answer is the threads moved, newest first, and
// moving again moves nothing.
export async function handOverAnonymousThreads(params: {
  ctx: TenantContext;
  agentId: bigint;
  from: string;
  to: ExternalIdentity;
  base: PrismaClient;
  checkpointer: BaseCheckpointSaver;
  now?: () => Date;
}): Promise<string[]> {
  const tenantId = params.ctx.tenantId as bigint;
  const now = params.now ?? (() => new Date());
  const candidates = await runScopedOn(params.base, params.ctx, async (db) => {
    const anonymous = await db.externalUser.findUnique({
      where: {
        tenantId_channel_externalId: {
          tenantId,
          channel: "client",
          externalId: params.from,
        },
      },
      select: { id: true },
    });
    if (!anonymous) return null;
    const threads = await db.detachedThread.findMany({
      where: {
        externalUserId: anonymous.id,
        agentId: params.agentId,
        kind: "client",
      },
      select: { threadId: true, scope: true },
      orderBy: { lastTurnAt: "desc" },
    });
    return { anonymous: anonymous.id, threads };
  });
  if (!candidates || candidates.threads.length === 0) return [];

  // Three steps, all or nothing. Every thread's claim is taken first, as a round-trip takes
  // it, so no turn can start, suspend and let go of a thread while its checkpoint is read; then the
  // checkpoints are read; then one transaction moves every thread not suspended. Whatever fails,
  // the claims still held are let go and nothing has moved, so the page can try again.
  const holder = `hand-over:${crypto.randomUUID()}`;
  const held: string[] = [];
  try {
    for (const { threadId, scope } of candidates.threads) {
      const taken = await leaseClientThread({
        ctx: params.ctx,
        threadId,
        turnId: holder,
        base: params.base,
        leaseMs: HAND_OVER_LEASE_MS,
        owner: { externalUserId: candidates.anonymous, scope },
        now: now(),
      }).catch((e) => {
        if (e instanceof AppError && e.statusCode === 404) return false;
        throw e;
      });
      if (taken) held.push(threadId);
    }
    const movable: string[] = [];
    for (const threadId of held)
      if (!(await isThreadSuspended(params.checkpointer, threadId)))
        movable.push(threadId);
    if (movable.length === 0) return [];
    return await runScopedOn(params.base, params.ctx, async (db) => {
      const person = await recordUser(db, tenantId, params.to, now());
      const moved = await db.detachedThread.updateMany({
        where: { threadId: { in: movable }, activeTurnId: holder },
        data: {
          externalUserId: person.id,
          scope: params.to.scope ?? null,
          activeTurnId: null,
          activeUntil: null,
        },
      });
      // NOTE: a claim that ran out under a slow read and was taken by a turn leaves a thread behind;
      // all or nothing, so the page tries again rather than keep half.
      if (moved.count !== movable.length)
        throw new AppError("the hand-over lost a thread's claim", 409);
      return movable;
    });
  } finally {
    // NOTE: letting go never fails the call: it would hide a move already committed, and a claim
    // left behind runs out by itself.
    if (held.length > 0)
      await runScopedOn(params.base, params.ctx, (db) =>
        db.detachedThread.updateMany({
          where: { threadId: { in: held }, activeTurnId: holder },
          data: { activeTurnId: null, activeUntil: null },
        }),
      ).catch((err) =>
        logger.warn(
          { err, holder },
          "hand-over could not let go of its claims",
        ),
      );
  }
}
