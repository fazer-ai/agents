import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { AlertTriangle, Braces, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  CredentialPicker,
  FormField,
  HighlightedTemplateField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  Select,
  Skeleton,
  Switch,
  Textarea,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { Tooltip } from "@/client/components/Tooltip";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";
import { cn } from "@/client/lib/utils";
import { isValidUrlTemplate } from "@/client/lib/validation";
import { normalizeToolName } from "@/graph/tools/toolName";
import { readProviderSlug } from "@/modules/appointments/provider";
import {
  isUsablePath,
  type SampleLeaf,
  sampleLeaves,
} from "@/modules/tool-definitions/appointment";
import {
  CONTEXT_VAR_NAMES,
  normalizeToolShapes,
} from "@/modules/tool-definitions/normalize";

type ToolsData = Awaited<ReturnType<typeof api.api.v1.tools.get>>["data"];
export type Tool = NonNullable<ToolsData>["tools"][number];

// Derived from the vault treaty response; never hand-mirrored (see docs/eden-treaty.md).
type VaultEntry = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.vault.get>>["data"]
>["entries"][number];

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// The types the AI can fill. Scalars serialize cleanly anywhere (query/header/path); enum/array/object
// are body-only (array/object flatten to a string outside JSON). Mirrors the runtime in graph/tools/http.ts.
const SCALAR_FIELD_TYPES = ["string", "integer", "number", "boolean"] as const;
const AI_FIELD_TYPES = [
  "string",
  "integer",
  "number",
  "boolean",
  "enum",
  "array",
  "object",
] as const;
type ScalarFieldType = (typeof SCALAR_FIELD_TYPES)[number];
type AiFieldType = (typeof AI_FIELD_TYPES)[number];

function parseJsonOr(value: string, fallback: Record<string, unknown>) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return JSON.parse(trimmed) as Record<string, unknown>;
}

// One declared input the AI fills in (the LLM-facing contract). The placement (URL/query/headers/body)
// references it as {{name}}; the metadata lives here and is edited in the "AI fields" panel.
type AiFieldRow = {
  _id: string;
  name: string;
  type: AiFieldType;
  required: boolean;
  description: string;
  enumValues: string[];
  itemType: ScalarFieldType;
};
type KvRow = { _id: string; key: string; value: string };

// Stable row keys for the editable lists (React key + no remount glitch on remove). Not serialized.
let rowSeq = 0;
function rid(): string {
  rowSeq += 1;
  return `r${rowSeq}`;
}

// A value that is EXACTLY one {{token}} (no surrounding text). When the token names a declared AI field,
// the runtime keeps the AI value's original type; the editor uses it to badge the row as AI-filled.
const LONE_TOKEN = /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/;
function loneTokenName(value: string): string | null {
  const m = value.match(LONE_TOKEN);
  return m ? (m[1] ?? null) : null;
}

// Non-anchored token pattern matching the runtime (graph/tools/http.ts PLACEHOLDER): {{name}} with an
// alphanumeric/underscore name. Drives the inline {{token}} highlighting in the URL/query/headers/body.
const TOOL_TOKEN_SOURCE = "\\{\\{\\s*([a-zA-Z0-9_]+)\\s*\\}\\}";

