import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Input, Select } from "@/client/components";
import type { ToolTestField } from "./ToolTestModal";
import { fieldTypeLabels } from "./toolFieldTypes";

// The "AI fields" panel and the helpers around it: the typed input schema an HTTP tool and a code
// tool both declare, as the compact field map the runtime reads (graph/tools/http.ts
// parseToolInputSchema). Extracted from ToolEditModal.tsx unchanged so the code tool editor
// (CodeToolEditModal.tsx) renders the SAME rows and writes the SAME shape: two editors of one
// contract would drift on the first field type one of them forgot.
// The types the AI can fill. Scalars serialize cleanly anywhere (query/header/path); enum/array/object
// are body-only (array/object flatten to a string outside JSON). Mirrors the runtime in graph/tools/http.ts.
export const SCALAR_FIELD_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
] as const;
export const AI_FIELD_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "enum",
  "array",
  "object",
] as const;
export type ScalarFieldType = (typeof SCALAR_FIELD_TYPES)[number];
export type AiFieldType = (typeof AI_FIELD_TYPES)[number];

// One declared input the AI fills in (the LLM-facing contract). The placement (URL/query/headers/body)
// references it as {{name}}; the metadata lives here and is edited in the "AI fields" panel.
export type AiFieldRow = {
  _id: string;
  name: string;
  type: AiFieldType;
  required: boolean;
  description: string;
  enumValues: string[];
  itemType: ScalarFieldType;
};

// Stable row keys for the editable lists (React key + no remount glitch on remove). Not serialized.
let rowSeq = 0;
export function rid(): string {
  rowSeq += 1;
  return `r${rowSeq}`;
}

function coerceFieldType(t: unknown): AiFieldType {
  return (AI_FIELD_TYPES as readonly string[]).includes(t as string)
    ? (t as AiFieldType)
    : "string";
}
function coerceScalarType(t: unknown): ScalarFieldType {
  return (SCALAR_FIELD_TYPES as readonly string[]).includes(t as string)
    ? (t as ScalarFieldType)
    : "string";
}

// inputSchema entries that are AI-filled (source !== "fixed") become AiFieldRows; legacy fixed entries
// (source: "fixed" + value) become literal placement rows instead.
export function aiFieldsFromSchema(
  schema: Record<string, unknown>,
): AiFieldRow[] {
  const out: AiFieldRow[] = [];
  for (const [name, raw] of Object.entries(schema ?? {})) {
    const s = (raw ?? {}) as Record<string, unknown>;
    if (s.source === "fixed") continue;
    out.push({
      _id: rid(),
      name,
      type: coerceFieldType(s.type),
      required: s.required === true,
      description: typeof s.description === "string" ? s.description : "",
      enumValues: Array.isArray(s.enumValues)
        ? s.enumValues.filter((v): v is string => typeof v === "string")
        : [],
      itemType: coerceScalarType(s.itemType),
    });
  }
  return out;
}

// The model-facing contract (inputSchema), derived from the AI fields panel only. Fixed values never
// live here — they are literal rows in query/headers/body.
export function schemaFromAiFields(
  rows: AiFieldRow[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const name = r.name.trim();
    if (!name) continue;
    const spec: Record<string, unknown> = { type: r.type };
    if (r.required) spec.required = true;
    if (r.description.trim()) spec.description = r.description.trim();
    if (r.type === "enum") {
      const values = r.enumValues.map((v) => v.trim()).filter(Boolean);
      if (values.length > 0) spec.enumValues = values;
    }
    if (r.type === "array") spec.itemType = r.itemType;
    out[name] = spec;
  }
  return out;
}

