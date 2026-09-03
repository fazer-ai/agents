import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { AlertTriangle, Braces, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  CredentialPicker,
  FormField,
  HelpPopover,
  HighlightedTemplateField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  Select,
  Skeleton,
  Switch,
  Textarea,
  useModalController,
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
import { sampleLeaves } from "@/modules/tool-definitions/appointment";
import {
  isUsablePath,
  type SampleLeaf,
  type SampleList,
} from "@/modules/tool-definitions/json-path";
import {
  CONTEXT_VAR_NAMES,
  normalizeToolShapes,
} from "@/modules/tool-definitions/normalize";
import {
  clipToModelLimit,
  enclosingBlock,
  MAX_TEMPLATE_CHARS,
  type ProjectedResponse,
  projectToolResponse,
  readResponseTemplateResult,
  templateItemLeaves,
  templateLeaves,
  templateListAt,
  templateLists,
  templateNeedsBody,
  unmatchedTemplateDelimiter,
  unusableTemplateTokens,
} from "@/modules/tool-definitions/response-template";
import {
  type AiFieldRow,
  AiFieldsPanel,
  aiFieldsFromSchema,
  rid,
  schemaFromAiFields,
  testFieldsFrom,
} from "./AiFieldsPanel";
import { ToolTestModal, type ToolTestTarget } from "./ToolTestModal";

// Kept on this module's surface: the test dialog's boxes are built through it, and
// tests/client/pages/ToolEditModal.test.tsx reads it from here.
export { testFieldsFrom };

type ToolsData = Awaited<ReturnType<typeof api.api.v1.tools.get>>["data"];
export type Tool = NonNullable<ToolsData>["tools"][number];

// Derived from the vault treaty response; never hand-mirrored (see docs/eden-treaty.md).
type VaultEntry = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.vault.get>>["data"]
>["entries"][number];

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function parseJsonOr(value: string, fallback: Record<string, unknown>) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return JSON.parse(trimmed) as Record<string, unknown>;
}

type KvRow = { _id: string; key: string; value: string };

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

// The conversation placeholders a definition actually writes, read off the NORMALIZED shapes rather
// than off what the operator typed, because those are two different texts. An OpenAPI-style
// `{contact_id}` is a supported way to write a placeholder — the whole point of
// `normalizeToolShapes` — and the runtime rewrites it to `{{contact_id}}` before interpolating, at
// write time AND at build time. A scan that knew only the double-brace form found nothing to ask
// for, and the test run then refused for a context value the dialog never offered a box to fill.
// Running the runtime's own normalizer here is what makes the two unable to answer differently, and
// it also reaches the placeholders inside fixed field values, which the hand-listed set of form
// strings it replaced had no entry for.
//
// Exported and pure so that agreement is a test rather than a claim.
// What the model would be handed for the sample on screen. The point of the whole response section:
// a template is a promise about the model's input, and this is the only place an operator can read
// that input before a customer does — which is exactly why it has to follow the runtime's rule and
// not a friendlier one.
//
// `projectResponse` runs on 2xx ALONE, and deliberately: a non-2xx body is the error message the
// model needs to read literally, and a template aimed at success fields would render a block of
// absent markers over it. So a sample captured from a 404 the tool declares a result is previewed
// RAW, clipped the way the runtime clips. Rendering the template there would have contradicted the
// `modelText` the very same test run reported, one dialog away.
//
// `status: null` means the sample was pasted by hand, and reads as 2xx: nobody pastes an error body
// to design a success template against.
//
// Exported and pure so the agreement is a test rather than a claim.
// Whether the server would refuse this template, in the server's own words, or null when it would
// not. Exported and pure so that "the console's gate and the service's refinement are one reader"
// is a test rather than a claim: they are the same function, and the test says so by putting each
// shape through both.
export function templateSaveProblem(template: string): string | null {
  const t = template.trim();
  if (!t) return null;
  const r = readResponseTemplateResult({ mode: "template", template: t });
  return r.declared && !r.ok ? r.problem : null;
}

