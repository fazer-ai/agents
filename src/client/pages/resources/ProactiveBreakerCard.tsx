import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  FilterPills,
  FormField,
  Input,
  Skeleton,
  useToast,
} from "@/client/components";
import {
  type ProactiveBreakerStatus,
  useProactiveBreaker,
} from "@/client/contexts/ProactiveBreakerContext";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";

type Mode = ProactiveBreakerStatus["mode"];

// The account-wide breaker for proactive messages (docs/proactive-breaker.md). It shares its state
// with the banner every page shows while it is tripped, so a resume here clears the banner too.
export function ProactiveBreakerCard() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const { status, failed, refresh, set } = useProactiveBreaker();
  const nf = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language],
  );
  const when = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      dateStyle: "short",
      timeStyle: "short",
    });
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language, { dateStyle: "medium" });

  const [mode, setMode] = useState<Mode>("auto");
  // Edited as text, so a cleared field stays empty instead of turning into 0.
  const [limitText, setLimitText] = useState("");
  const [saving, setSaving] = useState(false);
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    if (!status) return;
    setMode(status.mode);
    setLimitText(status.fixedLimit === null ? "" : String(status.fixedLimit));
  }, [status]);

  if (!status) {
    return (
      <Card className="flex flex-col gap-3">
        {failed ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-text-muted">
              {t(
                "proactiveBreaker.loadError",
                "Could not read the proactive breaker.",
              )}
            </span>
            <Button size="sm" variant="secondary" onClick={refresh}>
              {t("common.retry", "Retry")}
            </Button>
          </div>
        ) : (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">{t("common.loading", "Loading…")}</span>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-8 w-full" />
          </div>
        )}
      </Card>
    );
  }

  const parsedLimit = /^\d+$/.test(limitText.trim())
    ? Number(limitText.trim())
    : null;
  const limitInvalid =
    mode === "fixed" && (parsedLimit === null || parsedLimit < 1);
  const dirty =
    mode !== status.mode ||
    (mode === "fixed" && parsedLimit !== status.fixedLimit);

  async function save() {
    setSaving(true);
    try {
      const { data, error } = await api.api.v1["tenant-settings"][
        "proactive-breaker"
      ].put({
        mode,
        ...(mode === "fixed" ? { limit: parsedLimit } : {}),
      });
      if (error || !data) throw error ?? new Error("no data");
      set(data.proactiveBreaker);
      showToast(
        t("proactiveBreaker.saved", "Proactive breaker saved."),
        "success",
      );
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t(
            "proactiveBreaker.saveError",
            "Could not save the proactive breaker.",
          ),
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  async function resume() {
    setResuming(true);
    try {
      const { data, error } =
        await api.api.v1["tenant-settings"]["proactive-breaker"].resume.post();
      if (error || !data) throw error ?? new Error("no data");
      set(data.proactiveBreaker);
      showToast(
        t("proactiveBreaker.resumed", "Proactive messages resumed."),
        "success",
      );
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t(
            "proactiveBreaker.resumeError",
            "Could not resume proactive messages.",
          ),
        "error",
      );
    } finally {
      setResuming(false);
    }
  }

  const auto = status.auto;
  const autoSource =
    auto.basis === "peak" && auto.peakAt
      ? t(
          "proactiveBreaker.autoPeak",
          "Automatic: {{limit}}, 3x the peak of {{day}} ({{peak}} proactive messages in 24 hours).",
          {
            limit: nf.format(auto.limit),
            day: day(auto.peakAt),
            peak: nf.format(auto.peak ?? 0),
          },
        )
      : t(
          "proactiveBreaker.autoFloor",
          "Automatic: {{limit}}, the minimum. The largest 24-hour volume in the last 30 days was {{peak}}, and 3x that is below it.",
          {
            limit: nf.format(auto.limit),
            peak: nf.format(auto.peak ?? 0),
          },
        );

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="font-medium text-text-primary">
          {t("proactiveBreaker.title", "Proactive message breaker")}
        </h2>
        <p className="mt-0.5 text-sm text-text-muted">
          {t(
            "proactiveBreaker.desc",
            "Stops every agent's proactive messages (follow-ups, reminders, integration events, templates) when the whole account sends more than this in 24 hours, until an admin resumes them. Replies to customers are never counted or stopped.",
          )}
        </p>
      </div>

      {status.tripped && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-error bg-error-soft px-3 py-2"
        >
          <span className="text-sm text-text-primary">
            {t(
              "proactiveBreaker.trippedSince",
              "Paused since {{since}}: {{sent}} sent in 24 hours, limit {{limit}}. Changing the limit does not resume them.",
              {
                since: when(status.tripped.at),
                sent: nf.format(status.tripped.count),
                limit: nf.format(status.tripped.limit),
              },
            )}
          </span>
          <Button size="sm" onClick={resume} loading={resuming}>
            {t("proactiveBreaker.resume", "Resume")}
          </Button>
        </div>
      )}

      <FormField label={t("proactiveBreaker.mode", "Limit")} group>
        <FilterPills
          aria-label={t("proactiveBreaker.mode", "Limit")}
          value={mode}
          onChange={(k) => setMode(k as Mode)}
          items={[
            {
              key: "auto",
              label: t("proactiveBreaker.modeAuto", "Automatic"),
            },
            {
              key: "fixed",
              label: t("proactiveBreaker.modeFixed", "Fixed number"),
            },
            { key: "off", label: t("proactiveBreaker.modeOff", "Off") },
          ]}
        />
      </FormField>

      {mode === "auto" && (
        <p className="text-sm text-text-secondary">{autoSource}</p>
      )}
      {mode === "fixed" && (
        <FormField
          label={t(
            "proactiveBreaker.fixedLimit",
            "Proactive messages per 24 hours, whole account",
          )}
          description={t(
            "proactiveBreaker.fixedHint",
            "A whole number of at least 1.",
          )}
          error={
            limitInvalid
              ? t(
                  "proactiveBreaker.fixedInvalid",
                  "Enter a whole number of at least 1.",
                )
              : null
          }
        >
          <Input
            type="number"
            min={1}
            step={1}
            value={limitText}
            onChange={(e) => setLimitText(e.target.value)}
          />
        </FormField>
      )}
      {mode === "off" && (
        <p className="text-sm text-text-secondary">
          {t(
            "proactiveBreaker.offHint",
            "No account-wide limit: proactive messages are bounded only by each agent's own per-conversation limit.",
          )}
        </p>
      )}

      <p className="text-text-muted text-xs">
        {status.limit === null
          ? t(
              "proactiveBreaker.countOff",
              "{{sent}} proactive messages in the last 24 hours.",
              { sent: nf.format(status.count) },
            )
          : t(
              "proactiveBreaker.count",
              "{{sent}} of {{limit}} proactive messages counted since {{since}}.",
              {
                sent: nf.format(status.count),
                limit: nf.format(status.limit),
                since: when(status.windowStart),
              },
            )}
      </p>

      <div className="flex justify-end">
        <Button
          onClick={save}
          loading={saving}
          disabled={limitInvalid || !dirty}
        >
          {t("common.save", "Save")}
        </Button>
      </div>
    </Card>
  );
}
