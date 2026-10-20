import { intRange, numberRange } from "@/lib/number-range";

// What an operator may set for an app (src/lib/number-range.ts): the write schemas (REST and MCP)
// refuse outside it and the console's fields show it. Past these ceilings a limit stops being one, an
// idle anonymous conversation is kept a year at most, and the app's own monthly ceiling starts at a cent.
export const CLIENT_APP_RANGES = {
  anonSessionsPerHour: intRange(1, 1000),
  anonMessagesPerMin: intRange(1, 120),
  anonExpiryDays: intRange(1, 365),
  monthlyCeilingUsd: numberRange(0.01, 1_000_000),
} as const;
