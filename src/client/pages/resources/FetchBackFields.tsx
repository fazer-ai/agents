import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  Select,
  SwitchField,
} from "@/client/components";
import type { FieldRefusal } from "@/client/hooks/useFieldRefusal";
import { FETCH_BACK_STATUSES_MAX } from "@/modules/integrations/fetch-back";

// The generic webhook's consult-back (`config.fetchBack`, read by
// src/modules/integrations/fetch-back.ts): a notification that carries only an id is answered by
// running one of the workspace's HTTP tools with it and mapping the tool's response. Every input writes
// straight into the instance config; the server refuses a shape it cannot use, naming the field.

export interface FetchBackTool {
  id: string;
  label: string;
  name: string;
  enabled: boolean;
  inputSchema: Record<string, unknown>;
}

type Status = { status: string; text?: string; paid?: boolean };
type FetchBack = {
  toolId?: string;
  idFrom?: string;
  idArg?: string;
  conversationRefPath?: string;
  statusPath?: string;
  eventIdPath?: string;
  valuePath?: string;
  currencyPath?: string;
  statuses?: Status[];
};

const PATH_KEYS = [
  "conversationRefPath",
  "statusPath",
  "eventIdPath",
  "valuePath",
  "currencyPath",
] as const;

function readFetchBack(cfg: Record<string, unknown>): FetchBack | null {
  const f = cfg.fetchBack;
  return f && typeof f === "object" && !Array.isArray(f)
    ? (f as FetchBack)
    : null;
}

// Every name a refusal can land on, the per-row ones included, for the form's `useFieldRefusal`.
export function fetchBackFields(cfg: Record<string, unknown>): string[] {
  const f = readFetchBack(cfg);
  if (!f) return [];
  const rows = (f.statuses ?? []).flatMap((_, i) => [
    `config.fetchBack.statuses.${i}.status`,
    `config.fetchBack.statuses.${i}.text`,
  ]);
  return [
    "config.fetchBack.toolId",
    "config.fetchBack.idFrom",
    "config.fetchBack.idArg",
    ...PATH_KEYS.map((k) => `config.fetchBack.${k}`),
    "config.fetchBack.statuses",
    ...rows,
  ];
}

// The refused values, keyed by the names above.
export function fetchBackFieldValues(
  cfg: Record<string, unknown>,
): Record<string, unknown> {
  const f = readFetchBack(cfg);
  if (!f) return {};
  const out: Record<string, unknown> = {
    "config.fetchBack.toolId": f.toolId,
    "config.fetchBack.idFrom": f.idFrom,
    "config.fetchBack.idArg": f.idArg,
    "config.fetchBack.statuses": f.statuses,
  };
  for (const k of PATH_KEYS) out[`config.fetchBack.${k}`] = f[k];
  for (const [i, s] of (f.statuses ?? []).entries()) {
    out[`config.fetchBack.statuses.${i}.status`] = s.status;
    out[`config.fetchBack.statuses.${i}.text`] = s.text;
  }
  return out;
}

// The fields of a tool the model would fill: the only ones the id can travel in.
export function idFieldsOf(tool: FetchBackTool | undefined): string[] {
  if (!tool) return [];
  return Object.entries(tool.inputSchema ?? {})
    .filter(
      ([, v]) =>
        v &&
        typeof v === "object" &&
        (v as Record<string, unknown>).source !== "fixed",
    )
    .map(([k]) => k);
}

// What switching it on starts from: the shape most gateways answer in, for the operator to correct.
const STARTER: FetchBack = {
  idFrom: "query.data.id",
  conversationRefPath: "external_reference",
  statusPath: "status",
  statuses: [{ status: "approved", paid: true, text: "" }],
};

