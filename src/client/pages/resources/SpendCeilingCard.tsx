import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  FormField,
  Input,
  Skeleton,
  SwitchField,
  Textarea,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { cn } from "@/client/lib/utils";

type Usage = NonNullable<
  Awaited<
    ReturnType<
      (typeof api.api.v1)["tenant-settings"]["spend-ceiling"]["usage"]["get"]
    >
  >["data"]
>;
type Settings = NonNullable<
  Awaited<ReturnType<(typeof api.api.v1)["tenant-settings"]["get"]>>["data"]
>;
type SpendCeiling = Settings["spendCeiling"];

// THE NUMBER THE OPERATOR CAME FOR, above the fields that set it. The ceiling is the one setting in
// this panel whose value is meaningless without the measurement beside it: nobody can pick a
// monthly token budget without seeing what the month has already cost, and a screen that only took
// the number would send them to the dashboard to find it and back here to type it.
//
// Both halves are shown whether or not a ceiling is set, which is why the bar renders a plain count
// when there is none. The state the gate would return is what colours it, so the screen and the
// runtime cannot disagree about what "close to the ceiling" means.

function BarRow({
  label,
  used,
  ceiling,
  state,
  nf,
}: {
  label: string;
  used: number;
  ceiling: number | null;
  state: string;
  nf: Intl.NumberFormat;
}) {
  const { t } = useTranslation();
  const pct =
    ceiling && ceiling > 0 ? Math.min(100, (used / ceiling) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-sm text-text-secondary">{label}</span>
        <span
          className={cn("text-sm tabular-nums", {
            "text-text-muted": state === "allowed",
            "text-warning": state === "warning",
            "text-error": state === "over",
          })}
        >
          {ceiling === null
            ? t(
                "spendCeiling.usage.noCeiling",
                "{{used}} tokens (no ceiling)",
                {
                  used: nf.format(used),
                },
              )
            : t(
                "spendCeiling.usage.ofCeiling",
                "{{used}} of {{ceiling}} tokens",
                {
                  used: nf.format(used),
                  ceiling: nf.format(ceiling),
                },
              )}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary"
        role="progressbar"
        aria-label={label}
        aria-valuenow={ceiling === null ? undefined : Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn("h-full rounded-full transition-all", {
            "bg-accent": state === "allowed",
            "bg-warning": state === "warning",
            "bg-error": state === "over",
          })}
          style={{ width: `${ceiling === null ? 0 : pct}%` }}
        />
      </div>
    </div>
  );
}