// NOTE: context variable names the runtime interpolates (shared with the normalization module so
// the lists cannot drift; keep nativeVarItems in sync). A {{token}} is "known" (highlighted as a
// valid var, not a typo) when it names a declared AI field, one of these, or {{secret}} (only when
// a credential is selected).
const NATIVE_VAR_NAMES = new Set<string>(CONTEXT_VAR_NAMES);
function isKnownToolToken(
  name: string,
  params: string[],
  includeSecret: boolean,
): boolean {
  return (
    params.includes(name) ||
    NATIVE_VAR_NAMES.has(name) ||
    (includeSecret && name === "secret")
  );
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

function objToKv(obj: Record<string, unknown>): KvRow[] {
  return Object.entries(obj ?? {}).map(([key, value]) => ({
    _id: rid(),
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}
function kvToObj(rows: KvRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (key) out[key] = r.value;
  }
  return out;
}

// inputSchema entries that are AI-filled (source !== "fixed") become AiFieldRows; legacy fixed entries
// (source: "fixed" + value) become literal placement rows instead.
function aiFieldsFromSchema(schema: Record<string, unknown>): AiFieldRow[] {
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
function schemaFromAiFields(rows: AiFieldRow[]): Record<string, unknown> {
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

function emptyForm() {
  return {
    label: "",
    description: "",
    method: "POST" as (typeof METHODS)[number],
    urlTemplate: "",
    allowedHosts: "",
    aiFields: [] as AiFieldRow[],
    queryRows: [] as KvRow[],
    headerRows: [] as KvRow[],
    headersMode: "kv" as "kv" | "raw",
    headersRaw: "",
    bodyRows: [] as KvRow[],
    bodyMode: "kv" as "kv" | "raw",
    bodyRaw: "",
    credentialRef: "",
    expectedStatuses: "",
    ackEnabled: false,
    ackMessage: "",
    apptAction: "" as "" | "book" | "cancel",
    apptProvider: "",
    apptIdPath: "",
    apptStartPath: "",
    apptSummaryPath: "",
    apptOffsets: "",
    apptAskConfirm: false,
  };
}

// Maps a stored tool (any of the new or legacy shapes) into the editor form. Legacy tools carry their
// fixed values + body assembly inside inputSchema/body.mode==="fields"; we reconstruct them as explicit
// rows so the operator sees what was previously assembled by magic. Saving then writes the new shape.
// NOTE: exported for the load/save regression tests (pure over its argument).
// Parses the operator's comma/space separated list into the numbers the API takes. Deliberately
// permissive: the server normalizes (dedupes, sorts, drops 2xx and out-of-range values), so a stray
// separator or a repeated entry is not something to reject a save over.
// NOTE: exported for the tests.
export function parseExpectedStatuses(raw: string): number[] {
  return raw
    .split(/[\s,;]+/)
    .map((part) => Number(part))
    .filter((n) => Number.isInteger(n) && n > 0);
}

type ToolForm = ReturnType<typeof emptyForm>;

// The body this modal writes, from the form it renders. ONE function, because it is also what a
// refusal is matched against: `capture` compares the value that was SENT with the value the inputs
// hold NOW, and two spellings of "the payload" would disagree about a field nobody edited.
//
// `null` when the headers are not parseable JSON, which is a client-side check with no server
// sentence behind it.
export function payloadOf(form: ToolForm) {
  let headers: Record<string, unknown>;
  try {
    headers =
      form.headersMode === "raw"
        ? parseJsonOr(form.headersRaw, {})
        : kvToObj(form.headerRows);
  } catch {
    return null;
  }
  const isWrite =
    form.method === "POST" || form.method === "PUT" || form.method === "PATCH";
  return {
    // The model-facing identifier is always derived from the display name (single source of truth).
    name: normalizeToolName(form.label.trim()),
    label: form.label.trim(),
    description: form.description.trim() || undefined,
    method: form.method,
    urlTemplate: form.urlTemplate.trim(),
    allowedHosts: form.allowedHosts
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
    headers,
    // inputSchema is the AI contract only; fixed values live as literal rows in query/headers/body.
    inputSchema: schemaFromAiFields(form.aiFields),
    query: kvToObj(form.queryRows),
    body: isWrite
      ? form.bodyMode === "raw"
        ? { mode: "raw", raw: form.bodyRaw }
        : {
            mode: "kv",
            rows: form.bodyRows
              .filter((r) => r.key.trim())
              .map((r) => ({ key: r.key.trim(), value: r.value })),
          }
      : { mode: "kv", rows: [] },
    credentialRef: form.credentialRef || null,
    expectedStatuses: parseExpectedStatuses(form.expectedStatuses),
    ackEnabled: form.ackEnabled,
    ackMessage: form.ackEnabled ? form.ackMessage.trim() || null : null,
    // What the tool's response says about an appointment, or null when it says nothing (issue #352).
    // Here rather than at the call site: this function is the one place the body is built, and the
    // refusal reader below keys off exactly these fields.
    appointment: appointmentPayload(form),
  };
}

// The server's own names for what this modal renders, which are the keys of the body above. `name`
// is derived from the label rather than typed, so a refusal about it is marked on the label — the
// input the operator can actually change.
const TOOL_FIELDS = [
  "name",
  "label",
  "description",
  "method",
  "urlTemplate",
  "headers",
  "inputSchema",
  "query",
  "credentialRef",
  "expectedStatuses",
] as const;

// The two this modal draws behind a switch. Both stay in the BODY when their control is gone —
// `body` becomes an empty kv bag for a GET, `ackMessage` becomes null — so the server can still
// refuse either by name with nothing on screen to mark.
const TOOL_BODY_FIELDS = ["body"] as const;
const TOOL_ACK_FIELDS = ["ackMessage"] as const;

export function formFromTool(tool: Tool) {
  // NOTE: legacy rows authored programmatically may still carry pre-normalization shapes
  // (JSON-Schema inputSchema, single-brace {var}); render the canonical form so the real AI
  // fields show up.
  const { shapes } = normalizeToolShapes({
    urlTemplate: tool.urlTemplate,
    query: tool.query ?? {},
    headers: tool.headers ?? {},
    body: tool.body ?? {},
    inputSchema: tool.inputSchema ?? {},
  });
  let urlTemplate = (shapes.urlTemplate ?? tool.urlTemplate) as string;
  const schema = (shapes.inputSchema ?? {}) as Record<string, unknown>;
  const bodyCfg = (shapes.body ?? {}) as {
    mode?: string;
    raw?: string;
    rows?: { key?: unknown; value?: unknown }[];
  };
  const aiFields = aiFieldsFromSchema(schema);
  const inUrl = new Set(
    [...urlTemplate.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map(
      (m) => m[1],
    ),
  );
  // NOTE: a legacy fixed field bound to a URL placeholder has no editor row (aiFields skips fixed;
  // the row reconstruction skips URL names), so saving would drop its binding and leave an
  // unresolved {{token}}. Inline the fixed field's value template into the visible URL: the
  // operator sees the effective URL and saving preserves the semantics.
  for (const [name, raw] of Object.entries(schema)) {
    const s = (raw ?? {}) as Record<string, unknown>;
    if (s.source !== "fixed" || !inUrl.has(name)) continue;
    const value = typeof s.value === "string" ? s.value : "";
    urlTemplate = urlTemplate.replace(
      new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, "g"),
      () => value,
    );
  }

  const query = (shapes.query ?? {}) as Record<string, unknown>;
  const queryRows: KvRow[] =
    Object.keys(query).length > 0 ? objToKv(query) : [];

  let bodyMode: "kv" | "raw" = "kv";
  let bodyRaw = "";
  let bodyRows: KvRow[] = [];
  if (bodyCfg.mode === "raw") {
    bodyMode = "raw";
    bodyRaw = typeof bodyCfg.raw === "string" ? bodyCfg.raw : "";
  } else if (bodyCfg.mode === "kv") {
    bodyRows = (bodyCfg.rows ?? []).map((r) => ({
      _id: rid(),
      key: typeof r.key === "string" ? r.key : "",
      value: typeof r.value === "string" ? r.value : "",
    }));
  } else {
    // Legacy "fields"/absent: rebuild the assembled rows. Write methods placed non-path fields in the
    // body; GET/DELETE placed them in the query. AI fields → {{name}}; fixed fields → their literal value.
    const isWrite =
      tool.method === "POST" ||
      tool.method === "PUT" ||
      tool.method === "PATCH";
    for (const [name, raw] of Object.entries(schema)) {
      if (inUrl.has(name)) continue;
      const s = (raw ?? {}) as Record<string, unknown>;
      const value =
        s.source === "fixed"
          ? typeof s.value === "string"
            ? s.value
            : ""
          : `{{${name}}}`;
      (isWrite ? bodyRows : queryRows).push({ _id: rid(), key: name, value });
    }
  }

  return {
    ...emptyForm(),
    label: tool.label,
    description: tool.description ?? "",
    method: tool.method as (typeof METHODS)[number],
    urlTemplate,
    allowedHosts: tool.allowedHosts.join(", "),
    aiFields,
    queryRows,
    headerRows: objToKv((shapes.headers ?? {}) as Record<string, unknown>),
    headersMode: "kv" as const,
    headersRaw: "",
    bodyRows,
    bodyMode,
    bodyRaw,
    credentialRef: tool.credentialRef ?? "",
    expectedStatuses: (tool.expectedStatuses ?? []).join(", "),
    ackEnabled: tool.ackEnabled,
    ackMessage: tool.ackMessage ?? "",
    ...appointmentForm(tool.appointment),
  };
}

// The stored declaration, back into the flat fields the form edits. The server hands back what its
// READER made of the row, so a declaration it would ignore shows here as none — the editor never
// displays a rule the runtime is not following.
function appointmentForm(raw: unknown) {
  const a = (raw ?? {}) as Record<string, unknown>;
  const action = a.action === "book" || a.action === "cancel" ? a.action : "";
  return {
    apptAction: action as "" | "book" | "cancel",
    // The reader always answers with a provider, and the shared default is not worth showing: an
    // operator with one booking system has nothing to disambiguate, and a prefilled "declared" only
    // invites them to change it to something the paired cancel tool will not carry.
    apptProvider:
      typeof a.provider === "string" && a.provider !== "declared"
        ? a.provider
        : "",
    apptIdPath: typeof a.idPath === "string" ? a.idPath : "",
    apptStartPath: typeof a.startPath === "string" ? a.startPath : "",
    apptSummaryPath: typeof a.summaryPath === "string" ? a.summaryPath : "",
    apptOffsets: Array.isArray(a.reminderOffsetsHours)
      ? a.reminderOffsetsHours.join(", ")
      : "",
    apptAskConfirm: a.askConfirmationOnLast === true,
  };
}

// The flat fields back into the declaration the API takes, or null for "this tool has nothing to do
// with appointments" — which is what an empty action means and what every tool means today.
// Pick a path instead of typing one. The form's gates catch a MALFORMED path; nothing catches a
// well-formed path aimed at the wrong key, and that one is silent all the way to production — the
// tool answers, the platform reads nothing, and no appointment is ever recorded. Offering the
// operator's OWN response to click removes the typing, and with it that whole class.
//
// Rendered as a sibling of its FormField, never inside it: FormField wraps its children in a
// <label>, which forwards a click on the field title to the first focusable descendant, so a button
// in there would fire when the operator clicked the title.
function PathPicker({
  leaves,
  open,
  onToggle,
  onPick,
  openLabel,
  closeLabel,
}: {
  leaves: SampleLeaf[];
  open: boolean;
  onToggle: () => void;
  onPick: (path: string) => void;
  openLabel: string;
  closeLabel: string;
}) {
  if (leaves.length === 0) return null;
  return (
    <div className="-mt-2 flex flex-col gap-1">
      <button
        type="button"
        onClick={onToggle}
        className="self-start text-text-secondary text-xs underline underline-offset-2 hover:text-text-primary"
      >
        {open ? closeLabel : openLabel}
      </button>
      {open && (
        <ul className="max-h-48 overflow-y-auto rounded-md border border-border">
          {leaves.map((leaf) => (
            <li key={leaf.path}>
              <button
                type="button"
                onClick={() => onPick(leaf.path)}
                className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-bg-hover"
              >
                <code className="shrink-0 text-text-primary">{leaf.path}</code>
                <span className="truncate text-text-secondary">
                  {leaf.value}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The offsets field, read the ONE way, by the form's gate and by what it submits alike. Null means
// the text names something that would not survive the trip: a token that is not a number, one
// outside the server's own [1, 8760], or more than the five the server keeps. The empty field is an
// ordinary answer, not an error — it is how an operator whose system already reminds says so.
//
// Refusing rather than filtering, because filtering here is INVISIBLE: `24h` and `0` were simply
// dropped, the tool saved, the field went on showing them, and no reminder was ever armed. Same rule
// as the path and provider gates below, and it is the rule the field's own hint already states.
export function readOffsetsField(raw: string): number[] | null {
  const tokens = raw.split(/[,\s]+/).filter((t) => t !== "");
  if (tokens.length === 0) return [];
  if (tokens.length > 5) return null;
  const out: number[] = [];
  for (const token of tokens) {
    const n = Number(token);
    // Fractions pass: the server rounds them (normalizeOffsets), so 2.7 IS honoured, as 3. What
    // cannot be honoured is a value that is not a number at all, or one the clamp would move.
    if (!Number.isFinite(n) || n < 1 || n > 8760) return null;
    out.push(n);
  }
  return out;
}

function appointmentPayload(form: {
  apptAction: "" | "book" | "cancel";
  apptProvider: string;
  apptIdPath: string;
  apptStartPath: string;
  apptSummaryPath: string;
  apptOffsets: string;
  apptAskConfirm: boolean;
}): Record<string, unknown> | null {
  if (!form.apptAction) return null;
  const offsets = readOffsetsField(form.apptOffsets) ?? [];
  const provider = form.apptProvider.trim()
    ? { provider: form.apptProvider.trim() }
    : {};
  if (form.apptAction === "cancel") {
    return { action: "cancel", ...provider, idPath: form.apptIdPath.trim() };
  }
  return {
    action: "book",
    ...provider,
    idPath: form.apptIdPath.trim(),
    startPath: form.apptStartPath.trim(),
    ...(form.apptSummaryPath.trim()
      ? { summaryPath: form.apptSummaryPath.trim() }
      : {}),
    ...(offsets.length > 0
      ? {
          reminderOffsetsHours: offsets,
          askConfirmationOnLast: form.apptAskConfirm,
        }
      : {}),
  };
}

// The native context variables the runtime interpolates into values, headers, the URL and a raw body
// (NEVER the secret). Offered by every value picker, alongside the declared AI fields and {{secret}}.
function nativeVarItems(
  t: ReturnType<typeof useTranslation>["t"],
): { name: string; label: string; description: string }[] {
  return [
    {
      name: "conversation_id",
      label: t("tools.vars.conversationId", "Conversation ID"),
      description: t(
        "tools.vars.conversationIdDesc",
        "Chatwoot conversation id.",
      ),
    },
    {
      name: "message_id",
      label: t("tools.vars.messageId", "Message ID"),
      description: t(
        "tools.vars.messageIdDesc",
        "Chatwoot id of the message that triggered this turn.",
      ),
    },
    {
      name: "contact_id",
      label: t("tools.vars.contactId", "Contact ID"),
      description: t("tools.vars.contactIdDesc", "Chatwoot contact id."),
    },
    {
      name: "contact_name",
      label: t("tools.vars.contactName", "Contact name"),
      description: t(
        "tools.vars.contactNameDesc",
        "The contact's display name.",
      ),
    },
    {
      name: "contact_email",
      label: t("tools.vars.contactEmail", "Contact email"),
      description: t(
        "tools.vars.contactEmailDesc",
        "The contact's email, if known.",
      ),
    },
    {
      name: "contact_phone",
      label: t("tools.vars.contactPhone", "Contact phone"),
      description: t(
        "tools.vars.contactPhoneDesc",
        "The contact's phone, if known.",
      ),
    },
    {
      name: "inbox_id",
      label: t("tools.vars.inboxId", "Inbox ID"),
      description: t("tools.vars.inboxIdDesc", "Chatwoot inbox (channel) id."),
    },
    {
      name: "inbox_name",
      label: t("tools.vars.inboxName", "Inbox name"),
      description: t("tools.vars.inboxNameDesc", "The channel's display name."),
    },
    {
      name: "agent_name",
      label: t("tools.vars.agentName", "Agent name"),
      description: t("tools.vars.agentNameDesc", "This agent's name."),
    },
    {
      name: "company_name",
      label: t("tools.vars.companyName", "Company name"),
      description: t(
        "tools.vars.companyNameDesc",
        "Your workspace/company name.",
      ),
    },
  ];
}

// Inserts `token` at the caret of the given input/textarea (or appends when there's no element),
// then restores focus just past it. Mirrors the prompt editor's insert-variable helper (GeneralTab).
function insertToken(
  el: HTMLInputElement | HTMLTextAreaElement | null,
  current: string,
  token: string,
  setValue: (v: string) => void,
) {
  if (!el) {
    setValue(current + token);
    return;
  }
  const start = el.selectionStart ?? current.length;
  const end = el.selectionEnd ?? current.length;
  setValue(current.slice(0, start) + token + current.slice(end));
  requestAnimationFrame(() => {
    el.focus();
    const pos = start + token.length;
    el.setSelectionRange(pos, pos);
  });
}

// Section header inside the variable picker dropdown. Stronger weight/color than the item descriptions
// plus a top divider (when it follows another section) so the group boundaries read clearly.
function PickerSectionLabel({
  children,
  divider = false,
}: {
  children: ReactNode;
  divider?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn(
        "px-2 pb-1 font-semibold text-[10px] text-text-secondary uppercase tracking-wider",
        {
          "mt-1 border-border border-t pt-2.5": divider,
          "pt-1.5": !divider,
        },
      )}
    >
      {children}
    </DropdownMenuPrimitive.Label>
  );
}

// One selectable variable in the picker: a {{token}} the operator drops into the field at the caret.
function VarItem({
  token,
  label,
  description,
  onInsert,
}: {
  token: string;
  label: string;
  description?: string;
  onInsert: (token: string) => void;
}) {
  return (
    <DropdownMenuPrimitive.Item
      className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary"
      onSelect={() => onInsert(token)}
    >
      <span className="flex items-center gap-2">
        <code className="font-mono text-accent text-xs">{token}</code>
        <span className="truncate">{label}</span>
      </span>
      {description && (
        <span className="text-text-muted text-xs">{description}</span>
      )}
    </DropdownMenuPrimitive.Item>
  );
}

// "Insert variable" picker that drops a {{token}} into the field at the caret. The declared AI fields
// are offered when `params` is passed (the URL/query/headers/body — never an AI field's own metadata);
// the native context variables are always offered; {{secret}} only when a credential is selected.
// `compact` renders an icon-only trigger that sits inline next to the input (vs the labeled button below
// a textarea).
function VariablePicker({
  params,
  includeSecret,
  onInsert,
  compact,
}: {
  params?: string[];
  includeSecret?: boolean;
  onInsert: (token: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const paramList = (params ?? []).filter(Boolean);
  const vars = nativeVarItems(t);
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        {compact ? (
          <button
            type="button"
            aria-label={t("tools.insertVariable", "Insert variable")}
            className="shrink-0 rounded-lg border border-border bg-bg-tertiary p-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary"
          >
            <Braces className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-lg border border-border bg-bg-tertiary px-2 py-1 text-text-secondary text-xs hover:bg-bg-hover hover:text-text-primary"
          >
            <Braces className="h-3.5 w-3.5" aria-hidden="true" />
            {t("tools.insertVariable", "Insert variable")}
          </button>
        )}
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="z-(--z-popover) max-h-72 w-72 overflow-y-auto rounded-lg border border-border bg-bg-secondary p-1 shadow-lg"
        >
          {paramList.length > 0 && (
            <>
              <PickerSectionLabel>
                {t("tools.varsAiFields", "AI fields")}
              </PickerSectionLabel>
              {paramList.map((p) => (
                <VarItem
                  key={p}
                  token={`{{${p}}}`}
                  label={p}
                  onInsert={onInsert}
                />
              ))}
            </>
          )}
          <PickerSectionLabel divider={paramList.length > 0}>
            {t("tools.varsNative", "Context variables")}
          </PickerSectionLabel>
          {vars.map((v) => (
            <VarItem
              key={v.name}
              token={`{{${v.name}}}`}
              label={v.label}
              description={v.description}
              onInsert={onInsert}
            />
          ))}
          {includeSecret && (
            <>
              <PickerSectionLabel divider>
                {t("tools.varsCredential", "Credential")}
              </PickerSectionLabel>
              <VarItem
                token="{{secret}}"
                label={t("tools.varsSecret", "Selected credential")}
                description={t(
                  "tools.varsSecretDesc",
                  "Inserts the credential where auto-injection doesn't reach.",
                )}
                onInsert={onInsert}
              />
            </>
          )}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

// Reusable create/edit modal for an HTTP tool definition. Shared by the Components → Tools panel and
// the agent editor's Tools tab (so a tool can be created/edited without leaving the agent). On edit
// the full tool is fetched by id (the agent editor only knows the id); `onSaved` lets the caller
// refetch + auto-select. `sharedNotice` warns that the edit affects every agent using the tool.
export function ToolEditModal({
  modal,
  onSaved,
  sharedNotice,
}: {
  modal: ModalController<{ id?: string }>;
  onSaved?: (saved: { id: string; name: string }, isNew: boolean) => void;
  sharedNotice?: boolean;
}) {
  const { t } = useTranslation();
  const ackId = useId();
  const apptAskConfirmId = useId();
  const { showToast } = useToast();
  const [form, setForm] = useState(emptyForm());
  // The CURRENT form, readable from inside a request that started before it: the operator can type
  // during the save, and a refusal about a value they have already replaced belongs in the banner
  // rather than under a box that no longer holds it.
  const formRef = useRef(form);
  formRef.current = form;
  // The pasted sample and which field's picker is open. Local, never submitted, never part of the
  // dirty comparison — see sampleParse.
  const [apptSample, setApptSample] = useState("");
  const [apptPicker, setApptPicker] = useState<
    "id" | "start" | "summary" | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [loadingForm, setLoadingForm] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedCredential, setSelectedCredential] =
    useState<VaultEntry | null>(null);
  const baselineRef = useRef<string | null>(null);
  // Targets for the variable picker (cursor insertion into the free-text template fields). Union type
  // because the highlighted field forwards its ref to either an <input> or a <textarea>.
  const urlRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const headersRawRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);

  const editId = modal.payload?.id;
  // Declared AI field names offered by the variable picker in the URL/query/headers/body.
  const aiFieldNames = form.aiFields.map((f) => f.name.trim()).filter(Boolean);
  const isWriteMethod =
    form.method === "POST" || form.method === "PUT" || form.method === "PATCH";

  const refusal = useFieldRefusal(
    modal.isOpen
      ? [
          ...TOOL_FIELDS,
          ...(isWriteMethod ? TOOL_BODY_FIELDS : []),
          ...(form.ackEnabled ? TOOL_ACK_FIELDS : []),
        ]
      : [],
  );
  // What the inputs hold right now, in the server's vocabulary. The marks are keyed by VALUE, so
  // this has to be the same function the save sends. Null only while the headers are unparseable,
  // which is a client-side check the banner already answers.
  const current = payloadOf(form) ?? ({} as Record<string, unknown>);

  useOnModalOpen(modal, () => {
    // The component outlives the dialog, so a mark from the last session is still held here.
    refusal.clear();
    setFormError(null);
    setLoadError(false);
    setSelectedCredential(null);
    // The sample belongs to the tool being edited, so it does not survive into the next one: a
    // response pasted for tool A offering its paths while editing tool B is worse than no offer.
    setApptSample("");
    setApptPicker(null);
    const payloadId = modal.payload?.id;
    if (!payloadId) {
      const initial = emptyForm();
      setForm(initial);
      baselineRef.current = JSON.stringify(initial);
      return;
    }
    // Edit: fetch the full tool by id (the agent editor only carries the id). Baseline is captured
    // once the loaded tool populates the form, so isDirty stays false until the operator edits.
    baselineRef.current = null;
    setLoadingForm(true);
    void (async () => {
      try {
        const { data, error } = await api.api.v1.tools({ id: payloadId }).get();
        if (error || !data) {
          setLoadError(true);
          return;
        }
        const initial = formFromTool(data.tool);
        setForm(initial);
        baselineRef.current = JSON.stringify(initial);
      } catch {
        setLoadError(true);
      } finally {
        setLoadingForm(false);
      }
    })();
  });

  function formatBodyRaw() {
    try {
      const parsed = JSON.parse(form.bodyRaw);
      setForm((f) => ({ ...f, bodyRaw: JSON.stringify(parsed, null, 2) }));
      setFormError(null);
    } catch {
      setFormError(t("tools.invalidBodyJson", "The body must be valid JSON."));
    }
  }

  async function save() {
    setFormError(null);
    const payload = payloadOf(form);
    if (payload === null) {
      setFormError(t("tools.invalidJson", "Headers must be valid JSON."));
      return;
    }
    setSaving(true);
    const fallback = t("tools.saveError", "Could not save.");
    const held = (e: unknown) =>
      refusal.capture(e, fallback, payload, payloadOf(formRef.current) ?? {});
    try {
      const { data, error: err } = editId
        ? await api.api.v1.tools({ id: editId }).patch(payload)
        : await api.api.v1.tools.post(payload);
      if (err || !data) {
        setFormError(held(err));
        return;
      }
      refusal.clear();
      showToast(t("tools.saved", "Tool saved."), "success");
      modal.close();
      onSaved?.({ id: data.tool.id, name: data.tool.name }, !editId);
    } catch (e) {
      setFormError(held(e));
    } finally {
      setSaving(false);
    }
  }

  const credBaseUrl = selectedCredential?.baseUrl ?? null;
  // A relative path (starts with /) is valid only when a credential provides its base.
  const isRelativeTemplate =
    form.urlTemplate.trim().startsWith("/") &&
    !form.urlTemplate.trim().startsWith("//");
  const relativeWithoutBase = isRelativeTemplate && !credBaseUrl;
  const urlTemplateInvalid =
    !relativeWithoutBase && !isValidUrlTemplate(form.urlTemplate);
  // The ack tone example is required when the holding message is enabled: the runtime gate keys off a
  // non-empty ackMessage, so saving it blank would silently turn the feature off.
  // The declaration is read by ONE function, and the server stores nothing it would not follow: a
  // book without a usable id and start path is REFUSED on save, and an unusable provider or summary
  // path is silently dropped. Either way the operator gets a tool that does not do what the form
  // showed them, and the modal's only report is the generic "check the name and URL". So the same
  // reader answers here, per field, before there is anything to save. Same shape as ackInvalid
  // above: a value the runtime will not honour is not a value to save.
  const apptOn = form.apptAction !== "";
  // Deliberately NOT part of `form`: the sample is a filling aid, never a stored field, so pasting
  // one must not mark the modal dirty and must not raise the discard dialog on close.
  const sampleParse = useMemo(() => {
    const raw = apptSample.trim();
    if (raw === "")
      return { state: "empty" as const, leaves: [] as SampleLeaf[] };
    try {
      return { state: "ok" as const, leaves: sampleLeaves(JSON.parse(raw)) };
    } catch {
      return { state: "invalid" as const, leaves: [] as SampleLeaf[] };
    }
  }, [apptSample]);
  const apptIdPathInvalid = apptOn && !isUsablePath(form.apptIdPath.trim());
  const apptStartPathInvalid =
    form.apptAction === "book" && !isUsablePath(form.apptStartPath.trim());
  const apptSummaryPathInvalid =
    form.apptAction === "book" &&
    form.apptSummaryPath.trim() !== "" &&
    !isUsablePath(form.apptSummaryPath.trim());
  const apptProviderInvalid =
    apptOn &&
    form.apptProvider.trim() !== "" &&
    readProviderSlug(form.apptProvider) === null;
  const apptOffsetsInvalid =
    form.apptAction === "book" && readOffsetsField(form.apptOffsets) === null;
  const ackInvalid = form.ackEnabled && !form.ackMessage.trim();
  const valid =
    !loadingForm &&
    !loadError &&
    form.label.trim() &&
    form.urlTemplate.trim() &&
    !relativeWithoutBase &&
    !urlTemplateInvalid &&
    !apptIdPathInvalid &&
    !apptStartPathInvalid &&
    !apptSummaryPathInvalid &&
    !apptProviderInvalid &&
    !apptOffsetsInvalid &&
    !ackInvalid;
  // NOTE: baseline is captured on open (create defaults / loaded tool); null while never opened or
  // while the edit fetch is in flight.
  const isDirty =
    baselineRef.current !== null &&
    JSON.stringify(form) !== baselineRef.current;

  return (
    <Modal
      modal={modal}
      size="lg"
      unsavedChanges={isDirty}
      title={
        editId
          ? t("tools.editTitle", "Edit tool")
          : t("tools.addTitle", "New HTTP tool")
      }
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-error text-xs">{formError}</span>
          <div className="flex gap-2">
            <ModalCancelButton disabled={saving} />
            <Button onClick={save} loading={saving} disabled={!valid}>
              {t("common.save", "Save")}
            </Button>
          </div>
        </div>
      }
    >
      {loadingForm ? (
        <div className="flex flex-col gap-3" role="status">
          <span className="sr-only">{t("common.loading", "Loading…")}</span>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : loadError ? (
        <p className="text-error text-sm">
          {t("tools.loadError", "Could not load this tool.")}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {sharedNotice && editId && (
            <div className="flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-text-primary text-xs">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              <span>
                {t(
                  "tools.sharedNotice",
                  "This is a shared tool definition. Changes affect every agent that uses it.",
                )}
              </span>
            </div>
          )}
          <FormField
            label={t("tools.name", "Display name")}
            required
            description={t(
              "tools.nameHint",
              "How the tool is shown in the console. Spaces and accents are allowed; the identifier the AI calls is derived from it automatically.",
            )}
            error={
              refusal.at("label", current.label) ??
              refusal.at("name", current.name)
            }
          >
            <Input
              value={form.label}
              onChange={(e) =>
                setForm((f) => ({ ...f, label: e.target.value }))
              }
              placeholder={t("tools.namePlaceholder", "Look up order")}
            />
            {form.label.trim() && (
              <p className="mt-1 flex flex-wrap items-center gap-1 text-text-muted text-xs">
                <span>{t("tools.identifierPreview", "Identifier:")}</span>
                <code className="rounded bg-bg-tertiary px-1 py-0.5 font-mono">
                  {normalizeToolName(form.label)}
                </code>
              </p>
            )}
          </FormField>

          <FormField
            label={t("tools.description", "Description")}
            error={refusal.at("description", current.description)}
          >
            <Textarea
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              rows={2}
              placeholder={t(
                "tools.descriptionHint",
                "When the agent should use this and what it does, e.g. 'Look up an order's status by its number.'",
              )}
            />
          </FormField>

          <FormField
            error={refusal.at("inputSchema", current.inputSchema)}
            label={t("tools.aiFields", "AI fields")}
            group
            description={t(
              "tools.aiFieldsHint",
              "The inputs the AI fills in. Give each a clear description, then reference it as {{name}} in the URL, query, headers or body (use Insert variable). Everything else (a constant or a {{context}} value) goes straight into those fields.",
            )}
          >
            <AiFieldsPanel
              value={form.aiFields}
              onChange={(aiFields) => setForm({ ...form, aiFields })}
            />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-[120px_1fr]">
            <FormField
              label={t("tools.method", "Method")}
              error={refusal.at("method", current.method)}
            >
              <Select
                value={form.method}
                onChange={(e) =>
                  setForm({
                    ...form,
                    method: e.target.value as (typeof METHODS)[number],
                  })
                }
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField
              label={t("tools.url", "URL template")}
              required
              description={
                relativeWithoutBase
                  ? t(
                      "tools.relativeRequiresBase",
                      "A relative URL requires a credential with a base URL.",
                    )
                  : credBaseUrl
                    ? t(
                        "tools.relativeHint",
                        "Paths starting with / are resolved against the credential's base. Its host is automatically allowed.",
                      )
                    : undefined
              }
              error={
                urlTemplateInvalid && form.urlTemplate.trim()
                  ? t(
                      "tools.invalidUrlTemplate",
                      "Must start with / or be a full http(s) URL.",
                    )
                  : refusal.at("urlTemplate", current.urlTemplate)
              }
            >
              {credBaseUrl && (
                <Tooltip content={credBaseUrl} side="top">
                  <p className="mb-1 truncate font-mono text-text-muted text-xs">
                    {credBaseUrl}
                  </p>
                </Tooltip>
              )}
              <div className="flex items-center gap-1.5">
                <HighlightedTemplateField
                  ref={urlRef}
                  value={form.urlTemplate}
                  onChange={(v) => setForm({ ...form, urlTemplate: v })}
                  isKnownToken={(n) =>
                    isKnownToolToken(n, aiFieldNames, !!form.credentialRef)
                  }
                  patternSource={TOOL_TOKEN_SOURCE}
                  invalid={relativeWithoutBase}
                  placeholder={
                    credBaseUrl
                      ? "/v1/resource/{{id}}"
                      : "https://api.example.com/orders/{{orderId}}"
                  }
                  className="flex-1"
                  aria-label={t("tools.url", "URL template")}
                />
                <VariablePicker
                  compact
                  params={aiFieldNames}
                  includeSecret={!!form.credentialRef}
                  onInsert={(tok) =>
                    insertToken(urlRef.current, form.urlTemplate, tok, (v) =>
                      setForm({ ...form, urlTemplate: v }),
                    )
                  }
                />
              </div>
            </FormField>
          </div>

          <FormField
            error={refusal.at("credentialRef", current.credentialRef)}
            label={t("tools.credential", "Credential")}
            group
            description={
              selectedCredential?.kind === "header" &&
              selectedCredential.paramName
                ? t(
                    "tools.credentialHintHeader",
                    "Will be injected automatically into the {{name}} header.",
                    { name: selectedCredential.paramName },
                  )
                : selectedCredential?.kind === "query" &&
                    selectedCredential.paramName
                  ? t(
                      "tools.credentialHintQuery",
                      "Will be injected automatically as the {{name}} query parameter.",
                      { name: selectedCredential.paramName },
                    )
                  : t(
                      "tools.credentialHint",
                      "Injected into every request's auth, per the credential's type.",
                    )
            }
          >
            <CredentialPicker
              value={form.credentialRef}
              onChange={(v) => setForm({ ...form, credentialRef: v })}
              onEntryChange={setSelectedCredential}
              ariaLabel={t("tools.credential", "Credential")}
            />
          </FormField>

          <FormField
            error={refusal.at("query", current.query)}
            label={t("tools.query", "Query string")}
            group
            description={t(
              "tools.queryHint",
              "Key/value params added to the URL (any method). Use Insert variable for an AI field, {{context}} or {{secret}}.",
            )}
          >
            <KvEditor
              rows={form.queryRows}
              onChange={(queryRows) => setForm({ ...form, queryRows })}
              params={aiFieldNames}
              aiFields={form.aiFields}
              includeSecret={!!form.credentialRef}
              keyPlaceholder={t("tools.queryKey", "Param")}
              addLabel={t("tools.addQueryParam", "Add param")}
            />
          </FormField>

          <FormField
            error={refusal.at("headers", current.headers)}
            label={t("tools.headers", "Headers")}
            group
            description={
              <button
                type="button"
                className="font-normal text-accent text-xs hover:underline"
                onClick={() =>
                  setForm({
                    ...form,
                    headersMode: form.headersMode === "raw" ? "kv" : "raw",
                  })
                }
              >
                {form.headersMode === "raw"
                  ? t("tools.editAsFields", "Edit as fields")
                  : t("tools.editAsJson", "Edit as JSON")}
              </button>
            }
          >
            {form.headersMode === "raw" ? (
              <>
                <HighlightedTemplateField
                  ref={headersRawRef}
                  value={form.headersRaw}
                  onChange={(v) => setForm({ ...form, headersRaw: v })}
                  isKnownToken={(n) =>
                    isKnownToolToken(n, aiFieldNames, !!form.credentialRef)
                  }
                  patternSource={TOOL_TOKEN_SOURCE}
                  multiline
                  rows={4}
                  textClassName="font-mono text-xs"
                  placeholder={'{ "Content-Type": "application/json" }'}
                  aria-label={t("tools.headers", "Headers")}
                />
                <VariablePicker
                  params={aiFieldNames}
                  includeSecret={!!form.credentialRef}
                  onInsert={(tok) =>
                    insertToken(
                      headersRawRef.current,
                      form.headersRaw,
                      tok,
                      (v) => setForm({ ...form, headersRaw: v }),
                    )
                  }
                />
              </>
            ) : (
              <KvEditor
                rows={form.headerRows}
                onChange={(headerRows) => setForm({ ...form, headerRows })}
                params={aiFieldNames}
                aiFields={form.aiFields}
                includeSecret={!!form.credentialRef}
                keyPlaceholder={t("tools.headerKey", "Header")}
                addLabel={t("tools.addHeader", "Add header")}
              />
            )}
          </FormField>

          {isWriteMethod && (
            <FormField
              error={refusal.at("body", current.body)}
              label={t("tools.body", "Request body")}
              group
              description={
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className="font-normal text-accent text-xs hover:underline"
                    onClick={() =>
                      setForm({
                        ...form,
                        bodyMode: form.bodyMode === "raw" ? "kv" : "raw",
                      })
                    }
                  >
                    {form.bodyMode === "raw"
                      ? t("tools.editAsFields", "Edit as fields")
                      : t("tools.editAsJson", "Edit as JSON")}
                  </button>
                  {form.bodyMode === "raw" && (
                    <button
                      type="button"
                      className="font-normal text-accent text-xs hover:underline"
                      onClick={formatBodyRaw}
                    >
                      {t("tools.formatJson", "Format")}
                    </button>
                  )}
                </div>
              }
            >
              {form.bodyMode === "raw" ? (
                <>
                  <HighlightedTemplateField
                    ref={bodyRef}
                    value={form.bodyRaw}
                    onChange={(v) => setForm({ ...form, bodyRaw: v })}
                    isKnownToken={(n) =>
                      isKnownToolToken(n, aiFieldNames, !!form.credentialRef)
                    }
                    patternSource={TOOL_TOKEN_SOURCE}
                    multiline
                    rows={6}
                    textClassName="font-mono text-xs"
                    placeholder={'{ "id": "{{conversation_id}}" }'}
                    aria-label={t("tools.body", "Request body")}
                  />
                  <VariablePicker
                    params={aiFieldNames}
                    includeSecret={!!form.credentialRef}
                    onInsert={(tok) =>
                      insertToken(bodyRef.current, form.bodyRaw, tok, (v) =>
                        setForm({ ...form, bodyRaw: v }),
                      )
                    }
                  />
                </>
              ) : (
                <KvEditor
                  rows={form.bodyRows}
                  onChange={(bodyRows) => setForm({ ...form, bodyRows })}
                  params={aiFieldNames}
                  aiFields={form.aiFields}
                  includeSecret={!!form.credentialRef}
                  keyPlaceholder={t("tools.bodyKey", "Field")}
                  addLabel={t("tools.addBodyField", "Add field")}
                />
              )}
            </FormField>
          )}

          <FormField
            label={t(
              "tools.expectedStatuses",
              "Statuses that mean 'no result'",
            )}
            description={t(
              "tools.expectedStatusesHint",
              "Comma-separated, e.g. 404. Use it when this API answers with an error status for an ordinary answer — a lookup that returns 404 for 'no record'. Those responses stop counting as integration failures, so they no longer raise alerts. The AI reads the same reply either way. Leave empty and every non-2xx is treated as a failure.",
            )}
            error={refusal.at("expectedStatuses", current.expectedStatuses)}
          >
            <Input
              value={form.expectedStatuses}
              onChange={(e) =>
                setForm({ ...form, expectedStatuses: e.target.value })
              }
              placeholder="404"
            />
          </FormField>

          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <FormField
              label={t(
                "tools.appointment",
                "This tool books or cancels an appointment",
              )}
              description={t(
                "tools.appointmentHint",
                "Tell the platform when this tool's answer is about a commitment, so it can hold follow-ups while the booking stands and remind ahead of it. Say where the booking's id and start time are in the response: dot-separated keys, a number for an array position, e.g. data.items.0.id. The id has to be the same one your cancellation tool answers with.",
              )}
            >
              <Select
                value={form.apptAction}
                onChange={(e) =>
                  setForm({
                    ...form,
                    apptAction: e.target.value as "" | "book" | "cancel",
                  })
                }
              >
                <option value="">
                  {t(
                    "tools.appointmentNone",
                    "Neither — it is not about appointments",
                  )}
                </option>
                <option value="book">
                  {t("tools.appointmentBook", "It books one")}
                </option>
                <option value="cancel">
                  {t("tools.appointmentCancel", "It cancels one")}
                </option>
              </Select>
            </FormField>
            {form.apptAction !== "" && (
              <>
                <FormField
                  label={t(
                    "tools.appointmentSample",
                    "Sample response (optional)",
                  )}
                  description={t(
                    "tools.appointmentSampleHint",
                    "Paste one response from this API and pick the fields below instead of typing their paths. It is not saved and never leaves this screen.",
                  )}
                >
                  <Textarea
                    value={apptSample}
                    onChange={(e) => setApptSample(e.target.value)}
                    rows={3}
                    placeholder='{"data": {"id": "ap_1", "start": "2026-09-02T14:00:00-03:00"}}'
                  />
                </FormField>
                {sampleParse.state === "invalid" && (
                  <p className="-mt-2 text-error text-xs">
                    {t(
                      "tools.appointmentSampleInvalid",
                      "That is not valid JSON, so there is nothing to pick from. The paths below still work if you type them.",
                    )}
                  </p>
                )}
                {sampleParse.state === "ok" &&
                  sampleParse.leaves.length === 0 && (
                    <p className="-mt-2 text-text-secondary text-xs">
                      {t(
                        "tools.appointmentSampleEmpty",
                        "Nothing in this response can be pointed at: a path can only end on a piece of text or a number, and every key along the way has to be made of letters, digits, - or _.",
                      )}
                    </p>
                  )}
                <FormField
                  label={t("tools.appointmentIdPath", "Where the id is")}
                >
                  <Input
                    value={form.apptIdPath}
                    onChange={(e) =>
                      setForm({ ...form, apptIdPath: e.target.value })
                    }
                    placeholder="data.id"
                    error={apptIdPathInvalid}
                    errorMessage={
                      apptIdPathInvalid
                        ? t(
                            "tools.appointmentPathInvalid",
                            "Dot-separated keys, with a number for a list position: data.items.0.id",
                          )
                        : undefined
                    }
                  />
                </FormField>
                <PathPicker
                  leaves={sampleParse.leaves}
                  open={apptPicker === "id"}
                  onToggle={() =>
                    setApptPicker(apptPicker === "id" ? null : "id")
                  }
                  onPick={(path) => {
                    setForm({ ...form, apptIdPath: path });
                    setApptPicker(null);
                  }}
                  openLabel={t("tools.appointmentPick", "Pick from the sample")}
                  closeLabel={t("tools.appointmentPickClose", "Close")}
                />
                <FormField
                  label={t("tools.appointmentProvider", "Booking system")}
                  description={t(
                    "tools.appointmentProviderHint",
                    "Only needed if you have more than one booking system: an id is unique only within the system that issued it. Use the same name on the tool that books and the tool that cancels, or the cancellation will not find the appointment.",
                  )}
                >
                  <Input
                    value={form.apptProvider}
                    onChange={(e) =>
                      setForm({ ...form, apptProvider: e.target.value })
                    }
                    placeholder="feegow"
                    error={apptProviderInvalid}
                    errorMessage={
                      apptProviderInvalid
                        ? t(
                            "tools.appointmentProviderInvalid",
                            'Lowercase letters, digits, - and _ only, and not "google_calendar".',
                          )
                        : undefined
                    }
                  />
                </FormField>
                {form.apptAction === "book" && (
                  <>
                    <FormField
                      label={t(
                        "tools.appointmentStartPath",
                        "Where the start time is",
                      )}
                    >
                      <Input
                        value={form.apptStartPath}
                        onChange={(e) =>
                          setForm({ ...form, apptStartPath: e.target.value })
                        }
                        placeholder="data.start"
                        error={apptStartPathInvalid}
                        errorMessage={
                          apptStartPathInvalid
                            ? t(
                                "tools.appointmentPathInvalid",
                                "Dot-separated keys, with a number for a list position: data.items.0.id",
                              )
                            : undefined
                        }
                      />
                    </FormField>
                    <PathPicker
                      leaves={sampleParse.leaves}
                      open={apptPicker === "start"}
                      onToggle={() =>
                        setApptPicker(apptPicker === "start" ? null : "start")
                      }
                      onPick={(path) => {
                        setForm({ ...form, apptStartPath: path });
                        setApptPicker(null);
                      }}
                      openLabel={t(
                        "tools.appointmentPick",
                        "Pick from the sample",
                      )}
                      closeLabel={t("tools.appointmentPickClose", "Close")}
                    />
                    <FormField
                      label={t(
                        "tools.appointmentSummaryPath",
                        "Where the title is (optional)",
                      )}
                      description={t(
                        "tools.appointmentSummaryPathHint",
                        "Only used to describe the appointment to the AI. Leave empty if the response has no title.",
                      )}
                    >
                      <Input
                        value={form.apptSummaryPath}
                        onChange={(e) =>
                          setForm({ ...form, apptSummaryPath: e.target.value })
                        }
                        placeholder="data.title"
                        error={apptSummaryPathInvalid}
                        errorMessage={
                          apptSummaryPathInvalid
                            ? t(
                                "tools.appointmentPathInvalid",
                                "Dot-separated keys, with a number for a list position: data.items.0.id",
                              )
                            : undefined
                        }
                      />
                    </FormField>
                    <PathPicker
                      leaves={sampleParse.leaves}
                      open={apptPicker === "summary"}
                      onToggle={() =>
                        setApptPicker(
                          apptPicker === "summary" ? null : "summary",
                        )
                      }
                      onPick={(path) => {
                        setForm({ ...form, apptSummaryPath: path });
                        setApptPicker(null);
                      }}
                      openLabel={t(
                        "tools.appointmentPick",
                        "Pick from the sample",
                      )}
                      closeLabel={t("tools.appointmentPickClose", "Close")}
                    />
                    <FormField
                      label={t(
                        "tools.appointmentOffsets",
                        "Remind the customer this many hours before",
                      )}
                      description={t(
                        "tools.appointmentOffsetsHint",
                        "Comma-separated, e.g. 24, 1 (up to five, between 1 and 8760 hours). Leave empty and no reminder is sent — the booking still holds follow-ups and still reaches the AI. Use it only when your own system does not already remind them.",
                      )}
                    >
                      <Input
                        value={form.apptOffsets}
                        onChange={(e) =>
                          setForm({ ...form, apptOffsets: e.target.value })
                        }
                        placeholder="24, 1"
                        error={apptOffsetsInvalid}
                        errorMessage={
                          apptOffsetsInvalid
                            ? t(
                                "tools.appointmentOffsetsInvalid",
                                "Up to five values, each between 1 and 8760 hours.",
                              )
                            : undefined
                        }
                      />
                    </FormField>
                    {form.apptOffsets.trim() !== "" && (
                      <div className="flex items-center justify-between gap-3">
                        <label
                          htmlFor={apptAskConfirmId}
                          data-clickable="true"
                          className="text-sm text-text-primary"
                        >
                          {t(
                            "tools.appointmentAskConfirm",
                            "On the last reminder, ask if they will attend",
                          )}
                        </label>
                        <Switch
                          id={apptAskConfirmId}
                          checked={form.apptAskConfirm}
                          onCheckedChange={(v) =>
                            setForm({ ...form, apptAskConfirm: v })
                          }
                        />
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>

          <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <label
                  htmlFor={ackId}
                  data-clickable="true"
                  className="font-medium text-sm text-text-primary"
                >
                  {t("tools.ack", "Send a holding message")}
                </label>
                <span className="text-text-muted text-xs">
                  {t(
                    "tools.ackHint",
                    "When on, the AI must write a short holding message before this (slow) tool runs — and the tool won't run until it does. The example below only sets the tone; it is never sent as-is.",
                  )}
                </span>
              </div>
              <Switch
                id={ackId}
                checked={form.ackEnabled}
                onCheckedChange={(v) => setForm({ ...form, ackEnabled: v })}
              />
            </div>
            {form.ackEnabled && (
              <div className="flex flex-col gap-1">
                <span className="text-text-muted text-xs">
                  {t(
                    "tools.ackExampleLabel",
                    "Tone example (the AI writes its own message):",
                  )}
                </span>
                <Input
                  value={form.ackMessage}
                  onChange={(e) =>
                    setForm({ ...form, ackMessage: e.target.value })
                  }
                  placeholder={t(
                    "tools.ackPlaceholder",
                    "Let me look into that for you…",
                  )}
                  error={
                    ackInvalid || !!refusal.at("ackMessage", current.ackMessage)
                  }
                  errorMessage={
                    ackInvalid
                      ? t(
                          "tools.ackRequired",
                          "Add a tone example, or turn this off.",
                        )
                      : (refusal.at("ackMessage", current.ackMessage) ??
                        undefined)
                  }
                />
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
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
function AiFieldsPanel({
  value,
  onChange,
}: {
  value: AiFieldRow[];
  onChange: (rows: AiFieldRow[]) => void;
}) {
  const { t } = useTranslation();
  const update = (i: number, patch: Partial<AiFieldRow>) =>
    onChange(value.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const typeLabels: Record<AiFieldType, string> = {
    string: t("tools.typeString", "Text"),
    integer: t("tools.typeInteger", "Integer"),
    number: t("tools.typeNumber", "Number"),
    boolean: t("tools.typeBoolean", "Yes/No"),
    enum: t("tools.typeEnum", "List (enum)"),
    array: t("tools.typeArray", "Array"),
    object: t("tools.typeObject", "JSON object"),
  };
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

// One key/value row (query, headers, body fields). The key and value inputs share width EQUALLY
// (both flex-1); the inline variable picker and the remove control are compact trailing icons, so the
// value is never squeezed by the key. When the value is exactly a declared AI field ({{name}}), a
// small badge below marks the row as AI-filled with its type.
function KvRowItem({
  row,
  onKey,
  onValue,
  onRemove,
  params,
  includeSecret,
  aiFields,
  keyPlaceholder,
}: {
  row: KvRow;
  onKey: (v: string) => void;
  onValue: (v: string) => void;
  onRemove: () => void;
  params: string[];
  includeSecret: boolean;
  aiFields: AiFieldRow[];
  keyPlaceholder: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const loneName = loneTokenName(row.value);
  const aiField = loneName
    ? aiFields.find((f) => f.name.trim() === loneName)
    : undefined;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          value={row.key}
          onChange={(e) => onKey(e.target.value)}
          placeholder={keyPlaceholder}
          wrapperClassName="min-w-0 flex-1"
        />
        <HighlightedTemplateField
          ref={ref}
          value={row.value}
          onChange={onValue}
          isKnownToken={(n) => isKnownToolToken(n, params, includeSecret)}
          patternSource={TOOL_TOKEN_SOURCE}
          placeholder={t("tools.kvValue", "Value")}
          className="flex-1"
          aria-label={t("tools.kvValue", "Value")}
        />
        <VariablePicker
          compact
          params={params}
          includeSecret={includeSecret}
          onInsert={(tok) => insertToken(ref.current, row.value, tok, onValue)}
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("common.remove", "Remove")}
          className="shrink-0 rounded p-1.5 text-text-muted hover:text-error"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {aiField && (
        <span className="pl-1 text-[10px] text-accent">
          {t("tools.aiFilledType", "Filled by AI: {{type}}", {
            type: aiField.type,
          })}
        </span>
      )}
    </div>
  );
}

// Key-value editor (query, headers, body fields). Each row carries its own inline variable picker so
// {{aiField}}/{{context}}/{{secret}} placeholders drop into that row's value at the caret.
function KvEditor({
  rows,
  onChange,
  params,
  includeSecret,
  aiFields,
  keyPlaceholder,
  addLabel,
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  params: string[];
  includeSecret: boolean;
  aiFields: AiFieldRow[];
  keyPlaceholder: string;
  addLabel: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => (
        <KvRowItem
          key={row._id}
          row={row}
          params={params}
          includeSecret={includeSecret}
          aiFields={aiFields}
          keyPlaceholder={keyPlaceholder}
          onKey={(v) =>
            onChange(rows.map((r, idx) => (idx === i ? { ...r, key: v } : r)))
          }
          onValue={(v) =>
            onChange(rows.map((r, idx) => (idx === i ? { ...r, value: v } : r)))
          }
          onRemove={() => onChange(rows.filter((_, idx) => idx !== i))}
        />
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => onChange([...rows, { _id: rid(), key: "", value: "" }])}
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {addLabel}
      </Button>
    </div>
  );
}