// The boxes the test dialog collects, read back off the definition it is about to run. Not built
// from the form rows: `schemaFromAiFields` above writes an OBJECT, so two rows that trim to one name
// collapse to the last, and the dialog rendered both — two controls on one slot, with the losing
// row's `required` or type judging a value the saved definition never declares. Reading the payload
// is what makes "this dialog tests what Save would send" true of the fields too, not only the URL.
export function testFieldsFrom(schema: unknown): ToolTestField[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const out: ToolTestField[] = [];
  for (const [name, raw] of Object.entries(schema as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const spec = raw as Record<string, unknown>;
    // A fixed field is not the model's to supply, and `parseToolInputSchema` leaves it out of the
    // schema the runtime validates against, so it gets no box either.
    if (spec.source === "fixed") continue;
    const type = typeof spec.type === "string" ? spec.type : "string";
    out.push({
      name,
      description: typeof spec.description === "string" ? spec.description : "",
      required: spec.required === true,
      // The declared type travels with the field: the runtime validates the argument against it
      // before the request goes out, so a dialog that only collected text would fail every
      // non-string field on the schema instead of reaching the API.
      type,
      ...(type === "enum" && Array.isArray(spec.enumValues)
        ? {
            enumValues: spec.enumValues.filter(
              (v): v is string => typeof v === "string",
            ),
          }
        : {}),
      ...(type === "array" && typeof spec.itemType === "string"
        ? { itemType: spec.itemType }
        : {}),
    });
  }
  return out;
}

// Editor for an enum field's allowed values (chips). Empty list ⇒ the runtime treats it as a free
// string (z.enum requires at least one value).
function EnumValuesEditor({
  values,
  onChange,
}: {
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1.5">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-2 py-0.5 text-text-secondary text-xs"
          >
            <code className="font-mono">{v}</code>
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              aria-label={t("common.remove", "Remove")}
              className="text-text-muted hover:text-error"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={t("tools.enumValuePlaceholder", "value")}
          className="min-w-0 flex-1"
        />
        <Button type="button" variant="secondary" size="sm" onClick={add}>
          {t("tools.addEnumValue", "Add value")}
        </Button>
      </div>
    </div>
  );
}

// The consolidated "AI fields" panel: one row per declared input the model fills in. Name + type
// (+ enum values / array item type) + description + required. This is the single editing surface for
// the model-facing contract; placement (URL/query/headers/body) only references {{name}}.
export function AiFieldsPanel({
  value,
  onChange,
}: {
  value: AiFieldRow[];
  onChange: (rows: AiFieldRow[]) => void;
}) {
  const { t } = useTranslation();
  const update = (i: number, patch: Partial<AiFieldRow>) =>
    onChange(value.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const typeLabels = fieldTypeLabels(t);
  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 && (
        <p className="text-text-muted text-xs">
          {t("tools.noAiFields", "No AI fields yet.")}
        </p>
      )}
      {value.map((row, i) => (
        <div
          key={row._id}
          className="flex flex-col gap-2 rounded-md border border-border p-2"
        >
          <div className="flex items-center gap-2">
            <Input
              value={row.name}
              onChange={(e) => update(i, { name: e.target.value })}
              placeholder={t("tools.aiFieldName", "field_name")}
              className="min-w-0 flex-1"
            />
            <Select
              value={row.type}
              onChange={(e) =>
                update(i, { type: e.target.value as AiFieldType })
              }
              className="w-36 shrink-0"
            >
              {AI_FIELD_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {typeLabels[ty]}
                </option>
              ))}
            </Select>
            <button
              type="button"
              onClick={() => onChange(value.filter((_, idx) => idx !== i))}
              aria-label={t("common.remove", "Remove")}
              className="shrink-0 rounded p-1.5 text-text-muted hover:text-error"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {row.type === "enum" && (
            <EnumValuesEditor
              values={row.enumValues}
              onChange={(enumValues) => update(i, { enumValues })}
            />
          )}
          {row.type === "array" && (
            <div className="flex items-center gap-2 text-text-secondary text-xs">
              <span>{t("tools.arrayItemType", "Item type")}</span>
              <Select
                aria-label={t("tools.arrayItemType", "Item type")}
                value={row.itemType}
                onChange={(e) =>
                  update(i, { itemType: e.target.value as ScalarFieldType })
                }
                className="w-36"
              >
                {SCALAR_FIELD_TYPES.map((ty) => (
                  <option key={ty} value={ty}>
                    {typeLabels[ty]}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <Input
            value={row.description}
            onChange={(e) => update(i, { description: e.target.value })}
            placeholder={t(
              "tools.aiFieldDesc",
              "What the AI should put here, e.g. 'the order number the customer gave'",
            )}
          />
          <label className="flex w-fit items-center gap-2 text-text-secondary text-xs">
            <input
              type="checkbox"
              checked={row.required}
              onChange={(e) => update(i, { required: e.target.checked })}
            />
            {t("tools.aiFieldRequired", "Required")}
          </label>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() =>
          onChange([
            ...value,
            {
              _id: rid(),
              name: "",
              type: "string",
              required: false,
              description: "",
              enumValues: [],
              itemType: "string",
            },
          ])
        }
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {t("tools.addAiField", "Add field")}
      </Button>
    </div>
  );
}