export function SpendCeilingCard({
  value,
  onSaved,
}: {
  value: SpendCeiling;
  onSaved: (next: SpendCeiling) => void;
}) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const nf = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language],
  );

  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [form, setForm] = useState<SpendCeiling>(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(value);
  }, [value]);

  const loadUsage = useCallback(async () => {
    setUsageError(false);
    try {
      const { data, error: err } =
        await api.api.v1["tenant-settings"]["spend-ceiling"].usage.get();
      if (err || !data) throw err ?? new Error("no data");
      setUsage(data);
    } catch {
      setUsageError(true);
    }
  }, []);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const set = <K extends keyof SpendCeiling>(k: K, v: SpendCeiling[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      const { data, error: err } = await api.api.v1["tenant-settings"][
        "spend-ceiling"
      ].put({
        enabled: form.enabled,
        monthlyInboxTokens: form.monthlyInboxTokens,
        monthlyPlaygroundTokens: form.monthlyPlaygroundTokens,
        overCeilingMessage: form.overCeilingMessage,
        handoffEnabled: form.handoffEnabled,
        noticeCooldownSeconds: form.noticeCooldownSeconds,
        warnAtPercent: form.warnAtPercent,
      });
      if (err || !data) throw err ?? new Error("no data");
      onSaved(data.spendCeiling);
      showToast(t("spendCeiling.saved", "Token ceiling saved."), "success");
      // The bars are derived from the ceiling that was just written, so re-reading them is part of
      // the save: without it a ceiling raised past a spent month keeps showing the red bar that
      // sent the operator here.
      await loadUsage();
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("spendCeiling.saveError", "Could not save the token ceiling."),
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  const period = usage
    ? new Date(usage.periodStart).toLocaleDateString(i18n.language, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : "";
  const entry = (source: string) =>
    usage?.entries.find((e) => e.source === source);

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="font-medium text-text-primary">
          {t("spendCeiling.title", "Token ceiling")}
        </h2>
        <p className="mt-0.5 text-sm text-text-muted">
          {t(
            "spendCeiling.desc",
            "Stop spending once a calendar month reaches a token budget. Customer traffic and the playground are counted apart, so testing can never silence the agent for customers.",
          )}
        </p>
      </div>

      <div className="flex flex-col gap-3 rounded-lg border border-border px-3 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium text-sm text-text-primary">
            {t("spendCeiling.usage.title", "Spent this month")}
          </span>
          <span className="text-text-muted text-xs">{period}</span>
        </div>
        {usageError ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-text-muted">
              {t("spendCeiling.usage.error", "Could not read the usage.")}
            </span>
            <Button size="sm" variant="secondary" onClick={loadUsage}>
              {t("common.retry", "Retry")}
            </Button>
          </div>
        ) : usage === null ? (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">{t("common.loading", "Loading…")}</span>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <>
            <BarRow
              label={t("spendCeiling.source.inbox", "Customer conversations")}
              used={entry("inbox")?.usedTokens ?? 0}
              ceiling={entry("inbox")?.ceilingTokens ?? null}
              state={entry("inbox")?.state ?? "allowed"}
              nf={nf}
            />
            <BarRow
              label={t(
                "spendCeiling.source.playground",
                "Playground (your own tests)",
              )}
              used={entry("playground")?.usedTokens ?? 0}
              ceiling={entry("playground")?.ceilingTokens ?? null}
              state={entry("playground")?.state ?? "allowed"}
              nf={nf}
            />
          </>
        )}
      </div>

      <SwitchField
        checked={form.enabled}
        onCheckedChange={(v) => set("enabled", v)}
        label={t("spendCeiling.enabled", "Enforce the ceiling")}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label={t("spendCeiling.inboxTokens", "Monthly ceiling: customers")}
          description={t(
            "spendCeiling.tokensHint",
            "Tokens (prompt + completion) per calendar month. 0 means no ceiling on this half.",
          )}
        >
          <Input
            type="number"
            min={0}
            value={String(form.monthlyInboxTokens)}
            onChange={(e) =>
              set(
                "monthlyInboxTokens",
                Math.max(0, Number(e.target.value) || 0),
              )
            }
          />
        </FormField>
        <FormField
          label={t(
            "spendCeiling.playgroundTokens",
            "Monthly ceiling: playground",
          )}
          description={t(
            "spendCeiling.tokensHint",
            "Tokens (prompt + completion) per calendar month. 0 means no ceiling on this half.",
          )}
        >
          <Input
            type="number"
            min={0}
            value={String(form.monthlyPlaygroundTokens)}
            onChange={(e) =>
              set(
                "monthlyPlaygroundTokens",
                Math.max(0, Number(e.target.value) || 0),
              )
            }
          />
        </FormField>
      </div>

      <FormField
        label={t("spendCeiling.warnAt", "Warn at")}
        description={t(
          "spendCeiling.warnAtHint",
          "Percentage of a ceiling that triggers a warning on your alert channels, so you hear about it before the agent goes quiet. 0 disables the warning.",
        )}
      >
        <Input
          type="number"
          min={0}
          max={100}
          value={String(form.warnAtPercent)}
          onChange={(e) =>
            set(
              "warnAtPercent",
              Math.min(100, Math.max(0, Number(e.target.value) || 0)),
            )
          }
        />
      </FormField>

      <FormField
        label={t("spendCeiling.message", "Message to the customer")}
        description={t(
          "spendCeiling.messageHint",
          "Sent once per conversation while the ceiling is reached. Leave it empty to say nothing.",
        )}
      >
        <Textarea
          rows={2}
          value={form.overCeilingMessage ?? ""}
          onChange={(e) => set("overCeilingMessage", e.target.value || null)}
        />
      </FormField>

      <SwitchField
        checked={form.handoffEnabled}
        onCheckedChange={(v) => set("handoffEnabled", v)}
        label={t(
          "spendCeiling.handoff",
          "Hand refused conversations to a human",
        )}
      />

      <FormField
        label={t("spendCeiling.cooldown", "Notice cooldown (seconds)")}
        description={t(
          "spendCeiling.cooldownHint",
          "How long before the same conversation is told again. The ceiling itself is checked on every message regardless.",
        )}
      >
        <Input
          type="number"
          min={0}
          max={3600}
          value={String(form.noticeCooldownSeconds)}
          onChange={(e) =>
            set(
              "noticeCooldownSeconds",
              Math.min(3600, Math.max(0, Number(e.target.value) || 0)),
            )
          }
        />
      </FormField>

      <div className="flex justify-end">
        <Button onClick={save} loading={saving}>
          {t("common.save", "Save")}
        </Button>
      </div>
    </Card>
  );
}