export function templatePreviewFor(args: {
  template: string;
  sample: string;
  status: number | null;
}): {
  // The runtime's OWN reason, carried rather than collapsed. A boolean here made one sentence cover
  // two causes: a 2xx body that is not JSON was explained as "outside 2xx", with a hand-pasted
  // sample's absent status interpolated as `null`.
  skipped: ProjectedResponse["skipped"];
  text: string;
  missing: string[];
} | null {
  const template = args.template.trim();
  // VERBATIM, not trimmed: on the raw path the runtime clips the body exactly as it arrived, so
  // dropping leading whitespace here slides the 4000-character window and shows tail content the
  // model would never have reached. Trimmed only where the question is "is there a sample at all".
  const sample = args.sample;
  if (!template) return null;
  // A declaration the reader refuses has its own message under the box; previewing it as "the raw
  // body" would answer a question about a template that cannot be saved.
  const decl = readResponseTemplateResult({ mode: "template", template });
  if (!decl.declared || !decl.ok) return null;
  // An empty sample is only "nothing to preview" for a template that reads the body: with neither
  // a token nor a block, the template IS the answer whatever came back, and the case that proves it
  // is a tool answering 204 with no body, where the runtime hands the model the operator's own text
  // and this box was blank.
  if (!sample.trim() && templateNeedsBody(template)) return null;
  // The runtime's decision, made by the runtime's own function. Everything this preview used to
  // decide for itself drifted from it within a round: the 2xx gate, the token-less render, the
  // clip. `status: null` is a hand-pasted sample and reads as 200 — nobody pastes an error body to
  // design a success template against.
  const p = projectToolResponse(
    { mode: "template", template },
    args.status ?? 200,
    sample,
  );
  return p.text === null
    ? {
        skipped: p.skipped,
        text: clipToModelLimit(sample).text,
        missing: [],
      }
    : {
        skipped: null,
        text: clipToModelLimit(p.text).text,
        missing: p.missing,
      };
}

export function contextNamesReferencedBy(
  payload: {
    urlTemplate?: unknown;
    query?: unknown;
    headers?: unknown;
    body?: unknown;
    inputSchema?: unknown;
  } | null,
): string[] {
  const { shapes } = normalizeToolShapes(
    payload
      ? {
          urlTemplate: payload.urlTemplate as string | undefined,
          query: payload.query,
          headers: payload.headers,
          body: payload.body,
          inputSchema: payload.inputSchema,
        }
      : {},
  );
  const found = new Set<string>();
  const scan = (node: unknown): void => {
    if (typeof node !== "string") return;
    for (const m of node.matchAll(new RegExp(TOOL_TOKEN_SOURCE, "g"))) {
      const name = m[1] as string;
      if (NATIVE_VAR_NAMES.has(name)) found.add(name);
    }
  };
  // THE STRINGS THE RUNTIME INTERPOLATES, and only those. This was a generic deep walk, which is
  // one line shorter and asks a different question: it found `{{contact_name}}` inside a field's
  // DESCRIPTION (prose written for the model) and inside a NESTED header or query value, neither of
  // which `buildHttpTool` ever interpolates — `headers[k] = interpolate(String(v), …)` turns a
  // nested object into `[object Object]` on the way out, placeholder and all. The cost of the extra
  // names lands on the operator: a box for a value that will not be used whatever they type in it.
  // The list below pairs site for site with `graph/tools/http.ts`, and the test proves the pairing
  // against the runtime rather than against this comment.
  scan(shapes.urlTemplate);
  for (const bag of [shapes.headers, shapes.query]) {
    if (!bag || typeof bag !== "object" || Array.isArray(bag)) continue;
    // Top level only, and `String(v)` because that is what the runtime does with a non-string.
    for (const v of Object.values(bag)) scan(typeof v === "string" ? v : null);
  }
  const body = shapes.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const bag = body as Record<string, unknown>;
    if (bag.mode === "raw") scan(bag.raw);
    if (bag.mode === "kv" && Array.isArray(bag.rows)) {
      for (const row of bag.rows) {
        if (row && typeof row === "object") {
          scan((row as Record<string, unknown>).value);
        }
      }
    }
  }
  // A legacy FIXED field's value is a template the runtime resolves (`fixedValues`); every other
  // key of a field declaration — type, description, enum — is metadata it never reads as one.
  const schema = shapes.inputSchema;
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    for (const field of Object.values(schema as Record<string, unknown>)) {
      if (field && typeof field === "object" && !Array.isArray(field)) {
        const f = field as Record<string, unknown>;
        if (f.source === "fixed") scan(f.value);
      }
    }
  }
  return [...found];
}
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
    // The response template (issue #456), edited as the plain markdown the operator writes; the
    // {mode, template} envelope is assembled on save. Empty means "hand the model the raw response",
    // which is what every tool did before the feature.
    outputTemplate: "",
    // Whatever else `outputSchema` was carrying, kept verbatim so editing a tool cannot silently
    // delete it. This column has been writable through MCP since it existed, unvalidated and read
    // nowhere, so a row may hold a JSON Schema someone still reads back — and a form that renders
    // nothing for it would send `{}` on the next save.
    outputSchemaOther: null as Record<string, unknown> | null,
    outputSchemaProblem: null as string | null,
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
    // A written template wins; an empty field falls back to whatever else the column held, which is
    // how a legacy JSON Schema survives an edit that never showed it.
    outputSchema: form.outputTemplate.trim()
      ? { mode: "template", template: form.outputTemplate.trim() }
      : (form.outputSchemaOther ?? {}),
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
  "outputSchema",
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
    ...outputSchemaForm(tool.outputSchema),
    ...appointmentForm(tool.appointment),
  };
}

