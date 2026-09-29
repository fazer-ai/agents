import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  FormField,
  Input,
  Skeleton,
  SpendBar,
  SpendHealthLines,
  SwitchField,
  Textarea,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";

type Usage = NonNullable<
  Awaited<
    ReturnType<
      (typeof api.api.v1)["tenant-settings"]["spend-ceiling"]["usage"]["get"]
    >
  >["data"]
>;
type UsageEntry = Usage["entries"][number];
type Settings = NonNullable<
  Awaited<ReturnType<(typeof api.api.v1)["tenant-settings"]["get"]>>["data"]
>;
type SpendCeiling = Settings["spendCeiling"];

// How often a card whose first read failed asks again, until a read has said how often the poll
// runs. Once the usage is in hand its own `pollIntervalMs` is the period.
const USAGE_RETRY_MS = 60_000;

// The measurement sits above the fields that set the ceiling: a monthly budget cannot be picked
// without seeing what the month already cost. Both halves show even with no ceiling set, coloured by
// the gate's own verdict so the screen and the runtime agree on "close to the ceiling". The figure is
// DOLLARS from a Langfuse snapshot a job refreshes, so each bar carries the snapshot's health and the
// reconciliation against the local ledger: an undercounting ceiling says so here or nowhere.

// The bar, the figure and every caveat under them are shared with the dashboard, which shows the
// same ceiling on the page where spend is watched. Only the composition is local.
function BarRow({
  label,
  entry,
  money,
  when,
}: {
  label: string;
  entry: UsageEntry | undefined;
  money: Intl.NumberFormat;
  when: (iso: string) => string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <SpendBar label={label} entry={entry} money={money} />
      <SpendHealthLines entry={entry} when={when} money={money} />
    </div>
  );
}

