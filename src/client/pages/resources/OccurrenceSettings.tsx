import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  Button,
  Card,
  DataBoundary,
  FormField,
  HelpPopover,
  Input,
  NumberInput,
  RangeHolds,
  SwitchField,
  Textarea,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { useVaultBaseUrls } from "@/client/lib/vaultCache";
import type { NumberRange } from "@/lib/number-range";
import {
  ABOVE_USUAL_RATIO_RANGE,
  BUSINESS_CONTEXT_MAX,
  CADENCE_MINUTES_RANGE,
  CONCENTRATION_SHARE_RANGE,
  CONSOLIDATION_MINUTES_RANGE,
  FIELD_DESCRIPTION_MAX,
  FIELD_KEY_PATTERN,
  FIELD_NAME_MAX,
  FIELDS_MAX,
  FLAG_HOLD_MINUTES_RANGE,
  NEW_MIN_CONVERSATIONS_RANGE,
  NEW_WITHIN_MINUTES_RANGE,
  OCCURRENCES_DEFAULTS,
  PREVIOUS_DAYS_RANGE,
  READING_MESSAGES,
  READINGS_PER_ROUND,
  WINDOW_MINUTES_RANGE,
} from "@/modules/occurrences/settings";
import {
  type InboxOption,
  OccurrenceInboxesSection,
  type OtherMonitor,
} from "./OccurrenceInboxes";
import {
  EMPTY_MODEL,
  fromDraft,
  type ModelDraft,
  modelProblem,
  OccurrenceModelSection,
  toDraft,
} from "./OccurrenceModels";
import { OccurrenceStatus } from "./OccurrenceStatus";
import {
  fixedFieldDefaults,
  flagsSentence,
  keyFromName,
} from "./occurrenceWords";

export type OccurrencesConfig = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.occurrences.config.get>>["data"]
>["occurrences"];

// A field as edited. A field the account already saved keeps its key (its readings are stored under
// it); a new one takes its key from its name, so no one has to invent one.
type FieldRow = Omit<OccurrencesConfig["fields"][number], "key"> & {
  _id: string;
  savedKey: string | null;
};

let rowSeq = 0;
const rid = () => {
  rowSeq += 1;
  return `f${rowSeq}`;
};

const FLAG_KEYS = [
  "newMinConversations",
  "windowMinutes",
  "previousDays",
  "aboveUsualRatio",
  "concentrationShare",
  "newWithinMinutes",
  "flagHoldMinutes",
] as const;
const NUM_KEYS = ["consolidationMinutes", ...FLAG_KEYS] as const;
type NumKey = (typeof NUM_KEYS)[number];
const NUM_RANGES: Record<NumKey, NumberRange> = {
  consolidationMinutes: CONSOLIDATION_MINUTES_RANGE,
  newMinConversations: NEW_MIN_CONVERSATIONS_RANGE,
  windowMinutes: WINDOW_MINUTES_RANGE,
  previousDays: PREVIOUS_DAYS_RANGE,
  aboveUsualRatio: ABOVE_USUAL_RATIO_RANGE,
  concentrationShare: CONCENTRATION_SHARE_RANGE,
  newWithinMinutes: NEW_WITHIN_MINUTES_RANGE,
  flagHoldMinutes: FLAG_HOLD_MINUTES_RANGE,
};
const numTexts = (c: OccurrencesConfig | null) =>
  Object.fromEntries(NUM_KEYS.map((k) => [k, c ? String(c[k]) : ""])) as Record<
    NumKey,
    string
  >;

// Every row's key, in order: a saved row's own, a new row's from its name, never one an earlier row
// already holds.
function rowKeys(rows: FieldRow[]): string[] {
  const taken = rows
    .map((r) => r.savedKey)
    .filter((k): k is string => k !== null);
  const keys: string[] = [];
  for (const r of rows) {
    if (r.savedKey !== null) {
      keys.push(r.savedKey);
      continue;
    }
    const k = r.name.trim() ? keyFromName(r.name, [...taken, ...keys]) : "";
    keys.push(k);
  }
  return keys;
}