// The stored `outputSchema`, split into the part this form edits and the part it must not lose. The
// same reader the runtime uses decides which is which, so a declaration the runtime would ignore
// shows here as no template rather than as text in a box that does nothing.
//
// THREE OUTCOMES, not two, and the third is a lockout. `mode:"template"` with a template the reader
// refuses (`{mode:"template", template:42}`, which MCP could store before this feature validated
// the column) used to fall through to "keep it verbatim": the editor showed an empty box, resent
// the broken object on every save, and the service refinement — new in this same change — rejected
// it. The operator could then not edit the tool's URL, its headers, anything, and nothing on screen
// said why. `outputSchemaOther` is for a legacy schema that is NOT a template declaration (a real
// JSON Schema, which must survive an edit that never showed it); a declaration that IS one and is
// broken is dropped, and `outputSchemaProblem` carries the reader's own sentence so the operator
// reads what was discarded rather than discovering it.
export function outputSchemaForm(raw: unknown) {
  const read = readResponseTemplateResult(raw);
  const isBag = !!raw && typeof raw === "object" && !Array.isArray(raw);
  if (read.declared) {
    return {
      outputTemplate: read.ok ? read.template : "",
      outputSchemaOther: null as Record<string, unknown> | null,
      outputSchemaProblem: read.ok ? null : read.problem,
    };
  }
  return {
    outputTemplate: "",
    outputSchemaOther: isBag ? (raw as Record<string, unknown>) : null,
    outputSchemaProblem: null as string | null,
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
//
// The template's picker also offers the LISTS in the sample (#459), each inserted as a block to
// repeat over, and it is caret-aware: with the caret inside a block it offers the fields of that
// list's items instead, relative, under a heading that says so. Both are the same `leaves` shape
// to this component; what differs is what `onPick` inserts, and the caller decides that.
//
// The toggle is what lets the operator move the caret and ask again, so it must not disappear on an
// offer that is empty for THIS caret: with `emptyLabel` set, an empty offer renders the toggle and
// that line instead of nothing (round 3 of review: inside a block over an empty list the whole
// control unmounted while open, and nothing could re-read the caret).
export function PathPicker({
  leaves,
  lists = [],
  heading,
  emptyLabel,
  open,
  onToggle,
  onPick,
  onPickList,
  openLabel,
  closeLabel,
  listsLabel,
  listLength,
}: {
  leaves: SampleLeaf[];
  lists?: SampleList[];
  // Shown above the offers when they are relative to something (the items of a block).
  heading?: string | null;
  // Shown instead of nothing when the offer is empty; without it an empty offer hides the control.
  emptyLabel?: string;
  open: boolean;
  onToggle: () => void;
  onPick: (path: string) => void;
  onPickList?: (path: string) => void;
  openLabel: string;
  closeLabel: string;
  listsLabel?: string;
  listLength?: (n: number) => string;
}) {
  const empty = leaves.length === 0 && lists.length === 0;
  if (empty && !emptyLabel) return null;
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
          {heading && (
            <li className="px-2 py-1 text-text-secondary text-xs">{heading}</li>
          )}
          {empty && (
            <li className="px-2 py-1 text-text-secondary text-xs">
              {emptyLabel}
            </li>
          )}
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
          {lists.length > 0 && listsLabel && (
            <li className="border-border border-t px-2 py-1 text-text-secondary text-xs">
              {listsLabel}
            </li>
          )}
          {lists.map((list) => (
            <li key={`each:${list.path}`}>
              <button
                type="button"
                onClick={() => onPickList?.(list.path)}
                className="flex w-full items-baseline gap-2 px-2 py-1 text-left text-xs hover:bg-bg-hover"
              >
                <code className="shrink-0 text-text-primary">{list.path}</code>
                <span className="truncate text-text-secondary">
                  {listLength ? listLength(list.length) : list.length}
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
  setValue(spliceSelection(current, start, end, () => token));
  requestAnimationFrame(() => {
    el.focus();
    const pos = start + token.length;
    el.setSelectionRange(pos, pos);
  });
}

// The one cut both inserts make: a selection is a boundary the browser chose, never the inside of
// a surrogate pair, which is why `tests/lib/astral-cap-sweep.test.ts` lists this file under
// "index". `insert` sees what is on either side, so an insert that wants a line of its own can
// decide whether it needs a line break first.
function spliceSelection(
  current: string,
  start: number,
  end: number,
  insert: (before: string, after: string) => string,
): string {
  const before = current.slice(0, start);
  const after = current.slice(end);
  return before + insert(before, after) + after;
}

// Inserts a `{{#each path}}` block at the caret, markers on lines of their own (so each takes its
// line with it when rendered), and leaves the caret on the empty line BETWEEN them: reopening the
// picker from there offers the items' fields. A caret mid-line gets a line break first, so the
// opening marker lands standalone; the same for the text after it.
export function insertEachBlock(
  el: HTMLTextAreaElement | null,
  current: string,
  path: string,
  setValue: (v: string) => void,
): void {
  const start = el?.selectionStart ?? current.length;
  const end = el?.selectionEnd ?? current.length;
  let openLength = 0;
  setValue(
    spliceSelection(current, start, end, (before, after) => {
      const lead = before === "" || before.endsWith("\n") ? "" : "\n";
      const tail = after === "" || after.startsWith("\n") ? "" : "\n";
      const open = `${lead}{{#each ${path}}}\n`;
      openLength = open.length;
      return `${open}\n{{/each}}${tail}`;
    }),
  );
  if (!el) return;
  requestAnimationFrame(() => {
    el.focus();
    const pos = start + openLength;
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
  // The pasted (or tested) sample response and which field's picker is open. ONE sample for the whole
  // screen: the response template and the appointment declaration point into the same body, and
  // asking for it twice is the kind of duplication an operator reads as two different questions.
  // Local, never submitted, never part of the dirty comparison — see sampleParse.
  const [sample, setSample] = useState("");
  // The STATUS the sample came back under, or null when it was pasted by hand. It exists because the
  // runtime projects on 2xx alone: a sample captured from a 404 the tool declares a result would be
  // handed to the model RAW, and a preview that rendered the template over it would promise
  // something the runtime never does — under a label that says "exactly what the agent would
  // receive". Null reads as 2xx, which is the right assumption for a hand-pasted body: nobody
  // pastes an error response to design a success template against.
  const [sampleStatus, setSampleStatus] = useState<number | null>(null);
  const [apptPicker, setApptPicker] = useState<
    "id" | "start" | "summary" | null
  >(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  // Where the caret was when the picker was opened. Read THEN and not on every keystroke: the
  // offer only has to be right for the click that follows it, and clicking the picker's button
  // moves focus off the textarea without moving its selection.
  const [templateCaret, setTemplateCaret] = useState(0);
  const templateRef = useRef<HTMLTextAreaElement>(null);
  const testModal = useModalController<ToolTestTarget>();
  const [saving, setSaving] = useState(false);
  const [loadingForm, setLoadingForm] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectedCredential, setSelectedCredential] =
    useState<VaultEntry | null>(null);
  const baselineRef = useRef<string | null>(null);
  // Identity of the current opening (see the open handler).
  const sessionRef = useRef<object | null>(null);
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
  // A test run has no conversation, so these are the values nobody can supply but the operator —
  // and offering the whole catalog would ask them to fill ten boxes for a tool that references one.
  const referencedContextNames = useMemo(
    // Null only when the headers are unparseable, and `openTest` refuses on that before this list
    // is ever read.
    () => contextNamesReferencedBy(payloadOf(form)),
    [form],
  );

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
    setSample("");
    setSampleStatus(null);
    setApptPicker(null);
    setTemplatePickerOpen(false);
    const payloadId = modal.payload?.id;
    // This opening, told apart from the next one: the GET below outlives the dialog it was started
    // for, so an answer that arrives after a close-and-reopen would fill the NEW session's form
    // with the old tool and let Save patch the new id with it. Same guard in CodeToolEditModal.
    const session = {};
    sessionRef.current = session;
    const mine = () => sessionRef.current === session;
    if (payloadId) {
      // Edit: fetch the full tool by id (the agent editor only carries the id). Baseline is captured
      // once the loaded tool populates the form, so isDirty stays false until the operator edits.
      baselineRef.current = null;
      setLoadingForm(true);
      void (async () => {
        try {
          const { data, error } = await api.api.v1
            .tools({ id: payloadId })
            .get();
          if (!mine()) return;
          if (error || !data) {
            setLoadError(true);
            return;
          }
          const initial = formFromTool(data.tool);
          setForm(initial);
          baselineRef.current = JSON.stringify(initial);
        } catch {
          if (mine()) setLoadError(true);
        } finally {
          if (mine()) setLoadingForm(false);
        }
      })();
    } else {
      // Reset here too: the session token now drops the previous opening's answer, and that answer
      // is what used to clear this flag on its way out — leaving the create form skeletonized
      // forever if it never arrived. Every state this handler sets belongs to THIS opening.
      setLoadingForm(false);
      const initial = emptyForm();
      setForm(initial);
      baselineRef.current = JSON.stringify(initial);
    }
    // ONE hook per dialog, and the early return that used to sit above is gone for that reason: the
    // per-session reset and the child dialog's teardown both belong to this opening, and a second
    // `useOnModalOpen(modal, …)` beside it is a second reset site that has to repeat every clear the
    // first one does (`tests/client/field-refusal-fence.test.ts` says so, and it caught this).
    //
    // The test dialog belongs to the tool session that opened it, so closing the editor takes it
    // with it — otherwise it lingers describing a definition that is no longer on screen
    // (`docs/modals.md`, "parent close invalidates nested state").
    return () => {
      sessionRef.current = null;
      testModal.close();
    };
  });

  // NAMED rather than inline, and the reason is a fence: the toast scanner
  // (`tests/client/error-toast-reason.test.ts`) abstains on a handler it cannot name, and an
  // anonymous one then has to be waived by hand. The fixed sentence here is legitimate — the
  // headers are unparseable on the CLIENT, with no server call behind it to have worded anything.
  function openTest() {
    const payload = payloadOf(form);
    if (!payload) {
      setFormError(t("tools.invalidJson", "Headers must be valid JSON."));
      return;
    }
    testModal.open({
      definition: payload as unknown as Record<string, unknown>,
      aiFields: testFieldsFrom(
        (payload as Record<string, unknown>).inputSchema,
      ),
      contextNames: referencedContextNames,
    });
  }

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
    // The opening this save belongs to. A slow save can still be dismissed (Esc, outside, X — only
    // Cancel is disabled while saving), and the continuation below would then close the dialog the
    // operator reopened and write this tool's state into it (docs/modals.md).
    const session = sessionRef.current;
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
        if (sessionRef.current === session) setFormError(held(err));
        return;
      }
      // Dismissed and reopened while this was out: the row was written, and it is the CALLER's list
      // that has to hear about it, not the dialog now on screen.
      if (sessionRef.current !== session) {
        onSaved?.({ id: data.tool.id, name: data.tool.name }, !editId);
        return;
      }
      refusal.clear();
      showToast(t("tools.saved", "Tool saved."), "success");
      modal.close();
      onSaved?.({ id: data.tool.id, name: data.tool.name }, !editId);
    } catch (e) {
      // Same rule as the branch above: a transport failure of a save whose dialog is gone has
      // nowhere to land, and would mark the form the operator has open now.
      if (sessionRef.current === session) setFormError(held(e));
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
    const raw = sample.trim();
    const none = {
      leaves: [] as SampleLeaf[],
      templates: [] as SampleLeaf[],
      lists: [] as SampleList[],
      body: undefined as unknown,
    };
    if (raw === "") return { state: "empty" as const, ...none };
    try {
      const body: unknown = JSON.parse(raw);
      // TWO offers from one sample, because the two readers accept different things: an appointment
      // id may not be a boolean or the empty string, and a template that could not render
      // `"active": false` would show the model a blank where the API said no. Each picker offers
      // exactly what its own reader takes. The lists are the template's third offer: what a block
      // may repeat over.
      return {
        state: "ok" as const,
        leaves: sampleLeaves(body),
        templates: templateLeaves(body),
        lists: templateLists(body),
        body,
      };
    } catch {
      return { state: "invalid" as const, ...none };
    }
  }, [sample]);
  // What the template picker offers for the caret it was opened at: outside every block, the
  // absolute fields and the lists; inside one, the fields of that list's items, relative. The
  // block is read leniently (`enclosingBlock`), because at the moment the operator most wants the
  // item fields, just after typing or inserting `{{#each xs}}`, the block is not closed yet.
  const templateOffer = useMemo(() => {
    const block = enclosingBlock(form.outputTemplate, templateCaret);
    if (block === null) {
      return {
        block: null,
        leaves: sampleParse.templates,
        lists: sampleParse.lists,
      };
    }
    const items = templateListAt(sampleParse.body, block);
    return {
      block,
      leaves: items === null ? [] : templateItemLeaves(items),
      lists: [] as SampleList[],
    };
  }, [form.outputTemplate, templateCaret, sampleParse]);
  // What the model would be handed, rendered against the pasted sample. The point of the whole
  // section: a template is a promise about the model's input, and this is the only place the
  // operator can read that input before a customer does.
  const templatePreview = useMemo(
    () =>
      templatePreviewFor({
        template: form.outputTemplate,
        sample,
        status: sampleStatus,
      }),
    [form.outputTemplate, sample, sampleStatus],
  );
  const badTemplateTokens = unusableTemplateTokens(form.outputTemplate);
  // A `{{` or `}}` that is not part of a token: `{{a}` is not an unusable token, it is not a token,
  // so the scan above sees nothing and the runtime would put the typo in front of the model
  // verbatim. Same gate, because it is the same defect.
  const strayTemplateDelimiter = unmatchedTemplateDelimiter(
    form.outputTemplate,
  );
  // AND THE GATE IS THE READER'S, not the sum of the two checks above. Those name the two problems
  // this screen can phrase well; the reader refuses more than they see — a template past
  // MAX_TEMPLATE_CHARS, a NUL or a lone surrogate the jsonb column cannot store — and it is the
  // same function the service refines with. Gating on the pair left Save enabled on a payload the
  // server was always going to reject, with nothing inline saying why.
  const templateDeclProblem = useMemo(
    () => templateSaveProblem(form.outputTemplate),
    [form.outputTemplate],
  );
  const templateTooLong =
    form.outputTemplate.trim().length > MAX_TEMPLATE_CHARS;
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
    templateDeclProblem === null &&
    !ackInvalid;
  // NOTE: baseline is captured on open (create defaults / loaded tool); null while never opened or
  // while the edit fetch is in flight.
  const isDirty =
    baselineRef.current !== null &&
    JSON.stringify(form) !== baselineRef.current;

  return (
    <>
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
                "Describe each AI input and insert {{name}} where it goes; put constants and {{context}} directly in the field.",
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
                // The children are a highlighted field PLUS a variable picker, which is what `group`
                // is for: there is no single control for the label to name. It was missing, and the
                // wrapping label used to paper over it by forwarding a click to the first labelable
                // descendant; now that the label points, a dangling `htmlFor` is a visible failure.
                group
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
              help={t(
                "tools.expectedStatusesHelp",
                'These codes identify ordinary responses that arrive with an error status, such as 404 for "not found."\n\nAdding them stops those responses from counting as failures or raising alerts. The AI receives the same response either way.\n\nIf the field is empty, every status outside 200 to 299 counts as a failure.',
              )}
              // INLINE, because a format example is what no state can reveal (docs/ui.md), and here
              // the cost of not saying it is silence: `parseExpectedStatuses` splits on comma, space
              // or semicolon and drops whatever is not a positive integer, so `404/410` yields an
              // EMPTY list, no refusal, and a tool that goes on treating both as failures. The
              // placeholder shows one code and says nothing about how to write two.
              description={t(
                "tools.expectedStatusesHint",
                "Comma-separated, e.g. 404, 410.",
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
              <p className="font-semibold text-text-primary text-xs uppercase tracking-wider">
                {t("tools.responseSection", "The response")}
              </p>
              <FormField
                label={t("tools.sample", "Sample response (optional)")}
                description={t(
                  "tools.sampleHint",
                  "One response from this API, so you can pick fields instead of typing their paths. It is not saved and never leaves this screen.",
                )}
              >
                <Textarea
                  value={sample}
                  onChange={(e) => {
                    setSample(e.target.value);
                    // Typed or pasted by hand: there is no status behind it any more, and keeping
                    // the last run's would judge this body by that one's.
                    setSampleStatus(null);
                  }}
                  rows={3}
                  placeholder='{"data": {"id": "ap_1", "start": "2026-09-02T14:00:00-03:00"}}'
                />
              </FormField>
              <div className="-mt-2 flex flex-col gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  className="self-start"
                  // Same gate Save carries, and for a sharper reason: the server refuses a
                  // declared template it would not honour, so leaving this enabled spends a REAL
                  // request against the provider to come back with a 400 the box above already
                  // knows about.
                  disabled={
                    !form.urlTemplate.trim() ||
                    urlTemplateInvalid ||
                    // Deliberately separate from `urlTemplateInvalid`, which is false for a
                    // relative template on purpose. `buildHttpTool` refuses that shape before a
                    // request goes out, so without this the button spends a real round trip to be
                    // told what the form already knows — and Save has always known it.
                    relativeWithoutBase ||
                    templateDeclProblem !== null
                  }
                  onClick={openTest}
                >
                  {t("tools.testOpen", "Send a test request")}
                </Button>
                <span className="text-text-secondary text-xs">
                  {t(
                    "tools.testOpenHint",
                    "Runs this tool once against the real API and fills the sample above with the answer.",
                  )}
                </span>
              </div>
              {sampleParse.state === "invalid" && (
                <p className="-mt-2 text-error text-xs">
                  {t(
                    "tools.sampleInvalid",
                    "That is not valid JSON, so there is nothing to pick from. The fields below still work if you type the paths.",
                  )}
                </p>
              )}
              <FormField
                label={t("tools.outputTemplate", "What the agent receives")}
                help={t(
                  "tools.outputTemplateHelp",
                  "By default the agent gets the whole response, cut off at 4000 characters — so a long answer loses its end, and an agent that cannot see a field tends to make one up.\n\nWrite the few lines you actually want instead. {{campo}} is replaced with that field from the response; a field the API does not return shows as (not returned) rather than a blank. Leave it empty to keep the whole response.\n\nFor a list of results, wrap one line in {{#each results}} … {{/each}}: it repeats per item, the fields inside are the item's own, and {{.}} is the item itself when the list holds plain values. At most 50 items are shown; the rest is counted.",
                )}
                description={t(
                  "tools.outputTemplateHint",
                  "Markdown, with {{path.to.field}} for each value and {{#each list}}…{{/each}} around what repeats per item. A number picks a list position: data.items.0.name",
                )}
                error={refusal.at("outputSchema", current.outputSchema)}
              >
                <Textarea
                  ref={templateRef}
                  value={form.outputTemplate}
                  onChange={(e) =>
                    setForm({ ...form, outputTemplate: e.target.value })
                  }
                  rows={4}
                  placeholder={
                    "**{{razao_social}}** — {{municipio}}\nSituação: {{descricao_situacao_cadastral}}"
                  }
                  error={templateDeclProblem !== null}
                  errorMessage={
                    badTemplateTokens.length > 0
                      ? t(
                          "tools.outputTemplateBadTokens",
                          "These are not paths into the response: {{tokens}}. A path is dot-separated keys, with a number for a list position: data.items.0.name",
                          {
                            tokens: badTemplateTokens
                              .map((tok) => `{{${tok}}}`)
                              .join(", "),
                          },
                        )
                      : strayTemplateDelimiter !== null
                        ? t(
                            "tools.outputTemplateStrayBrace",
                            'There is an unmatched brace near "{{stray}}". A field takes two braces on each side, and a stray one would reach the agent as literal text.',
                            { stray: strayTemplateDelimiter },
                          )
                        : templateTooLong
                          ? t(
                              "tools.outputTemplateTooLong",
                              "This is {{length}} characters and the limit is {{max}}. It is sent to the agent on every call of this tool.",
                              {
                                length: form.outputTemplate.trim().length,
                                max: MAX_TEMPLATE_CHARS,
                              },
                            )
                          : // Whatever else the reader refused — an unstorable character, say. Its
                            // own sentence names the offending code point, which is the part that
                            // makes it fixable.
                            (templateDeclProblem ?? undefined)
                  }
                />
              </FormField>
              <PathPicker
                leaves={templateOffer.leaves}
                lists={templateOffer.lists}
                heading={
                  templateOffer.block === null
                    ? null
                    : t(
                        "tools.outputTemplatePickInside",
                        "Fields of each item in {{path}}",
                        { path: templateOffer.block },
                      )
                }
                emptyLabel={
                  // Only while the sample offers SOMETHING: with no sample there is nothing to
                  // move the caret towards, and the control stays hidden as before.
                  sampleParse.templates.length + sampleParse.lists.length > 0
                    ? t(
                        "tools.outputTemplatePickNone",
                        "Nothing to pick here: {{path}} is not a list in the sample, or its items have no fields. Move the cursor and open this again.",
                        { path: templateOffer.block ?? "" },
                      )
                    : undefined
                }
                open={templatePickerOpen}
                onToggle={() => {
                  if (!templatePickerOpen) {
                    setTemplateCaret(
                      templateRef.current?.selectionStart ??
                        form.outputTemplate.length,
                    );
                  }
                  setTemplatePickerOpen(!templatePickerOpen);
                }}
                onPick={(path) => {
                  // INSERTS at the cursor rather than replacing the field: this box holds a whole
                  // block of text, unlike the single-path fields below it.
                  insertToken(
                    templateRef.current,
                    form.outputTemplate,
                    `{{${path}}}`,
                    (v) => setForm((f) => ({ ...f, outputTemplate: v })),
                  );
                  setTemplatePickerOpen(false);
                }}
                onPickList={(path) => {
                  insertEachBlock(
                    templateRef.current,
                    form.outputTemplate,
                    path,
                    (v) => setForm((f) => ({ ...f, outputTemplate: v })),
                  );
                  setTemplatePickerOpen(false);
                }}
                openLabel={t("tools.outputTemplatePick", "Insert a field")}
                closeLabel={t("tools.appointmentPickClose", "Close")}
                listsLabel={t(
                  "tools.outputTemplatePickLists",
                  "Lists: insert a block that repeats per item",
                )}
                listLength={(n) =>
                  t("tools.outputTemplateListLength", "{{count}} items", {
                    count: n,
                  })
                }
              />
              {templatePreview && (
                <FormField
                  group
                  label={t("tools.outputTemplatePreview", "Preview")}
                  description={t(
                    "tools.outputTemplatePreviewHint",
                    "Exactly what the agent would receive for the sample above.",
                  )}
                >
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-tertiary p-2 text-text-primary text-xs">
                    {templatePreview.text}
                  </pre>
                </FormField>
              )}
              {form.outputSchemaProblem && (
                <p className="-mt-2 text-warning text-xs">
                  {t(
                    "tools.outputTemplateDropped",
                    "This tool had a response template stored that could not be read, so it was not applied and is not shown: {{problem}}. Saving replaces it with whatever is in the box above.",
                    { problem: form.outputSchemaProblem },
                  )}
                </p>
              )}
              {templatePreview?.skipped === "not-2xx" && (
                <p className="-mt-2 text-warning text-xs">
                  {t(
                    "tools.outputTemplateNotApplied",
                    "This sample came back as HTTP {{status}}, and the template only applies to a successful response. Outside 2xx the agent reads the body as it came, so it can read the error.",
                    { status: sampleStatus },
                  )}
                </p>
              )}
              {templatePreview?.skipped === "not-json" && (
                <p className="-mt-2 text-warning text-xs">
                  {t(
                    "tools.outputTemplateNotJson",
                    "This sample is not JSON, so there is nothing for the fields to point at and the agent reads the body as it came. The call still succeeded — only the template does not apply to it.",
                  )}
                </p>
              )}
              {templatePreview && templatePreview.missing.length > 0 && (
                <p className="-mt-2 text-warning text-xs">
                  {t(
                    "tools.outputTemplateMissing",
                    "Not in the sample response: {{paths}}. The agent would see (not returned) there.",
                    { paths: templatePreview.missing.join(", ") },
                  )}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-3 rounded-md border border-border p-3">
              <FormField
                label={t(
                  "tools.appointment",
                  "This tool books or cancels an appointment",
                )}
                help={t(
                  "tools.appointmentHelp",
                  "This option identifies when the tool creates or cancels an appointment.\n\nThe platform pauses follow-up messages while the appointment is active and sends the configured reminders.\n\nPoint it at where the id and the start time sit in the tool's response.",
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
                  {sampleParse.state === "ok" &&
                    sampleParse.leaves.length === 0 && (
                      <p className="text-text-secondary text-xs">
                        {t(
                          "tools.appointmentSampleEmpty",
                          "Nothing in the sample response above can be pointed at from here: an id or a start time can only be a piece of text or a number, and every key along the way has to be made of letters, digits, - or _.",
                        )}
                      </p>
                    )}
                  <FormField
                    label={t("tools.appointmentIdPath", "Where the id is")}
                    // INLINE, not behind the `?`, and docs/ui.md names this exact case: a cross-field
                    // dependency is the one kind of help the field can never reveal, because the fact
                    // lives on another screen. Nothing here can detect that the cancellation tool
                    // answers with a different id; the cancellation just never finds the appointment.
                    description={t(
                      "tools.appointmentIdPathHint",
                      "Dot-separated keys, with a number for a list position: data.items.0.id. The tool that cancels has to answer with this same id.",
                    )}
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
                    openLabel={t(
                      "tools.appointmentPick",
                      "Pick from the sample",
                    )}
                    closeLabel={t("tools.appointmentPickClose", "Close")}
                  />
                  <FormField
                    label={t("tools.appointmentProvider", "Booking system")}
                    description={t(
                      "tools.appointmentProviderHint",
                      "Only for multiple booking systems: use the same name on the tools that book and cancel.",
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
                        description={t(
                          "tools.appointmentStartPathHint",
                          "Dot-separated keys, with a number for a list position: data.items.0.start.",
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
                            setForm({
                              ...form,
                              apptSummaryPath: e.target.value,
                            })
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
                          // The last sentence is a WARNING and it went missing once already: a booking
                          // system that reminds the customer itself plus reminders here is two
                          // notifications for one appointment, and nothing on this screen can tell
                          // that the other system does it. Inline by the outcome-1 test in
                          // docs/ui.md.
                          "Enter up to five lead times from 1 to 8760 hours, separated by commas, such as 24, 1; empty disables reminders only. Leave it empty if your own booking system already reminds them.",
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
                <div className="flex items-center gap-1.5">
                  <label
                    htmlFor={ackId}
                    data-clickable="true"
                    className="font-medium text-sm text-text-primary"
                  >
                    {t("tools.ack", "Send a holding message")}
                  </label>
                  <HelpPopover
                    content={t(
                      "tools.ackHelp",
                      "This option makes the agent notify the customer before starting a slow tool.\n\nThe tool starts only after the agent sends this message.\n\nThe example below sets the tone, but is never sent unchanged.",
                    )}
                    label={t("tools.ack", "Send a holding message")}
                  />
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
                      ackInvalid ||
                      !!refusal.at("ackMessage", current.ackMessage)
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
      <ToolTestModal
        modal={testModal}
        onResponse={(raw, status) => {
          setSample(raw);
          setSampleStatus(status);
        }}
      />
    </>
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