export function SpendCeilingCard({
  value,
  onSaved,
  reloadKey = 0,
}: {
  value: SpendCeiling;
  onSaved: (next: SpendCeiling) => void;
  // Bumped by the page when the Langfuse card beside this one saves: the flag above the bars is the
  // credential's present, and it has to be re-read the moment that present changes.
  reloadKey?: number;
}) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const money = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, {
        style: "currency",
        currency: "USD",
      }),
    [i18n.language],
  );
  const nf = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language],
  );
  const when = useCallback(
    (iso: string) =>
      new Date(iso).toLocaleString(i18n.language, {
        dateStyle: "short",
        timeStyle: "short",
      }),
    [i18n.language],
  );

  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageError, setUsageError] = useState(false);
  const [form, setForm] = useState<SpendCeiling>(value);
  // The dollar fields are edited as TEXT: a number written back on every keystroke turns a
  // cleared field into "0" (so 5 typed over it reads "05") and mangles a trailing point. The number
  // parsed from the text is what the save sends; the text is re-derived only when the settings
  // change underneath.
  const [usdText, setUsdText] = useState({
    inbox: String(value.monthlyInboxUsd),
    playground: String(value.monthlyPlaygroundUsd),
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setForm(value);
    setUsdText({
      inbox: String(value.monthlyInboxUsd),
      playground: String(value.monthlyPlaygroundUsd),
    });
  }, [value]);

  // A read that settles after a newer one is dropped: the mount-time read and the one the
  // Langfuse save asks for can overlap, and the older answer landing last would restore the pre-save
  // flag. Only the latest sequence number's answer, or failure, reaches the state.
  const readSeq = useRef(0);
  const loadUsage = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const { data, error: err } =
        await api.api.v1["tenant-settings"]["spend-ceiling"].usage.get();
      if (err || !data) throw err ?? new Error("no data");
      if (seq !== readSeq.current) return;
      setUsage(data);
      setUsageError(false);
    } catch {
      if (seq !== readSeq.current) return;
      setUsageError(true);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the page's signal to re-read, not a value the effect reads
  useEffect(() => {
    void loadUsage();
  }, [loadUsage, reloadKey]);

  // The card re-reads while it stays open: the health beside each bar is computed per read, so
  // a card left mounted would keep saying "refreshed" from its first read. The period is the poll's
  // own, as the usage reports it.
  const refreshMs = usage?.pollIntervalMs ?? USAGE_RETRY_MS;
  useEffect(() => {
    const timer = setInterval(() => void loadUsage(), refreshMs);
    return () => clearInterval(timer);
  }, [loadUsage, refreshMs]);

  const set = <K extends keyof SpendCeiling>(k: K, v: SpendCeiling[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  // Empty is zero (no ceiling on that half); anything else has to be a finite amount at or
  // above zero. A negative one is REFUSED rather than stored as zero: zero means no ceiling, so
  // rounding "-1" to it would switch the protection off in silence.
  const parseUsd = (text: string): number | null => {
    if (text.trim() === "") return 0;
    const n = Number(text);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const usdInvalid = {
    inbox: parseUsd(usdText.inbox) === null,
    playground: parseUsd(usdText.playground) === null,
  };
  const usdError = t(
    "spendCeiling.usdInvalid",
    "Enter zero or a positive amount in dollars.",
  );
  const setUsd = (k: "inbox" | "playground", text: string) => {
    setUsdText((t) => ({ ...t, [k]: text }));
    const n = parseUsd(text);
    if (n !== null) {
      set(k === "inbox" ? "monthlyInboxUsd" : "monthlyPlaygroundUsd", n);
    }
  };

  async function save() {
    setSaving(true);
    try {
      const { data, error: err } = await api.api.v1["tenant-settings"][
        "spend-ceiling"
      ].put({
        enabled: form.enabled,
        monthlyInboxUsd: form.monthlyInboxUsd,
        monthlyPlaygroundUsd: form.monthlyPlaygroundUsd,
        overCeilingMessage: form.overCeilingMessage,
        handoffEnabled: form.handoffEnabled,
        noticeCooldownSeconds: form.noticeCooldownSeconds,
        warnAtPercent: form.warnAtPercent,
      });
      if (err || !data) throw err ?? new Error("no data");
      onSaved(data.spendCeiling);
      showToast(t("spendCeiling.saved", "Spend ceiling saved."), "success");
      // The bars are derived from the ceiling that was just written, so re-reading them is part of
      // the save: without it a ceiling raised past a spent month keeps showing the red bar that
      // sent the operator here.
      await loadUsage();
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("spendCeiling.saveError", "Could not save the spend ceiling."),
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
  // The marker rides both reads; the settings prop is what the page holds after a save, so it
  // wins, explicit null included: a usage response read before a save in dollars can still carry
  // the marker, and `??` would let it revive the notice.
  const legacy =
    value.legacyTokens === undefined
      ? (usage?.legacyTokens ?? null)
      : value.legacyTokens;
  // Two reads can say "no Langfuse", as two sentences. The flag is the credential's PRESENT,
  // resolved on this request, and says whether the cost can be read, above the bars. A row's
  // sentinel is what the GATE acts on (it learns of a credential only at the next poll), so each bar
  // says from its own row whether calls go through.
  const langfuseMissing = usage !== null && !usage.langfuseConfigured;

  return (
    <Card className="flex flex-col gap-4">
      <div>
        <h2 className="font-medium text-text-primary">
          {t("spendCeiling.title", "Spend ceiling")}
        </h2>
        <p className="mt-0.5 text-sm text-text-muted">
          {t(
            "spendCeiling.desc",
            "Stop spending once a calendar month reaches a dollar budget, as Langfuse costs the month's calls. Customer traffic and the playground are counted apart, so testing can never silence the agent for customers.",
          )}
        </p>
      </div>

      {legacy && (
        <div
          role="status"
          className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-sm text-text-primary"
        >
          {t(
            "spendCeiling.legacy",
            "This ceiling was set in tokens ({{inbox}} for customers, {{playground}} for the playground) before the unit changed to dollars, and tokens do not convert. It is not enforced until you set it in dollars below.",
            {
              inbox: nf.format(legacy.inbox),
              playground: nf.format(legacy.playground),
            },
          )}
        </div>
      )}

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
            {langfuseMissing && (
              <p className="text-sm text-warning">
                {t(
                  "spendCeiling.usage.langfuseMissing",
                  "Langfuse is not configured for this tenant, so the month's cost cannot be read. Configure it in the Langfuse card.",
                )}
              </p>
            )}
            <BarRow
              label={t("spendCeiling.source.inbox", "Customer conversations")}
              entry={entry("inbox")}
              money={money}
              when={when}
            />
            <BarRow
              label={t(
                "spendCeiling.source.playground",
                "Playground (your own tests)",
              )}
              entry={entry("playground")}
              money={money}
              when={when}
            />
          </>
        )}
      </div>

      <SwitchField
        checked={form.enabled}
        onCheckedChange={(v) => set("enabled", v)}
        label={t("spendCeiling.enabled", "Enforce the ceiling")}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <FormField
          label={t("spendCeiling.inboxUsd", "Monthly ceiling: customers (USD)")}
          description={t(
            "spendCeiling.usdHint",
            "US dollars per calendar month, as Langfuse costs the calls. 0 means no ceiling on this half.",
          )}
          error={usdInvalid.inbox ? usdError : null}
        >
          <Input
            type="number"
            min={0}
            step={0.01}
            value={usdText.inbox}
            onChange={(e) => setUsd("inbox", e.target.value)}
          />
        </FormField>
        <FormField
          label={t(
            "spendCeiling.playgroundUsd",
            "Monthly ceiling: playground (USD)",
          )}
          description={t(
            "spendCeiling.usdHint",
            "US dollars per calendar month, as Langfuse costs the calls. 0 means no ceiling on this half.",
          )}
          error={usdInvalid.playground ? usdError : null}
        >
          <Input
            type="number"
            min={0}
            step={0.01}
            value={usdText.playground}
            onChange={(e) => setUsd("playground", e.target.value)}
          />
        </FormField>
        <FormField
          label={t("spendCeiling.warnAt", "Warn at (%)")}
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
      </div>

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
        <Button
          onClick={save}
          loading={saving}
          disabled={usdInvalid.inbox || usdInvalid.playground}
        >
          {t("common.save", "Save")}
        </Button>
      </div>
    </Card>
  );
}
