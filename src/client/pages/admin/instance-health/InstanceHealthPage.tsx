import { Activity, Pencil } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import {
  Badge,
  Button,
  Card,
  DataBoundary,
  EmptyState,
  HelpPopover,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  SegmentedControl,
  Skeleton,
  Switch,
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { throughputOfSignal } from "@/modules/instance-health/signals";
import { JOB_LANE } from "@/modules/scheduler/lanes";
import type { SchedulerJobKind } from "@/modules/scheduler/service";
import { InstanceAlertChannels } from "./InstanceAlertChannels";
import { formatSignalValue, signalHelp, signalLabel } from "./signals";

const Sparkline = lazy(() => import("./Sparkline"));

// The instance's own load (docs/logs.md, instance alerts): one card per signal with its last value,
// its last hour and its threshold, refreshed at the sampler's cadence, and the instance's alert
// channels below. SUPER_ADMIN only.

type HealthResponse = Awaited<
  ReturnType<(typeof api.api.v1)["instance-health"]["get"]>
>["data"];
type Health = NonNullable<HealthResponse>["health"];
type Signal = Health["signals"][number];

const POLL_MS = 5_000;
const CARD_SKELETON_KEYS = ["s-0", "s-1", "s-2", "s-3", "s-4", "s-5"];

interface ThresholdPayload {
  signal: Signal;
  // A kind's card edits its three signals from one dialog: the stall, and the two rates.
  choices?: Signal[];
}

function ThresholdModal({
  modal,
  onSaved,
}: {
  modal: ModalController<ThresholdPayload>;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const enabledId = useId();
  const thresholdId = useId();
  const durationId = useId();
  const [signal, setSignal] = useState<Signal | undefined>(undefined);
  const choices = modal.payload?.choices;
  const [threshold, setThreshold] = useState("");
  const [duration, setDuration] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const fill = (s: Signal | undefined) => {
    setSignal(s);
    setThreshold(String(s?.threshold ?? 0));
    setDuration(String(s?.durationSeconds ?? 0));
    setEnabled(s?.enabled ?? true);
    setError("");
  };

  useOnModalOpen(modal, () => fill(modal.payload?.signal));

  const thresholdNum = Number(threshold);
  const durationNum = Number(duration);
  // Said on the field, not only by a disabled Save: a negative or non-numeric value is refused
  // everywhere (REST, MCP), and the screen names why.
  const thresholdInvalid =
    threshold.trim() !== "" &&
    !(Number.isFinite(thresholdNum) && thresholdNum >= 0);
  const durationInvalid =
    duration.trim() !== "" &&
    !(Number.isInteger(durationNum) && durationNum >= 0 && durationNum <= 3600);
  const valid =
    threshold.trim() !== "" &&
    Number.isFinite(thresholdNum) &&
    thresholdNum >= 0 &&
    duration.trim() !== "" &&
    Number.isInteger(durationNum) &&
    durationNum >= 0 &&
    durationNum <= 3600;

  const save = async (reset: boolean) => {
    if (!signal) return;
    setError("");
    setLoading(true);
    try {
      const route = api.api.v1["instance-health"].thresholds({
        signal: signal.signal,
      });
      const { error: err } = reset
        ? await route.delete()
        : await route.put({
            threshold: thresholdNum,
            durationSeconds: durationNum,
            enabled,
          });
      if (err) {
        setError(
          apiErrorMessage(err) ||
            t(
              "instanceHealth.thresholdSaveFailed",
              "Could not save the threshold",
            ),
        );
        return;
      }
      onSaved();
      modal.close();
    } catch {
      setError(
        t("instanceHealth.thresholdSaveFailed", "Could not save the threshold"),
      );
    } finally {
      setLoading(false);
    }
  };

  const unitHint =
    signal?.unit === "count"
      ? t("instanceHealth.unitCount", "count")
      : signal?.unit === "per_minute"
        ? t("instanceHealth.unitPerMinute", "per minute")
        : t("instanceHealth.unitMs", "milliseconds");

  return (
    <Modal
      modal={modal}
      size="sm"
      // A save in flight finishes into this dialog: closing now would let it close the next one.
      onCloseRequest={loading ? () => undefined : undefined}
      title={
        signal
          ? choices
            ? t("instanceHealth.kindThresholdTitle", "Thresholds: {{kind}}", {
                kind: throughputOfSignal(signal.signal)?.kind ?? "",
              })
            : t("instanceHealth.thresholdTitle", "Threshold: {{signal}}", {
                signal: signalLabel(signal.signal, t),
              })
          : ""
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!loading && valid) void save(false);
        }}
      >
        {error && (
          <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
            {error}
          </div>
        )}
        {choices && signal && (
          <SegmentedControl
            aria-label={t("instanceHealth.kindSignalPick", "Signal")}
            value={signal.signal}
            onChange={(key) => {
              if (loading) return;
              fill(choices.find((c) => c.signal === key));
            }}
            options={choices.map((c) => ({
              value: c.signal,
              label: kindMeasureLabel(c.signal, t),
            }))}
          />
        )}
        <div>
          <label
            htmlFor={thresholdId}
            className="mb-1 block font-medium text-sm text-text-primary"
          >
            {t("instanceHealth.thresholdLabel", "Alert when above ({{unit}})", {
              unit: unitHint,
            })}
          </label>
          <Input
            id={thresholdId}
            type="number"
            min={0}
            // REST and MCP accept a fractional threshold; the default step of 1 would make the form
            // refuse to save one, even to only mute the signal.
            step="any"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            disabled={loading}
            error={thresholdInvalid}
            aria-invalid={thresholdInvalid}
          />
          {thresholdInvalid && (
            <p className="mt-1 text-error text-xs" role="alert">
              {t(
                "instanceHealth.thresholdInvalid",
                "The threshold must be a number of zero or more.",
              )}
            </p>
          )}
        </div>
        <div>
          <label
            htmlFor={durationId}
            className="mb-1 block font-medium text-sm text-text-primary"
          >
            {t("instanceHealth.durationLabel", "For at least (seconds)")}
          </label>
          <Input
            id={durationId}
            type="number"
            min={0}
            max={3600}
            step={1}
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            disabled={loading}
            error={durationInvalid}
            aria-invalid={durationInvalid}
          />
          {durationInvalid && (
            <p className="mt-1 text-error text-xs" role="alert">
              {t(
                "instanceHealth.durationInvalid",
                "The duration must be a whole number of seconds, from 0 to 3600.",
              )}
            </p>
          )}
          <p className="mt-1 text-text-muted text-xs">
            {t(
              "instanceHealth.durationHint",
              "0 alerts on the first sample above the threshold.",
            )}
          </p>
        </div>
        <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
          <label
            htmlFor={enabledId}
            className="font-medium text-sm text-text-primary"
          >
            {t("instanceHealth.alertOnSignal", "Alert on this signal")}
          </label>
          <Switch
            id={enabledId}
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={loading}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={loading}
            onClick={() => void save(true)}
          >
            {t("instanceHealth.resetDefault", "Reset to default")}
          </Button>
          <div className="flex gap-2">
            <ModalCancelButton disabled={loading} />
            <Button
              type="submit"
              loading={loading}
              disabled={loading || !valid}
            >
              {t("common.save", "Save")}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function SignalCard({
  signal,
  detail,
  onEdit,
  alerts,
}: {
  signal: Signal;
  // A line under the value: a pool's connections, or a lane's jobs by kind.
  detail?: string | null;
  onEdit: () => void;
  // The signals this card speaks for, when it is more than its own: a kind's card carries its two
  // rates, and its badge says which one is firing, and that it is not alerting only when none is on.
  alerts?: Signal[];
}) {
  const { t } = useTranslation();
  const firing = (alerts ?? [signal]).find(
    (s) => s.firing && (s.signal === signal.signal || !s.stale),
  );
  const alerting = (alerts ?? [signal]).some((s) => s.enabled);
  const help = signalHelp(signal.signal, t);
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <span className="font-medium text-sm text-text-primary">
            {signalLabel(signal.signal, t)}
          </span>
          {help && <HelpPopover content={help} />}
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {signal.stale && (
            <Badge variant="warning">
              {t("instanceHealth.signalStale", "Not updated since {{time}}", {
                time: signal.at ? new Date(signal.at).toLocaleTimeString() : "",
              })}
            </Badge>
          )}
          {/* A stale reading says nothing about whether it is still above; a rate it carries is read
              on its own, so a firing one shows beside the stall's warning. */}
          {firing && !(firing.signal === signal.signal && signal.stale) ? (
            <Badge variant="error">
              {firing.signal !== signal.signal
                ? t(
                    "instanceHealth.kindFiring",
                    "{{measure}} above threshold",
                    { measure: kindMeasureLabel(firing.signal, t) },
                  )
                : t("instanceHealth.firing", "Above threshold")}
            </Badge>
          ) : (
            !signal.stale &&
            !alerting && (
              <Badge variant="secondary">
                {t("instanceHealth.muted", "Not alerting")}
              </Badge>
            )
          )}
        </div>
      </div>
      <div className="font-semibold text-2xl text-text-primary tabular-nums">
        {signal.value === null
          ? "—"
          : formatSignalValue(signal.value, signal.unit)}
      </div>
      {detail && <div className="text-text-muted text-xs">{detail}</div>}
      <div className="h-14">
        <Suspense fallback={<Skeleton className="h-14 w-full" />}>
          <Sparkline
            points={signal.history}
            threshold={signal.threshold}
            firing={signal.firing}
          />
        </Suspense>
      </div>
      <div className="flex items-center justify-between gap-2 text-text-muted text-xs">
        <span>
          {signal.durationSeconds > 0
            ? t(
                "instanceHealth.thresholdFor",
                "Alerts above {{value}} for {{seconds}} s",
                {
                  value: formatSignalValue(signal.threshold, signal.unit),
                  seconds: signal.durationSeconds,
                },
              )
            : t("instanceHealth.thresholdNow", "Alerts above {{value}}", {
                value: formatSignalValue(signal.threshold, signal.unit),
              })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onEdit}
          aria-label={t("instanceHealth.editThreshold", "Edit threshold")}
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
    </Card>
  );
}

// The segment names in a kind's dialog: which of its three signals the fields below edit.
function kindMeasureLabel(
  signal: string,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const measure = throughputOfSignal(signal)?.measure;
  if (measure === "done") {
    return t("instanceHealth.kindMeasureDone", "Completed");
  }
  if (measure === "failed") {
    return t("instanceHealth.kindMeasureFailed", "Failed");
  }
  return t("instanceHealth.kindMeasureStalled", "No progress");
}

// The line under a kind's card: its two rates, how overdue its oldest due job is, and the reading of
// the three. The rates are counted in process, so they show even while the database half has never
// answered; the oldest due job and the reading come from that half and are left out until it does.
function kindDetail(
  kind: string,
  health: Health,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  const k = health.schedulerThroughput[kind];
  if (!k) return null;
  const parts = [
    t("instanceHealth.kindRates", "{{done}} completed · {{failed}} failed", {
      done: formatSignalValue(k.donePerMin ?? 0, "per_minute"),
      failed: formatSignalValue(k.failedPerMin ?? 0, "per_minute"),
    }),
  ];
  if (k.state === "unknown") return parts.join(" · ");
  if (k.oldestDueMs !== null) {
    parts.push(
      t("instanceHealth.kindOldestDue", "oldest due {{age}}", {
        age: formatSignalValue(k.oldestDueMs, "ms"),
      }),
    );
  }
  parts.push(
    k.state === "stuck"
      ? t("instanceHealth.kindStuck", "stuck")
      : k.state === "draining"
        ? t("instanceHealth.kindDraining", "draining")
        : t("instanceHealth.kindIdle", "nothing due"),
  );
  return parts.join(" · ");
}

// The line under a card's value: a pool's connections, or each kind of a scheduler lane with its age.
function signalDetail(
  signal: string,
  health: Health,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  const pool = /^pool_waiters:(.+)$/.exec(signal)?.[1];
  if (pool) {
    const p = health.pools[pool];
    if (!p) return null;
    return t(
      "instanceHealth.poolDetail",
      "{{inUse}} in use · {{idle}} idle · oldest wait {{oldest}}",
      {
        inUse: p.inUse,
        idle: p.idle,
        oldest: formatSignalValue(p.oldestWaitMs, "ms"),
      },
    );
  }
  const lane = /^scheduler_queue_age_ms:(.+)$/.exec(signal)?.[1];
  // Never read (the database half failing): "no job overdue" would be a claim with nothing behind it.
  if (lane && health.signals.find((s) => s.signal === signal)?.value != null) {
    const kinds = Object.entries(health.schedulerKinds)
      .filter(([kind]) => JOB_LANE[kind as SchedulerJobKind] === lane)
      .sort(([, a], [, b]) => b - a)
      .map(([kind, age]) => `${kind} ${formatSignalValue(age, "ms")}`);
    return kinds.length > 0
      ? kinds.join(" · ")
      : t("instanceHealth.laneIdle", "No job overdue");
  }
  return null;
}

// `pollMs` is the sampler's cadence; a test passes a short one.
export function InstanceHealthPage({ pollMs = POLL_MS }: { pollMs?: number }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { showToast } = useToast();
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // When the last background refresh failed: the cards still show the previous read, and say so.
  const [staleSince, setStaleSince] = useState<Date | null>(null);
  const thresholdModal = useModalController<ThresholdPayload>();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  // Requests are numbered: a slow one answering after a newer one was applied is dropped, so an old
  // read never overwrites a newer one nor clears the warning a newer failure raised.
  const sent = useRef(0);
  const applied = useRef(0);

  const fetchHealth = useCallback(async (initial: boolean) => {
    if (initial) setLoading(true);
    const id = ++sent.current;
    const current = () => {
      if (id < applied.current) return false;
      applied.current = id;
      return true;
    };
    const failed = () => {
      if (!current()) return;
      if (initial) setError(true);
      else setStaleSince((prev) => prev ?? new Date());
    };
    try {
      const { data, error: err } = await api.api.v1["instance-health"].get();
      if (err || !data) {
        failed();
        return;
      }
      if (!current()) return;
      setError(false);
      setStaleSince(null);
      setHealth(data.health);
    } catch {
      failed();
    } finally {
      if (initial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isSuperAdmin) return;
    void fetchHealth(true);
    const timer = setInterval(() => void fetchHealth(false), pollMs);
    return () => clearInterval(timer);
  }, [fetchHealth, isSuperAdmin, pollMs]);

  if (user && !isSuperAdmin) return <Navigate to="/admin/users" replace />;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="font-semibold text-base text-text-primary">
            {t("instanceHealth.title", "Instance health")}
          </h2>
          <p className="text-sm text-text-secondary">
            {t(
              "instanceHealth.subtitle",
              "This process's own load, sampled every 5 seconds. The last hour is kept in memory and starts empty after a restart.",
            )}
          </p>
        </div>
        {staleSince && (
          <div
            role="status"
            className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm"
          >
            {t(
              "instanceHealth.stale",
              "Could not refresh since {{time}}: the figures below are from before then.",
              { time: staleSince.toLocaleTimeString() },
            )}
          </div>
        )}
        {health && !health.sampling && (
          <div className="rounded-lg border border-warning bg-warning-soft px-4 py-2 text-sm text-warning">
            {t(
              "instanceHealth.notSampling",
              "This process does not sample (ALERT_WORKER_ENABLED is off), so the figures stay empty and no instance alert is sent.",
            )}
          </div>
        )}
        <DataBoundary
          loading={loading}
          error={error}
          isEmpty={!health || health.signals.length === 0}
          onRetry={() => void fetchHealth(true)}
          skeleton={
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {CARD_SKELETON_KEYS.map((k) => (
                <Skeleton key={k} className="h-40 w-full" />
              ))}
            </div>
          }
          empty={
            <EmptyState
              icon={Activity}
              title={t("instanceHealth.emptyTitle", "No signals yet")}
              description={t(
                "instanceHealth.emptyDescription",
                "The first sample arrives a few seconds after the process starts.",
              )}
            />
          }
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {health?.signals.map((s) => {
              const tp = throughputOfSignal(s.signal);
              // A kind's rates ride on its stall card, which edits all three.
              if (tp && tp.measure !== "stalled") return null;
              if (tp) {
                const choices = health.signals.filter(
                  (o) => throughputOfSignal(o.signal)?.kind === tp.kind,
                );
                return (
                  <SignalCard
                    key={s.signal}
                    signal={s}
                    detail={kindDetail(tp.kind, health, t)}
                    alerts={choices}
                    onEdit={() => thresholdModal.open({ signal: s, choices })}
                  />
                );
              }
              return (
                <SignalCard
                  key={s.signal}
                  signal={s}
                  detail={signalDetail(s.signal, health, t)}
                  onEdit={() => thresholdModal.open({ signal: s })}
                />
              );
            })}
          </div>
        </DataBoundary>
      </section>

      <ThresholdModal
        modal={thresholdModal}
        onSaved={() => {
          showToast(
            t("instanceHealth.thresholdSaved", "Threshold saved"),
            "success",
          );
          void fetchHealth(false);
        }}
      />

      <InstanceAlertChannels pollMs={pollMs} />
    </div>
  );
}