export function FetchBackFields({
  cfg,
  setCfg,
  refusal,
  tools,
}: {
  cfg: Record<string, unknown>;
  setCfg: (patch: Record<string, unknown>) => void;
  refusal: FieldRefusal;
  tools: FetchBackTool[] | null;
}) {
  const { t } = useTranslation();
  const f = readFetchBack(cfg);
  const values = fetchBackFieldValues(cfg);
  const errorAt = (field: string) => refusal.at(field, values[field]);
  // An emptied input removes its key, so what is sent is what the operator wrote.
  const patch = (p: Partial<FetchBack>) => {
    const next: Record<string, unknown> = { ...f, ...p };
    for (const [k, v] of Object.entries(next)) {
      if (v === undefined || v === "") delete next[k];
    }
    setCfg({ fetchBack: next });
  };
  const statuses = f?.statuses ?? [];
  const setStatus = (i: number, p: Partial<Status>) =>
    patch({
      statuses: statuses.map((s, j) => (j === i ? { ...s, ...p } : s)),
    });
  const pathLabel: Record<(typeof PATH_KEYS)[number], string> = {
    conversationRefPath: t(
      "integrations.fetchBack.conversationRefPath",
      "Response field with the reference",
    ),
    statusPath: t(
      "integrations.fetchBack.statusPath",
      "Response field with the status",
    ),
    eventIdPath: t(
      "integrations.fetchBack.eventIdPath",
      "Response field with the event id",
    ),
    valuePath: t(
      "integrations.fetchBack.valuePath",
      "Response field with the amount",
    ),
    currencyPath: t(
      "integrations.fetchBack.currencyPath",
      "Response field with the currency",
    ),
  };
  const tool = tools?.find((x) => x.id === f?.toolId);
  const idFields = idFieldsOf(tool);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <SwitchField
        checked={f !== null}
        onCheckedChange={(on) =>
          setCfg({ fetchBack: on ? { ...STARTER } : undefined })
        }
        label={t(
          "integrations.fetchBack.enabled",
          "Look up each notification with a tool",
        )}
        help={t(
          "integrations.fetchBack.enabledHelp",
          "Some gateways (Mercado Pago, for one) notify with an id and nothing else. With this on, the webhook runs one of your HTTP tools with that id and reads what happened from the tool's response, never from the notification.\n\nThe conversation comes from the reference your charge tool sent with {{ref}}, and only a reference this integration created is accepted.",
          { ref: "{{conversation_ref}}" },
        )}
      />
      {f && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label={t("integrations.fetchBack.tool", "Lookup tool")}
              error={errorAt("config.fetchBack.toolId")}
            >
              <Select
                value={f.toolId ?? ""}
                aria-label={t("integrations.fetchBack.tool", "Lookup tool")}
                onChange={(e) => {
                  const picked = tools?.find((x) => x.id === e.target.value);
                  const fields = idFieldsOf(picked);
                  patch({
                    toolId: e.target.value,
                    idArg:
                      f.idArg && fields.includes(f.idArg) ? f.idArg : fields[0],
                  });
                }}
              >
                <option value="">
                  {tools === null
                    ? t("common.loading", "Loading…")
                    : t("integrations.fetchBack.toolPick", "Choose a tool")}
                </option>
                {(tools ?? []).map((x) => (
                  <option key={x.id} value={x.id} disabled={!x.enabled}>
                    {x.label || x.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label={t("integrations.fetchBack.idArg", "Tool field for the id")}
              error={errorAt("config.fetchBack.idArg")}
            >
              <Select
                value={f.idArg ?? ""}
                aria-label={t(
                  "integrations.fetchBack.idArg",
                  "Tool field for the id",
                )}
                disabled={!idFields.length}
                onChange={(e) => patch({ idArg: e.target.value })}
              >
                {!idFields.length && (
                  <option value="">
                    {t("integrations.fetchBack.idArgNone", "Pick a tool first")}
                  </option>
                )}
                {idFields.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <FormField
            label={t(
              "integrations.fetchBack.idFrom",
              "Where the id comes from",
            )}
            description={t(
              "integrations.fetchBack.idFromHint",
              "query.<name>, header.<name> or body.<path>.",
            )}
            error={errorAt("config.fetchBack.idFrom")}
          >
            <Input
              value={f.idFrom ?? ""}
              placeholder="query.data.id"
              className="font-mono text-xs"
              aria-label={t(
                "integrations.fetchBack.idFrom",
                "Where the id comes from",
              )}
              onChange={(e) => patch({ idFrom: e.target.value })}
            />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            {PATH_KEYS.map((k) => (
              <FormField
                key={k}
                label={pathLabel[k]}
                description={
                  k === "conversationRefPath" || k === "statusPath"
                    ? undefined
                    : t("integrations.fetchBack.optional", "Optional.")
                }
                error={errorAt(`config.fetchBack.${k}`)}
              >
                <Input
                  value={f[k] ?? ""}
                  placeholder={PATH_PLACEHOLDERS[k]}
                  className="font-mono text-xs"
                  aria-label={pathLabel[k]}
                  onChange={(e) => patch({ [k]: e.target.value })}
                />
              </FormField>
            ))}
          </div>
          <FormField
            label={t("integrations.fetchBack.statuses", "Statuses to act on")}
            description={t(
              "integrations.fetchBack.statusesHint",
              "Any other status is ignored. A payment records a sale.",
            )}
            error={errorAt("config.fetchBack.statuses")}
            group
          >
            <div className="flex flex-col gap-2">
              {statuses.map((s, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
                  key={i}
                  className="flex flex-col gap-2 rounded-md border border-border p-2 sm:flex-row sm:items-start"
                >
                  <FormField
                    label={t("integrations.fetchBack.status", "Status")}
                    error={errorAt(`config.fetchBack.statuses.${i}.status`)}
                    className="sm:w-40"
                  >
                    <Input
                      value={s.status ?? ""}
                      placeholder="approved"
                      className="font-mono text-xs"
                      aria-label={`${t("integrations.fetchBack.status", "Status")} ${i + 1}`}
                      onChange={(e) => setStatus(i, { status: e.target.value })}
                    />
                  </FormField>
                  <FormField
                    label={t(
                      "integrations.fetchBack.text",
                      "What the agent is told",
                    )}
                    error={errorAt(`config.fetchBack.statuses.${i}.text`)}
                    className="min-w-0 flex-1"
                  >
                    <Input
                      value={s.text ?? ""}
                      aria-label={`${t("integrations.fetchBack.text", "What the agent is told")} ${i + 1}`}
                      onChange={(e) => setStatus(i, { text: e.target.value })}
                    />
                  </FormField>
                  <SwitchField
                    className="pt-1 sm:pt-7"
                    checked={s.paid === true}
                    label={t("integrations.fetchBack.paid", "Payment")}
                    onCheckedChange={(v) =>
                      setStatus(i, { paid: v || undefined })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="sm:mt-6"
                    aria-label={`${t("common.remove", "Remove")} ${i + 1}`}
                    onClick={() =>
                      patch({ statuses: statuses.filter((_, j) => j !== i) })
                    }
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              ))}
              {statuses.length < FETCH_BACK_STATUSES_MAX && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  onClick={() =>
                    patch({ statuses: [...statuses, { status: "", text: "" }] })
                  }
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t("integrations.fetchBack.addStatus", "Add status")}
                </Button>
              )}
            </div>
          </FormField>
        </>
      )}
    </div>
  );
}

const PATH_PLACEHOLDERS: Record<(typeof PATH_KEYS)[number], string> = {
  conversationRefPath: "external_reference",
  statusPath: "status",
  eventIdPath: "id",
  valuePath: "transaction_amount",
  currencyPath: "currency_id",
};
