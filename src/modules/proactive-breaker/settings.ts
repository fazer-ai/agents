import { z } from "zod";

// THE ACCOUNT-WIDE PROACTIVE BREAKER's configuration, the `proactiveBreaker` block of
// `tenant.settings`. Its state (tripped or not, and the automatic limit's inputs) is the
// `proactive_breakers` row; see docs/proactive-breaker.md.

export const PROACTIVE_BREAKER_MODES = ["auto", "fixed", "off"] as const;
export type ProactiveBreakerMode = (typeof PROACTIVE_BREAKER_MODES)[number];

// The automatic limit is this many times the account's largest 24h proactive volume of the last
// 30 days, and never below the floor: a quiet account must not trip on its first campaign.
export const AUTO_MULTIPLIER = 3;
export const AUTO_FLOOR = 1000;
export const AUTO_LOOKBACK_DAYS = 30;
// What an admin may pin: a typo with extra zeros is refused rather than stored as no guard at all.
export const FIXED_LIMIT_MAX = 10_000_000;

export interface ProactiveBreakerConfig {
  mode: ProactiveBreakerMode;
  // The pinned number, kept while the mode is `auto` or `off` so switching back restores it.
  limit: number | null;
}

export const PROACTIVE_BREAKER_DEFAULTS: ProactiveBreakerConfig = {
  mode: "auto",
  limit: null,
};

export const proactiveBreakerSettingsSchema = z
  .object({
    mode: z.enum(PROACTIVE_BREAKER_MODES),
    limit: z.number().int().min(1).max(FIXED_LIMIT_MAX).nullable(),
  })
  .refine((b) => b.mode !== "fixed" || b.limit !== null, {
    message: "a fixed limit needs a number",
    path: ["limit"],
  });

// Lenient, like every runtime reader of `tenant.settings`: an absent or damaged block is the
// default, which is the breaker ON at its automatic limit. A block that no longer parses must not
// turn the money guard off.
export function readProactiveBreakerConfig(
  settings: unknown,
): ProactiveBreakerConfig {
  const block = (settings as Record<string, unknown> | null | undefined)
    ?.proactiveBreaker;
  const parsed = proactiveBreakerSettingsSchema.safeParse({
    ...PROACTIVE_BREAKER_DEFAULTS,
    ...(block && typeof block === "object" ? block : {}),
  });
  return parsed.success ? parsed.data : { ...PROACTIVE_BREAKER_DEFAULTS };
}

// The automatic limit for a given peak: 3x it, never below the floor.
export function autoLimitFor(peak: number | null): number {
  return Math.max(AUTO_FLOOR, AUTO_MULTIPLIER * (peak ?? 0));
}
