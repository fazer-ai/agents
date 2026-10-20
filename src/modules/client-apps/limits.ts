// Requests per minute on the SDK's turn, per user of an app and per app. On the proxy route the host's
// server stands in front and throttles its own users; here the browser calls directly, so the
// instance does. In memory, like the other limiters: the deploy runs one replica.
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import config from "@/config";
import { AppError } from "@/lib/errors";
import { readSpendSnapshot } from "@/modules/spend-ceiling/service";
import { centsOf } from "@/modules/spend-ceiling/settings";
import { appSpendSource, type ResolvedClientApp } from "./service";

const WINDOW_MS = 60_000;

interface Bucket {
  startedAt: number;
  count: number;
}

export class FixedWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private sweptAt = 0;

  constructor(private readonly windowMs = WINDOW_MS) {}

  get size(): number {
    return this.buckets.size;
  }

  // Counts one request against `key` and returns the seconds until its window ends when the request
  // is over `max`, or null when it fits.
  hit(key: string, max: number, now = Date.now()): number | null {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.startedAt >= this.windowMs) {
      this.buckets.set(key, { startedAt: now, count: 1 });
      this.sweep(now);
      return null;
    }
    bucket.count += 1;
    if (bucket.count <= max) return null;
    return Math.max(
      1,
      Math.ceil((bucket.startedAt + this.windowMs - now) / 1000),
    );
  }

  // At most once a window, so the scan is paid once a minute however many buckets a burst creates.
  private sweep(now: number): void {
    if (now - this.sweptAt < this.windowMs) return;
    this.sweptAt = now;
    for (const [key, bucket] of this.buckets)
      if (now - bucket.startedAt >= this.windowMs) this.buckets.delete(key);
  }
}

const limiter = new FixedWindowLimiter();
const hourly = new FixedWindowLimiter(60 * 60_000);

export class SdkRateLimitError extends AppError {
  constructor(readonly retryAfterS: number) {
    super(
      "Rate limit exceeded. Please try again later.",
      429,
      "errors.rateLimitExceeded",
    );
  }
}

// Before the app is looked up, per client address: the preflight and the CORS hook read the database
// on requests no token has vouched for yet, ahead of the instance-wide limiter (which runs on
// `beforeHandle`). Same budget as that limiter, in a bucket of its own.
export function chargeSdkLookup(
  clientIp: string,
  now = Date.now(),
  max = config.rateLimit.userPerMin,
  on: FixedWindowLimiter = limiter,
): void {
  const over = on.hit(`ip:${clientIp}`, max, now);
  if (over !== null) throw new SdkRateLimitError(over);
}

// The user's bucket is asked first, so one user over their budget does not spend the app's.
export function chargeSdkRequest(
  appId: bigint,
  userId: string,
  now = Date.now(),
  limits = config.clientChannel.sdk,
  on: FixedWindowLimiter = limiter,
): void {
  const user = on.hit(`u:${appId}:${userId}`, limits.userPerMin, now);
  if (user !== null) throw new SdkRateLimitError(user);
  const app = on.hit(`a:${appId}`, limits.appPerMin, now);
  if (app !== null) throw new SdkRateLimitError(app);
}

// A new anonymous session, per client address and app: what keeps one address from minting sessions
// to escape the per-session budget. Renewing a session the browser already holds is not counted.
export function chargeAnonSession(
  appId: bigint,
  clientIp: string,
  max: number,
  now = Date.now(),
  on: FixedWindowLimiter = hourly,
): void {
  const over = on.hit(`s:${appId}:${clientIp}`, max, now);
  if (over !== null) throw new SdkRateLimitError(over);
}

// The app's own monthly ceiling, read from the figure the spend poll keeps for it (one poll period
// behind, like the tenant's). A month nobody has polled yet is nothing spent. The tenant's client
// ceiling still applies inside the turn.
export async function assertAppSpendCeiling(
  app: Pick<ResolvedClientApp, "id" | "tenantId" | "monthlyCeilingCents">,
  now: Date = new Date(),
  base?: PrismaClient,
): Promise<void> {
  if (app.monthlyCeilingCents === null) return;
  // A figure that cannot be read allows the call, as the tenant's gate does: a ceiling must
  // never be what silences the agent on a database hiccup (docs/spend-ceiling.md).
  const snapshot = await readSpendSnapshot(
    app.tenantId,
    appSpendSource(app.id) as `app:${string}`,
    now,
    base,
  ).catch((err) => {
    logger.warn(
      { err, appId: String(app.id) },
      "app spend ceiling unreadable; allowing the turn",
    );
    return null;
  });
  if (
    snapshot?.polledAt &&
    centsOf(snapshot.costUsd, "drop") >= app.monthlyCeilingCents
  )
    throw new AppError(
      "this application's spend ceiling for this month has been reached",
      429,
      "errors.clientAppSpendCeilingReached",
    );
}
