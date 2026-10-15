import type { TFunction } from "i18next";
import { throughputOfSignal } from "@/modules/instance-health/signals";

// The screen's names for each instance signal. The key carries a `:` (the scheduler lane), which
// i18next reads as a namespace separator, so the label key spells it with `_`.

// t('instanceHealth.signal.event_loop_p99_ms', 'Event loop delay (p99)')
// t('instanceHealth.signal.model_permit_waiters', 'Turns waiting for a model permit')
// t('instanceHealth.signal.model_permit_oldest_ms', 'Oldest wait for a model permit')
// t('instanceHealth.signal.debounce_lane_full_ms', 'Debounce lane full for')
// t('instanceHealth.signal.ingress_lag_p95_ms', 'Chatwoot webhook lag (p95)')
// t('instanceHealth.signal.chatwoot_pending_oldest_ms', 'Oldest unprocessed Chatwoot webhook')
// t('instanceHealth.signal.scheduler_queue_age_ms_shared', 'Shared job queue age')
// t('instanceHealth.signal.scheduler_queue_age_ms_debounce', 'Debounce queue age')
// t('instanceHealth.signal.scheduler_queue_age_ms_compaction', 'Compaction queue age')
// t('instanceHealth.signal.scheduler_queue_age_ms_observe', 'Observer queue age')
// t('instanceHealth.signal.pool_waiters_main', 'Main pool: waiting for a connection')
// t('instanceHealth.signal.pool_waiters_background', 'Background pool: waiting for a connection')
// t('instanceHealth.signal.pool_waiters_checkpointer', 'Checkpointer pool: waiting for a connection')
// t('instanceHealth.signal.pool_waiters_ack', 'Webhook ack pool: waiting for a connection')
// t('instanceHealth.signal.pool_waiters_metrics', 'Metrics pool: waiting for a connection')
// t('instanceHealth.signal.lock_timeouts_per_min', 'Lock timeouts')
// t('instanceHealth.signal.debounce_waiters', 'Message bursts waiting for a debounce slot')

// t('instanceHealth.help.event_loop_p99_ms', 'How late a timer fires in this process. High values slow every request and every turn at once.')
// t('instanceHealth.help.model_permit_waiters', 'Model calls queued behind the concurrency limit (AGENT_MODEL_CONCURRENCY).')
// t('instanceHealth.help.model_permit_oldest_ms', 'How long the first queued model call has been waiting for a permit.')
// t('instanceHealth.help.debounce_lane_full_ms', 'How long every debounce slot has been busy, with customer replies waiting behind them.')
// t('instanceHealth.help.ingress_lag_p95_ms', 'Time from Chatwoot sending a webhook to this process verifying it, over the last minute.')
// t('instanceHealth.help.chatwoot_pending_oldest_ms', 'Age of the oldest Chatwoot webhook received but not yet picked up.')
// t('instanceHealth.help.scheduler_queue_age_ms_shared', 'How overdue the oldest job of the shared lane is (follow-ups, sweeps, recoveries).')
// t('instanceHealth.help.scheduler_queue_age_ms_debounce', 'How overdue the oldest message burst waiting to be answered is.')
// t('instanceHealth.help.scheduler_queue_age_ms_compaction', 'How overdue the oldest memory compaction is.')
// t('instanceHealth.help.scheduler_queue_age_ms_observe', 'How overdue the oldest observer verdict is.')
// t('instanceHealth.help.pool_waiters_main', 'Requests queued for a connection of the main pool (turns, Chatwoot deliveries, the console). Any for 30 s means DB_POOL_MAX is too small for the load.')
// t('instanceHealth.help.pool_waiters_background', 'Requests queued for a connection of the background pool (scheduler jobs, workers). See BACKGROUND_POOL_MAX.')
// t('instanceHealth.help.pool_waiters_checkpointer', 'Requests queued for a connection of the conversation checkpointer pool. See LANGGRAPH_POOL_MAX.')
// t('instanceHealth.help.pool_waiters_ack', 'Requests queued for a connection of the Chatwoot webhook ack pool. See CHATWOOT_ACK_POOL_MAX.')
// t('instanceHealth.help.pool_waiters_metrics', 'Requests queued for a connection of the metrics pool (dashboards, this screen). See METRICS_POOL_MAX.')
// t('instanceHealth.help.lock_timeouts_per_min', 'Statements that gave up waiting for a row lock (SQLSTATE 55P03, DB_LOCK_TIMEOUT_MS) in the last minute.')
// t('instanceHealth.help.debounce_waiters', 'Message bursts due to be answered with no debounce slot free yet.')