// The inboxes with the account beside a repeated name, as the Dashboards pickers name them. Without the
// filter options the names still show, only without the account.
export async function loadInboxOptions(): Promise<InboxOption[] | null> {
  const [res, options] = await Promise.all([
    api.api.v1.chatwoot.inboxes.get(),
    api.api.v1.metrics["filter-options"].get().catch(() => null),
  ]);
  if (res.error || !res.data) return null;
  const accountOf = new Map(
    (options?.data?.inboxes ?? []).flatMap((i) =>
      i.account ? [[i.id, i.account] as const] : [],
    ),
  );
  return res.data.inboxes.map((i) => {
    const account = accountOf.get(String(i.id));
    return account ? { ...i, account } : i;
  });
}

function Section({
  title,
  intro,
  help,
  children,
}: {
  title: string;
  intro: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-border flex flex-col gap-3 border-t pt-4 first:border-t-0 first:pt-0">
      <div>
        <div className="flex items-center gap-1">
          <h3 className="text-text-primary text-sm font-medium">{title}</h3>
          {help && <HelpPopover content={help} label={title} />}
        </div>
        <p className="text-text-muted text-xs">{intro}</p>
      </div>
      {children}
    </section>
  );
}

// The monitor's configuration (docs/occurrences.md), in the order an admin sets it up: the inboxes it
// reads, what it reads off each conversation, when a theme is flagged, the model, the business context
// and how often the rounds run. The reason and the reference are two fixed fields, filled with their
// defaults on a monitor that has none; any other field is an additional one.
export function OccurrenceSettings({
  monitorId,
  otherMonitors = [],
  onLoaded,
  onSaved,
  onDirtyChange,
  onShowRounds,
  reloadKey = 0,
  active = true,
}: {
  monitorId: string;
  // The account's other monitors, so an inbox one of them also reads says so.
  otherMonitors?: OtherMonitor[];
  onLoaded?: (c: OccurrencesConfig) => void;
  onSaved?: (c: OccurrencesConfig) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onShowRounds?: () => void;
  reloadKey?: number;
  active?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const baseUrlOf = useVaultBaseUrls();
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState<OccurrencesConfig | null>(null);
  const [inboxes, setInboxes] = useState<InboxOption[]>([]);
  const [saving, setSaving] = useState(false);
  // Why the last save was refused, kept on the page (a toast goes away) until the next save.
  const [saveError, setSaveError] = useState<string | null>(null);

  const [enabled, setEnabled] = useState(false);
  const [inboxIds, setInboxIds] = useState<string[]>([]);
  // Every field in the order sent: the reason, the reference when on, then the additional ones. The
  // two fixed fields are found by row, so renaming a new one keeps its role.
  const [fields, setFields] = useState<FieldRow[]>([]);
  const [reasonRow, setReasonRow] = useState<string>("");
  const [referenceRow, setReferenceRow] = useState<string | null>(null);
  const [extrasOpen, setExtrasOpen] = useState(false);
  // The reference row switched off before a save, so switching it back on restores it, saved key,
  // instructions and attribute copy included, instead of starting a new field.
  const [parkedReference, setParkedReference] = useState<FieldRow | null>(null);
  // What the form held right after loading, so a monitor the defaults filled in reads as unchanged
  // until the admin touches it.
  const [pristine, setPristine] = useState<string | null>(null);
  const [adoptSeq, setAdoptSeq] = useState(0);
  const [cadenceText, setCadenceText] = useState("");
  // Edited as text, so a cleared box stays empty instead of turning into 0.
  const [nums, setNums] = useState<Record<NumKey, string>>(() =>
    numTexts(null),
  );
  const [model, setModel] = useState<ModelDraft | null>(null);
  const [businessContext, setBusinessContext] = useState("");
  const [recoverMedia, setRecoverMedia] = useState(false);

  // The defaults are read through a ref: a language change must not recreate `adopt`, which would
  // reload the configuration and throw away an unsaved edit.
  const tRef = useRef(t);
  tRef.current = t;
  const adopt = useCallback((c: OccurrencesConfig) => {
    setSaved(c);
    setEnabled(c.enabled);
    setInboxIds(c.inboxIds);
    const rows: FieldRow[] = c.fields.map(({ key, ...f }) => ({
      ...f,
      savedKey: key,
      _id: rid(),
    }));
    const fixed = fixedFieldDefaults(tRef.current);
    const fresh = (f: { name: string; description: string }): FieldRow => ({
      ...f,
      attribute: false,
      savedKey: null,
      _id: rid(),
    });
    // A monitor with no reason field has never been set up: both fixed fields start filled in, the
    // reference only while there is room for it under the cap.
    let reason = rows.find((r) => r.savedKey === c.reasonField);
    let reference = rows.find((r) => r.savedKey === c.referenceField) ?? null;
    if (!reason) {
      reason = fresh(fixed.reason);
      if (!reference && rows.length + 2 <= FIELDS_MAX)
        reference = fresh(fixed.reference);
    }
    const extras = rows.filter((r) => r !== reason && r !== reference);
    setFields([reason, ...(reference ? [reference] : []), ...extras]);
    setReasonRow(reason._id);
    setReferenceRow(reference?._id ?? null);
    setExtrasOpen(false);
    setParkedReference(null);
    setCadenceText(String(c.cadenceMinutes));
    setNums(numTexts(c));
    setModel(toDraft(c.model));
    setBusinessContext(c.businessContext);
    setRecoverMedia(c.recoverMedia);
    setPristine(null);
    setAdoptSeq((n) => n + 1);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    const [cfg, roster] = await Promise.all([
      api.api.v1.occurrences.monitors({ id: monitorId }).config.get(),
      loadInboxOptions(),
    ]);
    if (cfg.error || !cfg.data || roster === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    adopt(cfg.data.occurrences);
    setInboxes(roster);
    onLoaded?.(cfg.data.occurrences);
    setLoading(false);
  }, [adopt, onLoaded, monitorId]);

  useEffect(() => {
    void load();
  }, [load]);

  const keys = rowKeys(fields);
  const keyOf = (id: string | null) => {
    const i = fields.findIndex((r) => r._id === id);
    return i < 0 ? null : (keys[i] ?? null) || null;
  };
  const reasonField = keyOf(reasonRow);
  const referenceField = keyOf(referenceRow);
  const rowError = (row: FieldRow, i: number): string | null => {
    if (!row.name.trim())
      return t("occurrences.fieldNameMissing", "Give the field a name.");
    const k = keys[i] ?? "";
    if (row.savedKey === null && !FIELD_KEY_PATTERN.test(k))
      return t(
        "occurrences.fieldNameUnusable",
        "Use letters or digits in the name.",
      );
    return null;
  };
  const overCap = fields.length > FIELDS_MAX;
  const rowsInvalid =
    overCap ||
    fields.some((f, i) => rowError(f, i) !== null || !f.description.trim());
  const cadence = /^\d+$/.test(cadenceText.trim())
    ? Number(cadenceText.trim())
    : null;
  // The model as the screen shows it: the form's default until the admin touches it.
  const shownModel = model ?? EMPTY_MODEL;
  const shownProblem = modelProblem(
    shownModel,
    t,
    baseUrlOf(shownModel.credentialRef),
  );
  const modelChanged =
    JSON.stringify(model) !==
    JSON.stringify(saved ? toDraft(saved.model) : null);
  // Judged when the monitor is being switched on or the model was edited here: a saved model that can
  // no longer run (its credential deleted) must not hold an unrelated save, as the server checks only
  // what changed.
  const modelNeedsCheck = (enabled && saved?.enabled !== true) || modelChanged;
  const missingToEnable = enabled
    ? [
        inboxIds.length === 0 &&
          t("occurrences.needsInbox", "at least one inbox"),
        modelNeedsCheck &&
          shownProblem !== null &&
          (shownProblem.field === "credential"
            ? t("occurrences.needsModelKey", "the model's API key")
            : shownProblem.field === "model"
              ? t("occurrences.needsModelId", "the model")
              : t("occurrences.needsModelBaseUrl", "the model's base URL")),
      ].filter((x): x is string => typeof x === "string")
    : [];
  const parsedNums = Object.fromEntries(
    NUM_KEYS.map((k) => {
      const v = nums[k].trim();
      return [k, v !== "" && Number.isFinite(Number(v)) ? Number(v) : null];
    }),
  ) as Record<NumKey, number | null>;
  // Without a reference the concentration box is disabled, so it holds nothing: whatever is left in
  // it (empty, out of range or a new value) is not sent, and the value saved (or the default) stays.
  const hasReference = referenceRow !== null;
  const inactive = (k: NumKey) => k === "concentrationShare" && !hasReference;
  const sentNums = Object.fromEntries(
    NUM_KEYS.map((k) => [
      k,
      inactive(k) ? (saved?.[k] ?? OCCURRENCES_DEFAULTS[k]) : parsedNums[k],
    ]),
  ) as Record<NumKey, number | null>;
  const numsInvalid = NUM_KEYS.some((k) => sentNums[k] === null);
  // Only a model edited here holds the save: one saved before that can no longer run (its credential
  // deleted) must not keep the monitor from being switched off, and the round reports it.
  const modelInvalid =
    model !== null &&
    modelChanged &&
    modelProblem(model, t, baseUrlOf(model.credentialRef)) !== null;
  const contextTooLong = businessContext.length > BUSINESS_CONTEXT_MAX;
  const invalid =
    rowsInvalid ||
    modelInvalid ||
    contextTooLong ||
    numsInvalid ||
    cadence === null ||
    missingToEnable.length > 0;

  const draft = useMemo(
    () => ({
      enabled,
      inboxIds,
      fields: fields.map((f, i) => ({
        key: keys[i] ?? "",
        name: f.name.trim(),
        description: f.description.trim(),
        attribute: f.attribute,
      })),
      reasonField,
      referenceField,
      cadenceMinutes: cadence ?? 0,
      ...(Object.fromEntries(
        NUM_KEYS.map((k) => [k, sentNums[k] ?? 0]),
      ) as Record<NumKey, number>),
      model: fromDraft(model),
      businessContext,
      recoverMedia,
    }),
    [
      enabled,
      inboxIds,
      fields,
      keys,
      reasonField,
      referenceField,
      cadence,
      sentNums,
      model,
      businessContext,
      recoverMedia,
    ],
  );
  const latest = useRef(draft);
  latest.current = draft;
  // The form as loaded, once its state settled after `adopt`.
  useEffect(() => {
    if (adoptSeq > 0) setPristine(JSON.stringify(latest.current));
  }, [adoptSeq]);
  const dirty =
    saved !== null && pristine !== null && JSON.stringify(draft) !== pristine;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      // Only what changed: a value sent unchanged is a value the server checks again.
      const patch = Object.fromEntries(
        Object.entries(draft).filter(
          ([k, v]) =>
            saved === null ||
            JSON.stringify(v) !==
              JSON.stringify((saved as unknown as Record<string, unknown>)[k]),
        ),
      ) as typeof draft;
      // Which row went out under which key, so a row saved while another box is edited keeps it.
      const sent = new Map(fields.map((f, i) => [f._id, keys[i] ?? ""]));
      const { data, error } = await api.api.v1.occurrences
        .monitors({ id: monitorId })
        .config.put(patch);
      if (error || !data) throw error ?? new Error("no data");
      // An edit made while the request was out stays on the form, still unsaved; the rows that were
      // saved take their key now, so renaming one later does not make a new field of it.
      if (JSON.stringify(latest.current) === JSON.stringify(draft))
        adopt(data.occurrences);
      else {
        setSaved(data.occurrences);
        // What went out is what the server holds now: the edits made since stay dirty against it,
        // and undoing them reads as clean.
        setPristine(JSON.stringify(draft));
        const savedKeys = new Set(data.occurrences.fields.map((f) => f.key));
        setFields((rows) =>
          rows.map((r) => {
            const k = sent.get(r._id);
            return r.savedKey === null && k && savedKeys.has(k)
              ? { ...r, savedKey: k }
              : r;
          }),
        );
      }
      showToast(t("occurrences.saved", "Occurrence monitor saved."), "success");
      onSaved?.(data.occurrences);
    } catch (e) {
      const message =
        apiErrorMessage(e) ||
        t("occurrences.saveError", "Could not save the occurrence monitor.");
      setSaveError(message);
      showToast(message, "error");
    } finally {
      setSaving(false);
    }
  }

  const nf = new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 2,
  });
  const numLabel = (k: NumKey) =>
    ({
      consolidationMinutes: t(
        "occurrences.label.consolidationMinutes",
        "Minutes between consolidations",
      ),
      newMinConversations: t(
        "occurrences.label.newMinConversations",
        "Least conversations in the window",
      ),
      windowMinutes: t(
        "occurrences.label.windowMinutes",
        "Recent window, in minutes",
      ),
      previousDays: t(
        "occurrences.label.previousDays",
        "Days compared before the window",
      ),
      aboveUsualRatio: t(
        "occurrences.label.aboveUsualRatio",
        "Times above its usual",
      ),
      concentrationShare: t(
        "occurrences.label.concentrationShare",
        "Share with the same reference (0.6 is 60%)",
      ),
      newWithinMinutes: t(
        "occurrences.label.newWithinMinutes",
        "Minutes a theme stays new",
      ),
      flagHoldMinutes: t(
        "occurrences.label.flagHoldMinutes",
        "Minutes a flag is held",
      ),
    })[k];
  const numHelp: Partial<Record<NumKey, string>> = {
    aboveUsualRatio: t(
      "occurrences.help.usual",
      "A theme's usual is how many conversations it had per hour over the days compared, counting only the time the monitor was reading.",
    ),
    newWithinMinutes: t(
      "occurrences.help.newWithin",
      "A theme is new from its first conversation for this long, while it has the least conversations in the window, so it does not stop being new when the window moves past that first one.",
    ),
    flagHoldMinutes: t(
      "occurrences.help.flagHold",
      "A flagged theme that stops meeting every rule stays listed, muted, for this long, with the time it stopped, so a subject cooling down is not lost at once. 0 takes it off the first round.",
    ),
    consolidationMinutes: t(
      "occurrences.help.consolidation",
      "Every so often the model looks at the open themes together: it merges two that are the same reason, splits one that mixed different reasons, renames one whose title says too much or too little, and merges two names of the same reference.",
    ),
  };
  // Said only once the value moved off it: under every box it is noise.
  const numDefault = (k: NumKey) =>
    parsedNums[k] === OCCURRENCES_DEFAULTS[k]
      ? undefined
      : t("occurrences.default", "Default: {{value}}", {
          value: nf.format(OCCURRENCES_DEFAULTS[k]),
        });
  // The hold and the lasting new say what they do, their default and their range under the box at all
  // times: neither is read off the sentence the way the window or N are.
  const rangeWords = (k: NumKey) => ({
    value: nf.format(OCCURRENCES_DEFAULTS[k]),
    min: nf.format(NUM_RANGES[k].min),
    max: nf.format(NUM_RANGES[k].max),
  });
  const numLine: Partial<Record<NumKey, string>> = {
    newWithinMinutes: t(
      "occurrences.line.newWithin",
      "How long a theme stays new from its first conversation. Default {{value}}, from {{min}} to {{max}} minutes.",
      rangeWords("newWithinMinutes"),
    ),
    flagHoldMinutes: t(
      "occurrences.line.flagHold",
      "How long a theme stays listed, muted, after it stops meeting the rules. Default {{value}}, from {{min}} to {{max}} minutes.",
      rangeWords("flagHoldMinutes"),
    ),
  };
  const sentence = flagsSentence(
    t,
    i18n.language,
    {
      newMinConversations: parsedNums.newMinConversations,
      windowMinutes: parsedNums.windowMinutes,
      previousDays: parsedNums.previousDays,
      aboveUsualRatio: parsedNums.aboveUsualRatio,
      concentrationShare: parsedNums.concentrationShare,
      newWithinMinutes: parsedNums.newWithinMinutes,
      flagHoldMinutes: parsedNums.flagHoldMinutes,
    },
    hasReference,
  );
  const updateRow = (id: string, patch: Partial<FieldRow>) =>
    setFields((rows) =>
      rows.map((r) => (r._id === id ? { ...r, ...patch } : r)),
    );
  const fixedDefaults = fixedFieldDefaults(t);
  // Turning the reference on adds a field, so at the cap its switch waits for an additional one to go.
  const referenceBlocked = referenceRow === null && fields.length >= FIELDS_MAX;
  function setReferenceOn(on: boolean) {
    if (on && referenceRow === null) {
      const row: FieldRow = parkedReference ?? {
        ...fixedDefaults.reference,
        attribute: false,
        savedKey: null,
        _id: rid(),
      };
      setFields((rows) => [rows[0] as FieldRow, row, ...rows.slice(1)]);
      setReferenceRow(row._id);
      setParkedReference(null);
    } else if (!on && referenceRow !== null) {
      setParkedReference(fields.find((r) => r._id === referenceRow) ?? null);
      setFields((rows) => rows.filter((r) => r._id !== referenceRow));
      setReferenceRow(null);
    }
  }
  const extras = fields.filter(
    (f) => f._id !== reasonRow && f._id !== referenceRow,
  );
  // Without a reference the concentration flag is never raised, and its box says so.
  const concentrationOff = (k: NumKey) =>
    k === "concentrationShare" && !hasReference;
  const numberInput = (k: NumKey) => (
    <FormField
      key={k}
      label={numLabel(k)}
      description={
        concentrationOff(k)
          ? t(
              "occurrences.concentrationNeedsReference",
              "Off: it needs a reference field.",
            )
          : (numLine[k] ?? numDefault(k))
      }
      help={numHelp[k]}
    >
      <NumberInput
        range={NUM_RANGES[k]}
        value={nums[k]}
        disabled={concentrationOff(k)}
        onChange={(e) => setNums((n) => ({ ...n, [k]: e.target.value }))}
      />
    </FormField>
  );
  // One field's editable parts: its name, what the monitor writes in it, and the attribute copy.
  const fieldEditor = (row: FieldRow, removable: boolean) => {
    const i = fields.findIndex((r) => r._id === row._id);
    return (
      <>
        <FormField
          label={t("occurrences.fieldName", "Name")}
          error={rowError(row, i)}
        >
          <Input
            value={row.name}
            maxLength={FIELD_NAME_MAX}
            onChange={(e) => updateRow(row._id, { name: e.target.value })}
          />
        </FormField>
        <FormField
          label={t(
            "occurrences.fieldInstruction",
            "What the monitor writes here",
          )}
          error={
            row.description.trim()
              ? undefined
              : t(
                  "occurrences.fieldInstructionMissing",
                  "Say what the monitor writes here.",
                )
          }
        >
          <Textarea
            rows={2}
            value={row.description}
            maxLength={FIELD_DESCRIPTION_MAX}
            onChange={(e) =>
              updateRow(row._id, { description: e.target.value })
            }
          />
        </FormField>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-col gap-1">
            <SwitchField
              checked={row.attribute}
              onCheckedChange={(v) => updateRow(row._id, { attribute: v })}
              label={t(
                "occurrences.fieldAttribute",
                "Also write to the conversation's custom attribute",
              )}
            />
            {row.attribute && keys[i] && (
              <span className="text-text-muted text-xs">
                {t(
                  "occurrences.fieldAttributeKey",
                  "Chatwoot custom attribute: {{attribute}}",
                  { attribute: keys[i] },
                )}
              </span>
            )}
          </div>
          {removable && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("occurrences.fieldRemove", "Remove field")}
              onClick={() =>
                setFields((rows) => rows.filter((r) => r._id !== row._id))
              }
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </>
    );
  };
  const reason = fields.find((f) => f._id === reasonRow);
  const reference = fields.find((f) => f._id === referenceRow);

  return (
    <DataBoundary
      loading={loading}
      error={failed}
      onRetry={load}
      errorLabel={t(
        "occurrences.loadError",
        "Could not read the occurrence monitor.",
      )}
    >
      <RangeHolds>
        <Card className="flex flex-col gap-4">
          <div>
            <h2 className="text-text-primary font-medium">
              {t("occurrences.title", "Occurrence monitor")}
            </h2>
            <p className="text-text-muted mt-0.5 text-sm">
              {t(
                "occurrences.introGeneric",
                "Every round, the monitor reads the recent conversations of the inboxes you choose, writes why each customer got in touch, and groups the same reasons into themes. A theme that runs out of the usual is flagged.",
              )}
            </p>
          </div>

          <SwitchField
            checked={enabled}
            onCheckedChange={setEnabled}
            label={t("occurrences.enabled", "Monitor on")}
          />
          {/* Whether the monitor as saved is working; a switch not saved yet changes nothing. */}
          {saved?.enabled && (
            <OccurrenceStatus
              monitorId={monitorId}
              cadenceMinutes={saved.cadenceMinutes}
              reloadKey={reloadKey}
              active={active}
              {...(onShowRounds ? { onShowRounds } : {})}
            />
          )}

          <Section
            title={t("occurrences.inboxes.title", "Inboxes")}
            intro={t(
              "occurrences.inboxes.intro",
              "Which conversations the monitor reads. Only these inboxes are read, counted and grouped into themes. Each round reads up to {{perRound}} conversations, those waiting longest first, and the newest {{messages}} messages of each; the rest wait for the next round.",
              { perRound: READINGS_PER_ROUND, messages: READING_MESSAGES },
            )}
          >
            <OccurrenceInboxesSection
              inboxes={inboxes}
              otherMonitors={otherMonitors}
              value={inboxIds}
              onChange={setInboxIds}
            />
          </Section>

          <Section
            title={t(
              "occurrences.fieldsTitle",
              "What to read from each conversation",
            )}
            intro={t(
              "occurrences.fieldsIntro3",
              "The monitor writes the reason of each conversation, which is grouped into themes, and optionally what it refers to. You can rename both and change what the monitor is told to write.",
            )}
          >
            {reason && (
              <div
                className="border-border flex flex-col gap-2 rounded-lg border p-3"
                data-testid="occurrences-reason-field"
              >
                <div>
                  <h4 className="text-text-primary text-sm font-medium">
                    {t("occurrences.reasonTitle", "Reason")}
                  </h4>
                  <p className="text-text-muted text-xs">
                    {t(
                      "occurrences.reasonHint",
                      "Required. Conversations with the same reason are grouped into a theme; one whose reason is empty joins no theme.",
                    )}
                  </p>
                </div>
                {fieldEditor(reason, false)}
              </div>
            )}
            <div
              className="border-border flex flex-col gap-2 rounded-lg border p-3"
              data-testid="occurrences-reference-field"
            >
              <div>
                <h4 className="text-text-primary text-sm font-medium">
                  {t("occurrences.referenceTitle", "Reference")}
                </h4>
                <p className="text-text-muted text-xs">
                  {t(
                    "occurrences.referenceHint",
                    "Optional. What the reason refers to, whatever your business deals with. The different ways customers write it become one name, and a theme is flagged when most of its conversations share one.",
                  )}
                </p>
              </div>
              <SwitchField
                checked={reference !== undefined}
                onCheckedChange={setReferenceOn}
                disabled={referenceBlocked}
                label={t("occurrences.referenceOn", "Read the reference")}
              />
              {referenceBlocked && (
                <p className="text-text-secondary text-sm">
                  {t(
                    "occurrences.referenceAtCap",
                    "The monitor reads up to {{max}} fields: remove an additional field to read the reference.",
                    { max: FIELDS_MAX },
                  )}
                </p>
              )}
              {reference ? (
                fieldEditor(reference, false)
              ) : (
                <p className="text-text-secondary text-sm">
                  {t(
                    "occurrences.referenceOff",
                    "Without a reference the monitor works as usual; only the flag for themes concentrated on one reference is off.",
                  )}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                className="text-text-primary flex items-center gap-1 self-start text-sm font-medium"
                aria-expanded={extrasOpen}
                onClick={() => setExtrasOpen((o) => !o)}
              >
                {extrasOpen ? (
                  <ChevronDown className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                )}
                {t("occurrences.extrasTitle", "Additional fields")}
                {extras.length > 0 && (
                  <span className="text-text-muted">({extras.length})</span>
                )}
              </button>
              {extrasOpen && (
                <>
                  <p className="text-text-muted text-xs">
                    {t(
                      "occurrences.extrasIntro",
                      "Other things the monitor writes off each conversation, up to {{max}} fields in all. They are not grouped nor counted; turn on the attribute copy to filter by them in Chatwoot.",
                      { max: FIELDS_MAX },
                    )}
                  </p>
                  {extras.map((row) => (
                    <div
                      key={row._id}
                      className="border-border flex flex-col gap-2 rounded-lg border p-3"
                    >
                      {fieldEditor(row, true)}
                    </div>
                  ))}
                  <div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={fields.length >= FIELDS_MAX}
                      onClick={() =>
                        setFields((rows) => [
                          ...rows,
                          {
                            _id: rid(),
                            savedKey: null,
                            name: "",
                            description: "",
                            attribute: false,
                          },
                        ])
                      }
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      {t("occurrences.fieldAdd", "Add field")}
                    </Button>
                  </div>
                </>
              )}
            </div>
          </Section>

          <Section
            title={t("occurrences.flagsTitle", "When a theme is flagged")}
            intro={t(
              "occurrences.flagsIntroGeneric",
              "A flagged theme is out of the usual: new, above its usual volume, or concentrated on one reference. It is listed first and is what a dashboard shows as flagged; one that stops being out of the usual stays a while, muted.",
            )}
            help={t(
              "occurrences.help.themeGeneric",
              "A theme is a group of conversations with the same reason, whatever words each customer used.",
            )}
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {FLAG_KEYS.map(numberInput)}
            </div>
            <p
              className="bg-bg-secondary text-text-secondary rounded-lg p-3 text-sm"
              aria-live="polite"
              data-testid="occurrences-flags-sentence"
            >
              {sentence ??
                t(
                  "occurrences.sentence.incomplete",
                  "Fill in every value to see when a theme will be flagged.",
                )}
            </p>
            {/* No way to open the panel editor preset exists, so the link names the panel to add. */}
            <p className="text-text-muted text-xs">
              <Link to="/dashboards" className="text-accent font-medium">
                {t("occurrences.toDashboard", "Show on a dashboard")}
              </Link>{" "}
              {t(
                "occurrences.toDashboardHint",
                'In a dashboard, add a panel with the Occurrences source and "Flagged themes only".',
              )}
            </p>
          </Section>

          <Section
            title={t("occurrences.modelTitle", "Model")}
            intro={t(
              "occurrences.modelIntro",
              "The provider, API key and model every step of the monitor runs on. The prompts are fixed; the business context below is what you can add to them.",
            )}
          >
            <OccurrenceModelSection
              value={shownModel}
              onChange={setModel}
              // Said where it holds the save: a model edited here, or one the switch-on needs.
              problem={modelNeedsCheck ? shownProblem : null}
            />
          </Section>

          <Section
            title={t("occurrences.businessContext", "Business context")}
            intro={t(
              "occurrences.businessContextIntroGeneric",
              "Optional. Told to every step: what your business deals with, what things are called, which contacts are routine.",
            )}
          >
            <FormField
              label={t("occurrences.businessContext", "Business context")}
              description={t(
                "occurrences.businessContextChars",
                "{{chars}} of {{max}} characters.",
                {
                  chars: businessContext.length,
                  max: BUSINESS_CONTEXT_MAX,
                },
              )}
              error={
                contextTooLong
                  ? t(
                      "occurrences.businessContextTooLong",
                      "At most {{max}} characters.",
                      { max: BUSINESS_CONTEXT_MAX },
                    )
                  : undefined
              }
            >
              <Textarea
                value={businessContext}
                rows={4}
                onChange={(e) => setBusinessContext(e.target.value)}
              />
            </FormField>
          </Section>

          <Section
            title={t(
              "occurrences.recoverMedia.title",
              "Old voice notes and images",
            )}
            intro={t(
              "occurrences.recoverMedia.intro",
              "On upstream Chatwoot, a voice note's transcription and an image's description are kept for about 15 minutes, so a round that comes later reads them without their content. On the fazer.ai Chatwoot they are kept on the message and this is not needed.",
            )}
          >
            <SwitchField
              checked={recoverMedia}
              onCheckedChange={setRecoverMedia}
              label={t(
                "occurrences.recoverMedia.label",
                "Transcribe and describe them again when reading",
              )}
              help={t(
                "occurrences.recoverMedia.hint",
                'Off by default. Uses the speech-to-text and vision of the agent that receives the inbox, once per new message, and is billed under Occurrences. An agent with "Who this agent serves" on recovers nothing.',
              )}
            />
          </Section>

          <Section
            title={t("occurrences.cadenceTitle", "How often it runs")}
            intro={t(
              "occurrences.cadenceIntroGeneric",
              "A round reads, names the references, places the reasons into themes and flags them. The consolidation runs less often.",
            )}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                label={t("occurrences.cadence", "Minutes between rounds")}
                description={
                  cadence === OCCURRENCES_DEFAULTS.cadenceMinutes
                    ? undefined
                    : t("occurrences.default", "Default: {{value}}", {
                        value: nf.format(OCCURRENCES_DEFAULTS.cadenceMinutes),
                      })
                }
              >
                <NumberInput
                  range={CADENCE_MINUTES_RANGE}
                  value={cadenceText}
                  onChange={(e) => setCadenceText(e.target.value)}
                />
              </FormField>
              {numberInput("consolidationMinutes")}
            </div>
          </Section>

          {overCap && (
            <p className="text-text-secondary text-sm">
              {t(
                "occurrences.fieldsOverCap",
                "The monitor reads up to {{max}} fields: remove one to save.",
                { max: FIELDS_MAX },
              )}
            </p>
          )}
          {missingToEnable.length > 0 && (
            <p className="text-text-secondary text-sm">
              {t("occurrences.needs", "To switch it on, choose {{what}}.", {
                what: missingToEnable.join(", "),
              })}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-3">
            {saveError && (
              <p role="alert" className="text-error text-sm">
                {saveError}
              </p>
            )}
            <Button
              onClick={save}
              loading={saving}
              disabled={invalid || !dirty}
              holdOnRange
            >
              {t("common.save", "Save")}
            </Button>
          </div>
        </Card>
      </RangeHolds>
    </DataBoundary>
  );
}
