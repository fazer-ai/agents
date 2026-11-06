import type { PrismaClient } from "@/../generated/prisma/client";
import metricsPrisma from "@/api/lib/prisma-metrics";
import config from "@/config";
import { type InstanceSignalDto, readInstanceHealth } from "../read";
import {
  type DatabaseScreenDto,
  readDatabaseScreen,
  type WindowKey,
} from "./read";
import { DRIFT_SIGNAL } from "./tick";

// What the "Database" screen, its REST route and its MCP tool answer: the screen's figures plus the
// two signals about statements, each with its verdict against its threshold, so every transport
// says whether the database is fine now in the same words.

export const DATABASE_SIGNALS = [
  "statement_timeouts_per_min",
  DRIFT_SIGNAL,
] as const;

// `stale`: the reading behind the value is failing. `firing`: above its threshold for its duration.
// `muted`: alerting is off for it. `no_data`: never read. `ok`: read, current and within.
export type DatabaseSignalState =
  | "ok"
  | "firing"
  | "stale"
  | "muted"
  | "no_data";

export interface DatabaseSignalDto
  extends Omit<InstanceSignalDto, "history" | "detail"> {
  state: DatabaseSignalState;
  // What is behind the value: the statement and work of the last timeout, the statement that drifted.
  detail: string | null;
}

export interface DatabaseViewDto extends DatabaseScreenDto {
  // Whether this process samples (ALERT_WORKER_ENABLED); without it the signals have no reading.
  sampling: boolean;
  signals: DatabaseSignalDto[];
}

export function signalState(
  s: Pick<InstanceSignalDto, "value" | "enabled" | "firing" | "stale">,
): DatabaseSignalState {
  if (s.stale) return "stale";
  if (s.firing) return "firing";
  if (s.value === null) return "no_data";
  if (!s.enabled) return "muted";
  return "ok";
}

export async function readDatabaseView(
  window: WindowKey,
  base: PrismaClient = metricsPrisma,
  sampling: boolean = config.alertWorker.enabled,
): Promise<DatabaseViewDto> {
  // One after the other: on a metrics pool of one connection, a read started beside the screen's
  // long aggregate would time out waiting for it, well inside the screen's own budget.
  const health = await readInstanceHealth(sampling, base);
  const screen = await readDatabaseScreen(window, base);
  const signals = DATABASE_SIGNALS.flatMap((name) => {
    const s = health.signals.find((x) => x.signal === name);
    if (!s) return [];
    const { history: _history, ...rest } = s;
    return [{ ...rest, state: signalState(s) }];
  });
  return { ...screen, sampling, signals };
}