export function signalI18nKey(signal: string): string {
  return signal.replace(/:/g, "_");
}

// The three signals of a kind deleted on DONE are named from the kind, so the eight
// kinds share one phrase per measure instead of a key each.
function throughputLabel(signal: string, t: TFunction): string | null {
  const tp = throughputOfSignal(signal);
  if (!tp) return null;
  if (tp.measure === "done") {
    return t("instanceHealth.kindDone", "{{kind}}: completed per minute", {
      kind: tp.kind,
    });
  }
  if (tp.measure === "failed") {
    return t("instanceHealth.kindFailed", "{{kind}}: failed per minute", {
      kind: tp.kind,
    });
  }
  return t("instanceHealth.kindStalled", "{{kind}}: no progress for", {
    kind: tp.kind,
  });
}

function throughputHelp(signal: string, t: TFunction): string | null {
  const tp = throughputOfSignal(signal);
  if (!tp) return null;
  if (tp.measure === "done") {
    return t(
      "instanceHealth.kindDoneHelp",
      "Jobs of this kind this process finished in the last minute. Their rows are deleted when they finish, so this is the only record that they ran. Not alerting by default.",
    );
  }
  if (tp.measure === "failed") {
    return t(
      "instanceHealth.kindFailedHelp",
      "Runs of this kind that failed in the last minute, retries included, and claims taken back after a crash. Not alerting by default: a job that runs out of retries already reaches the tenant's alerts.",
    );
  }
  return t(
    "instanceHealth.kindStalledHelp",
    "How long jobs of this kind have been due with none finishing. A slow queue keeps it short, since each completion resets it; a stuck one makes it grow. 0 when nothing is due.",
  );
}

export function signalLabel(signal: string, t: TFunction): string {
  const tp = throughputLabel(signal, t);
  if (tp) return tp;
  // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments above
  return t(`instanceHealth.signal.${signalI18nKey(signal)}`, signal);
}

export function signalHelp(signal: string, t: TFunction): string {
  const tp = throughputHelp(signal, t);
  if (tp) return tp;
  // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments above
  return t(`instanceHealth.help.${signalI18nKey(signal)}`, "");
}

export function formatSignalValue(value: number, unit: string): string {
  if (unit === "count") return String(Math.round(value));
  if (unit === "per_minute") return `${Math.round(value)}/min`;
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)} min`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${Math.round(value)} ms`;
}

// A signal's history for the chart, on its own clock: a stretch with no sample (the database half
// failing, the process stopped) becomes a break in the line instead of two neighbours joined across
// it. A gap is a spacing over three times the series' typical one (its median), which holds for the
// 5 s process signals and the 15 s database ones alike.
export function historyWithGaps(
  points: readonly { at: number; value: number }[],
): { at: number; value: number | null }[] {
  if (points.length < 3) return [...points];
  const steps = points
    .slice(1)
    .map((p, i) => p.at - (points[i] as { at: number }).at)
    .sort((a, b) => a - b);
  const typical = steps[Math.floor(steps.length / 2)] as number;
  const out: { at: number; value: number | null }[] = [];
  for (const [i, p] of points.entries()) {
    const prev = points[i - 1];
    if (prev && typical > 0 && p.at - prev.at > typical * 3) {
      out.push({ at: prev.at + typical, value: null });
    }
    out.push(p);
  }
  return out;
}

// The tallest sample of the window, said in words under the curve: the chart has no axis, so
// without it a card reading "0 ms" over a spike reads as a contradiction.
export function historyPeak(
  points: readonly { at: number; value: number }[],
): number | null {
  return points.length === 0 ? null : Math.max(...points.map((p) => p.value));
}
