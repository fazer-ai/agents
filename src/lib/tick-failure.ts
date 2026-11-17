import logger from "@/api/lib/logger";
import { isDatabaseUnavailable } from "@/lib/pool-retry";

// How a background loop reports a failed tick (docs/logs.md, "Background loops"). An error-level line
// pages the ops alert channel, and a host that stalls the process for a few seconds makes every
// loop that ticks in that window fail at once with no connection to give: measured at 50-71% CPU
// steal for ~20 s, every pool's `maxWait` expired together, and every loop's next tick succeeded.
// So a failure that is only the database being unavailable logs at warn while the outage is younger
// than TICK_OUTAGE_PAGE_MS, and at error past it. Any other error logs at error the first time.
export const TICK_OUTAGE_PAGE_MS = 60_000;

export type TickFailureLevel = "warn" | "error";

// `outageMs` is how long this loop has failed with the database unavailable, from the first such
// failure since its last good tick.
export function tickFailureLevel(
  unavailable: boolean,
  outageMs: number,
  pageMs: number = TICK_OUTAGE_PAGE_MS,
): TickFailureLevel {
  return unavailable && outageMs < pageMs ? "warn" : "error";
}

export interface TickFailures {
  // A tick that completed: the outage, if any, is over.
  succeeded(): void;
  // Logs the failure at the level above. `fields` and `msg`/`args` are what the loop logged before,
  // so its line keeps its shape (a loop that masks its error message passes the masked string).
  failed(
    err: unknown,
    fields: Record<string, unknown>,
    msg: string,
    ...args: unknown[]
  ): void;
}

// One per loop: the outage is that loop's own, so a loop that recovered does not hide another that
// keeps failing.
export function tickFailures(
  opts: { now?: () => number; pageMs?: number } = {},
): TickFailures {
  const now = opts.now ?? Date.now;
  let outageSince: number | null = null;
  return {
    succeeded() {
      outageSince = null;
    },
    failed(err, fields, msg, ...args) {
      const unavailable = isDatabaseUnavailable(err);
      if (unavailable) outageSince ??= now();
      const outageMs = outageSince === null ? 0 : now() - outageSince;
      if (tickFailureLevel(unavailable, outageMs, opts.pageMs) === "error") {
        logger.error(fields, msg, ...args);
        return;
      }
      logger.warn(
        { ...fields, transient: true, outageMs },
        `${msg} (transient: the database had no connection to give; the next tick retries)`,
        ...args,
      );
    },
  };
}
