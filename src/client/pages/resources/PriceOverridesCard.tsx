import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  FormField,
  Input,
  Select,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";

type Settings = NonNullable<
  Awaited<ReturnType<(typeof api.api.v1)["tenant-settings"]["get"]>>["data"]
>;
type PriceOverrides = Settings["priceOverrides"];
type Provider = PriceOverrides["overrides"][number]["provider"];

// Brand names, the same in every language, so they are data rather than copy.
const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "openai-compatible", label: "OpenAI-compatible" },
];

type RateKey = "input" | "cachedInput" | "cacheWrite" | "output";
// Held as text while edited, so an emptied optional rate is "not set" rather than zero, and a
// half-typed number is not rewritten under the cursor.
type Row = { key: number; provider: Provider; model: string } & Record<
  RateKey,
  string
>;

const toText = (v: number | undefined) => (v === undefined ? "" : String(v));

function toRows(value: PriceOverrides): Row[] {
  return value.overrides.map((o, i) => ({
    key: i,
    provider: o.provider,
    model: o.model,
    input: toText(o.input),
    cachedInput: toText(o.cachedInput),
    cacheWrite: toText(o.cacheWrite),
    output: toText(o.output),
  }));
}

// A number the server will take, or undefined when the field is empty. Anything else is sent as NaN
// and refused there, with the row it came from, rather than silently dropped here.
function rate(text: string): number | undefined {
  const trimmed = text.trim().replace(",", ".");
  return trimmed === "" ? undefined : Number(trimmed);
}

// THE TENANT'S OWN PRICES (issue #865). The price table is public list prices; a tenant that pays
// something else (a negotiated discount, Azure or Bedrock, its own server) writes what it pays here,
// and every call on that provider and model is priced with it from the next call on. The rows
// already in the ledger keep the price they were written with.
export function PriceOverridesCard({
  value,
  onSaved,
}: {
  value: PriceOverrides;
  onSaved: (next: PriceOverrides) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const [nextKey, setNextKey] = useState(value.overrides.length);
  // While a save is in flight the list is read-only: the answer replaces the draft with what was
  // saved, and an edit made in between would be dropped without a word.
  const [saving, setSaving] = useState(false);

  const RATES: { key: RateKey; label: string; optional: boolean }[] = [
    {
      key: "input",
      label: t("priceOverrides.input", "Input"),
      optional: false,
    },
    {
      key: "cachedInput",
      label: t("priceOverrides.cachedInput", "Cached input"),
      optional: true,
    },
    {
      key: "cacheWrite",
      label: t("priceOverrides.cacheWrite", "Cache write"),
      optional: true,
    },
    {
      key: "output",
      label: t("priceOverrides.output", "Output"),
      optional: false,
    },
  ];

  function update(key: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function add() {
    setRows((rs) => [
      ...rs,
      {
        key: nextKey,
        provider: "openai",
        model: "",
        input: "",
        cachedInput: "",
        cacheWrite: "",
        output: "",
      },
    ]);
    setNextKey((k) => k + 1);
  }

  async function save() {
    setSaving(true);
    try {
      const { data, error: err } = await api.api.v1["tenant-settings"][
        "price-overrides"
      ].put({
        overrides: rows.map((r) => ({
          provider: r.provider,
          model: r.model.trim(),
          input: rate(r.input) ?? Number.NaN,
          output: rate(r.output) ?? Number.NaN,
          ...(rate(r.cachedInput) !== undefined
            ? { cachedInput: rate(r.cachedInput) }
            : {}),
          ...(rate(r.cacheWrite) !== undefined
            ? { cacheWrite: rate(r.cacheWrite) }
            : {}),
        })),
      });
      if (err || !data) throw err ?? new Error("no data");
      onSaved(data.priceOverrides);
      setRows(toRows(data.priceOverrides));
      setNextKey(data.priceOverrides.overrides.length);
      showToast(t("priceOverrides.saved", "Prices saved."), "success");
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("priceOverrides.saveError", "Could not save the prices."),
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4" data-testid="price-overrides">
      <div>
        <h2 className="font-medium text-text-primary">
          {t("priceOverrides.title", "Model prices")}
        </h2>
        <p className="mt-0.5 text-sm text-text-muted">
          {t(
            "priceOverrides.description",
            "The cost the console shows comes from public list prices. If this account pays something else for a model (a negotiated discount, Azure or Bedrock, its own server), write what it pays here, in USD per million tokens. It applies from the next call; calls already made keep their price.",
          )}
        </p>
      </div>
      {rows.length === 0 && (
        <p className="text-sm text-text-muted">
          {t(
            "priceOverrides.empty",
            "No prices of this account's own: every call is priced from the list.",
          )}
        </p>
      )}
      {rows.map((r, i) => (
        <div
          key={r.key}
          className="flex flex-col gap-2 rounded-lg border border-border p-3"
          data-testid="price-override-row"
        >
          <div className="flex flex-wrap items-end gap-2">
            <FormField
              className="min-w-36 flex-1"
              label={t("priceOverrides.provider", "Provider")}
            >
              <Select
                disabled={saving}
                value={r.provider}
                onChange={(e) =>
                  update(r.key, { provider: e.target.value as Provider })
                }
              >
                {PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              className="min-w-48 flex-[2]"
              label={t("priceOverrides.model", "Model")}
            >
              <Input
                disabled={saving}
                value={r.model}
                onChange={(e) => update(r.key, { model: e.target.value })}
                placeholder={t("priceOverrides.modelPlaceholder", "model id")}
              />
            </FormField>
            <Button
              variant="secondary"
              size="sm"
              disabled={saving}
              onClick={() =>
                setRows((rs) => rs.filter((row) => row.key !== r.key))
              }
              aria-label={t("priceOverrides.remove", "Remove row {{n}}", {
                n: i + 1,
              })}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {RATES.map((f) => (
              <FormField
                key={f.key}
                label={
                  f.optional
                    ? t("priceOverrides.optionalRate", "{{label}} (optional)", {
                        label: f.label,
                      })
                    : f.label
                }
              >
                <Input
                  disabled={saving}
                  inputMode="decimal"
                  value={r[f.key]}
                  onChange={(e) => update(r.key, { [f.key]: e.target.value })}
                />
              </FormField>
            ))}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={add} disabled={saving}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("priceOverrides.add", "Add price")}
        </Button>
        <Button onClick={save} loading={saving}>
          {t("priceOverrides.save", "Save prices")}
        </Button>
      </div>
    </Card>
  );
}
