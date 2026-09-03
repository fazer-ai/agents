import { AlertTriangle, Check } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  Select,
  SwitchField,
  Textarea,
  useOnModalOpen,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { fieldTypeLabels } from "./toolFieldTypes";

// One real request for the definition on screen, so the operator can see what the API answers and
// what the model would be given (issue #456). The sample field upstairs is filled from the response,
// which is the whole point: the path picker needs a response, and pasting one by hand is the step
// this removes.
//
// Everything about the request itself is decided server-side (`modules/tool-definitions/test-run.ts`),
// including which context names are honoured. This screen only collects values.

export interface ToolTestField {
  name: string;
  description: string;
  required: boolean;
  // The DECLARED type, carried here because the runtime validates against it before fetching. A
  // model supplies a typed argument; this dialog collects text, and text is what five of the seven
  // declared types are not.
  type: string;
  enumValues?: string[];
  itemType?: string;
}

export interface ToolTestTarget {
  // The definition as the editor would save it, snapshotted when this dialog opens.
  definition: Record<string, unknown>;
  // The AI-filled fields the model would supply, and the conversation placeholders it would not.
  aiFields: ToolTestField[];
  contextNames: string[];
}

// A typed argument out of what the operator typed, because `buildHttpTool` validates against the
// declared zod type BEFORE the request goes out: sending `"3"` for an integer field, or `"true"`
// for a boolean, fails the call with a schema error and never reaches the API. Five of the seven
// declared types are not strings.
//
// Exported and pure so the table is a test rather than a claim.
export type CoercedArg =
  | { ok: true; value: unknown }
  // The reason names the TYPE the field declared, because that is the thing the operator cannot see
  // from this dialog — the declaration lives on the tab behind it.
  | { ok: false; reason: string; itemType?: string };

export function coerceTestArg(
  field: Pick<ToolTestField, "type" | "itemType">,
  raw: string,
): CoercedArg {
  const text = raw.trim();
  switch (field.type) {
    case "integer": {
      // The emptiness guard is not redundant with the callers that already skip a blank box:
      // `Number("")` is 0 and `Number.isInteger(0)` is true, so without it this function answers
      // "the operator typed zero" to a box nobody filled.
      const n = text === "" ? Number.NaN : Number(text);
      return Number.isInteger(n)
        ? { ok: true, value: n }
        : { ok: false, reason: "integer" };
    }
    case "number": {
      const n = Number(text);
      return text !== "" && Number.isFinite(n)
        ? { ok: true, value: n }
        : { ok: false, reason: "number" };
    }
    case "boolean":
      if (text === "true") return { ok: true, value: true };
      if (text === "false") return { ok: true, value: false };
      return { ok: false, reason: "boolean" };
    case "array": {
      // JSON first, because that is what the model sends and what round-trips every element type.
      // A bare comma-separated list is accepted as the shorthand an operator types by hand, with
      // each element coerced by the declared item type so an array of numbers stays numbers.
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text.split(",").map((v) => v.trim());
      }
      if (!Array.isArray(parsed)) return { ok: false, reason: "array" };
      const item = field.itemType ?? "string";
      const out: unknown[] = [];
      for (const el of parsed) {
        const c = coerceTestArg(
          { type: item, itemType: undefined },
          typeof el === "string" ? el : JSON.stringify(el),
        );
        if (!c.ok) return { ok: false, reason: "array", itemType: item };
        out.push(c.value);
      }
      return { ok: true, value: out };
    }
    case "object": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, reason: "object" };
      }
      return parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
        ? { ok: true, value: parsed }
        : { ok: false, reason: "object" };
    }
    default:
      // string and enum: the runtime takes the text as written, and an enum's own membership is the
      // schema's to refuse — the picker below only offers declared values anyway.
      return { ok: true, value: raw };
  }
}

// An enum with no declared values is a legal field, and the runtime deliberately reads it as a free
// string (`zodFor`: "z.enum requires a non-empty tuple; an enum with no values falls back to a free
// string"). A picker built from that empty list offers only "Leave out", so the field could be
// declared and never filled. Whether this dialog shows a picker follows the runtime's own question:
// are there values to pick?
export function fieldUsesPicker(
  field: Pick<ToolTestField, "type" | "enumValues">,
): boolean {
  return (
    field.type === "boolean" ||
    (field.type === "enum" && (field.enumValues?.length ?? 0) > 0)
  );
}

// What is wrong with one box, in the order the runtime would find it. A required field left blank is
// a problem too, and it used to be the silent one: the box was skipped, `args` went out without it,
// and the DECLARED schema refused the call before the request — with the send button enabled the
// whole time, so the first thing the operator learned was a failed run.
//
// Exported and pure for the same reason `coerceTestArg` is: the table is then a test, not a claim.
export type ArgProblem =
  | { kind: "missing" }
  | { kind: "type"; got: Extract<CoercedArg, { ok: false }> };

export function argProblem(
  field: Pick<ToolTestField, "type" | "itemType" | "required" | "enumValues">,
  raw: string,
): ArgProblem | null {
  // A REQUIRED string field cannot be omitted, so a blank box there is not "nothing" — the empty
  // string is the only thing it can mean, and the declared schema takes it. Reporting it missing
  // was a dead end: the field could not be submitted at all, for a value a real tool call can
  // carry (a PATCH that clears a provider field).
  if (raw === "") {
    if (!field.required) return null;
    return fieldTakesEmptyString(field) ? null : { kind: "missing" };
  }
  const got = coerceTestArg(field, raw);
  return got.ok ? null : { kind: "type", got };
}

// Whether the empty string is a VALUE for this field rather than the absence of one. String, and an
// enum with no declared values, which `zodFor` reads as a free string. Everything else refuses it:
// `Number("")` is not an integer, `""` is neither `true` nor `false`, and it parses as no object.
export function fieldTakesEmptyString(
  field: Pick<ToolTestField, "type" | "enumValues">,
): boolean {
  return (
    field.type === "string" ||
    (field.type === "enum" && (field.enumValues?.length ?? 0) === 0)
  );
}

type TestResult = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.tools.test.post>>["data"]
>["result"];

export function ToolTestModal({
  modal,
  onResponse,
}: {
  modal: ModalController<ToolTestTarget>;
  // The raw response AND the status it came back under. The status travels because the runtime
  // projects the template on 2xx alone, so the editor cannot say what the model would receive
  // without knowing which side of that line the sample is on.
  onResponse: (raw: string, status: number) => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  // Which blank boxes are an empty STRING rather than a field left out. A text input renders the two
  // identically, and they are different requests: the model omits an optional argument it has
  // nothing to say about, and sends `""` when it means to clear something. Required string fields
  // do not need a mark — they cannot be omitted, so blank can only be the empty string there.
  const [sendEmpty, setSendEmpty] = useState<Record<string, boolean>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  // One request belongs to one opening of this dialog. Without the token, a slow run whose modal was
  // dismissed (X, Escape, outside click — none of which is disabled) still lands: it writes its
  // result into the NEXT session, hands the parent editor a sample from a definition that is no
  // longer on screen, and clears a `running` that belongs to another request
  // (`docs/modals.md`, "Drop stale responses with a session token").
  const sessionRef = useRef(0);
  const target = modal.payload;
  const typeLabels = fieldTypeLabels(t);
  // The refused type, named the way the tab where it was CHOSEN names it. Reporting the raw
  // `integer` would name a word the operator has never seen on this console: that picker says
  // "Inteiro".
  const typeText = (bad: { reason: string; itemType?: string }) =>
    bad.itemType
      ? `${typeLabels[bad.reason] ?? bad.reason} (${typeLabels[bad.itemType] ?? bad.itemType})`
      : (typeLabels[bad.reason] ?? bad.reason);
  const problemText = (field: string, problem: ArgProblem) =>
    problem.kind === "missing"
      ? t("tools.testMissingArg", '"{{field}}" is required.', { field })
      : t("tools.testBadArg", '"{{field}}" has to be: {{type}}.', {
          field,
          type: typeText(problem.got),
        });

  useOnModalOpen(modal, () => {
    // The component outlives the dialog: a previous run's answer must not read as this one's.
    sessionRef.current += 1;
    setValues({});
    setSendEmpty({});
    setError(null);
    setResult(null);
    setRunning(false);
    // Bumped on CLOSE as well, not only on the next open: a dialog dismissed and never reopened
    // still has a request in flight, and its `onResponse` would overwrite the sample of whatever the
    // editor moved on to.
    return () => {
      sessionRef.current += 1;
    };
  });

  async function run() {
    if (!target) return;
    const session = sessionRef.current;
    setError(null);
    setResult(null);
    setRunning(true);
    try {
      const args: Record<string, unknown> = {};
      for (const f of target.aiFields) {
        const v = values[`ai:${f.name}`] ?? "";
        // Guarded by the disabled button too; kept here because the button is not the only way a
        // value can be stale by the time this runs.
        const problem = argProblem(f, v);
        if (problem) {
          setError(problemText(f.name, problem));
          return;
        }
        if (v === "") {
          // Blank: the empty string when the field cannot be omitted, or when the operator said so.
          if (
            fieldTakesEmptyString(f) &&
            (f.required || sendEmpty[`ai:${f.name}`])
          ) {
            args[f.name] = "";
          }
          continue;
        }
        const coerced = coerceTestArg(f, v);
        if (!coerced.ok) return;
        args[f.name] = coerced.value;
      }
      const context: Record<string, string> = {};
      for (const name of target.contextNames) {
        const v = values[`ctx:${name}`];
        if (v !== undefined && v !== "") context[name] = v;
      }
      const { data, error: err } = await api.api.v1.tools.test.post({
        definition: target.definition as never,
        args,
        context,
      });
      // Everything past the await belongs to the opening that started it, or to nobody.
      if (sessionRef.current !== session) return;
      if (err || !data) {
        // The server's own sentence when it sent one: this endpoint's refusals are the operator's
        // to act on (a host off the allowlist, a placeholder with no value, a credential that did
        // not resolve), and a fixed "could not run" would hide the part that says what to change.
        setError(
          apiErrorMessage(err) ??
            t("tools.testFailed", "The request could not run."),
        );
        return;
      }
      setResult(data.result);
      // The sample field is filled from the RAW response, not the model's text: the picker walks the
      // provider's own body, including the parts the clip would have removed.
      //
      // Unless the wire cap cut it. A clipped JSON document is not a JSON document: both pickers go
      // dark on it, the sample field says "not valid JSON", and none of that names the actual
      // reason. So an unusable prefix is not offered as a sample at all, and the result panel says
      // what happened instead (`testTooLarge` below).
      if (!data.result.rawClipped) {
        onResponse(data.result.raw, data.result.status);
      }
    } catch {
      if (sessionRef.current !== session) return;
      setError(t("tools.testFailed", "The request could not run."));
    } finally {
      if (sessionRef.current === session) setRunning(false);
    }
  }

  // A row's identity is its ORIGIN plus its name, never the name alone. The two halves can collide:
  // a tool may declare an input field called `contact_id`, and the runtime resolves that name with
  // an explicit precedence — AI input, then a fixed value, then context (`valueLookup` in
  // graph/tools/http.ts). Keyed by the bare name, the two rows shared one React key and one box, so
  // the case that precedence exists FOR — the model omits the optional argument and context fills
  // it in — could not be expressed here at all, and the same string went out in both halves.
  const fields: (ToolTestField & { hint: string; slot: string })[] = target
    ? [
        ...target.aiFields.map((f) => ({
          ...f,
          hint: f.description,
          slot: `ai:${f.name}`,
        })),
        ...target.contextNames.map((name) => ({
          name,
          slot: `ctx:${name}`,
          description: "",
          required: false,
          // A context placeholder is interpolated as text whatever it names, so it has no declared
          // type to honour.
          type: "string",
          hint: t(
            "tools.testContextHint",
            "Supplied by the platform during a real conversation.",
          ),
        })),
      ]
    : [];
  // Which boxes the runtime would refuse: a value its declared type cannot take, or a required field
  // left blank. Computed for the render as well as the send, so the operator reads it under the
  // field instead of reading a schema error out of a failed call.
  const problems = target
    ? target.aiFields
        .map((f) => ({
          field: f,
          problem: argProblem(f, values[`ai:${f.name}`] ?? ""),
        }))
        .filter(
          (x): x is { field: ToolTestField; problem: ArgProblem } =>
            x.problem !== null,
        )
    : [];

  return (
    <Modal
      modal={modal}
      size="lg"
      title={t("tools.testTitle", "Test this tool")}
      // NO WAY OUT WHILE A REQUEST IS IN FLIGHT, and the session token is not a substitute for this.
      // The token makes a late answer harmless; it does not un-send the request. A test of a POST or
      // a PATCH is a real write on the provider's side, so dismissing with Escape (or the overlay,
      // or the X — none of which the disabled Cancel button covers) and pressing send again runs the
      // operation TWICE, with the first result deliberately dropped so nothing on screen says it
      // happened. `docs/modals.md`: guard user-driven close while loading AND disable the buttons.
      onCloseRequest={running ? () => {} : undefined}
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-error text-xs">{error}</span>
          <div className="flex gap-2">
            <ModalCancelButton disabled={running} />
            <Button
              onClick={run}
              loading={running}
              disabled={problems.length > 0}
            >
              {t("tools.testRun", "Send request")}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-text-secondary text-xs">
          {t(
            "tools.testIntro",
            "This sends one real request with the settings above, exactly as the agent would. Fill in the values the agent would provide.",
          )}
        </p>
        {fields.length === 0 ? (
          <p className="text-text-secondary text-xs">
            {t(
              "tools.testNoFields",
              "This tool takes no values, so there is nothing to fill in.",
            )}
          </p>
        ) : (
          fields.map((f) => {
            const value = values[f.slot] ?? "";
            const set = (next: string) =>
              setValues((v) => ({ ...v, [f.slot]: next }));
            const bad = f.slot.startsWith("ai:")
              ? problems.find((b) => b.field.name === f.name)
              : undefined;
            const picker = fieldUsesPicker(f);
            // The blank box is ambiguous only here: an optional string the operator may either omit
            // or send as "". Filled, there is nothing to disambiguate; required cannot be omitted at
            // all; and a context name is supplied by the platform, never by the model.
            const canSendEmpty =
              value === "" &&
              !f.required &&
              fieldTakesEmptyString(f) &&
              f.slot.startsWith("ai:");
            return (
              <FormField
                key={f.slot}
                label={f.name}
                description={f.hint}
                // `picker` is one control; `canSendEmpty` puts a switch beside the input, and a
                // FormField wrapping two focusable controls has to be a group or the click on its
                // title reaches the first of them (CLAUDE.md, FormField `group`).
                group={picker || canSendEmpty}
                error={bad ? problemText(f.name, bad.problem) : undefined}
              >
                {picker ? (
                  <Select value={value} onChange={(e) => set(e.target.value)}>
                    <option value="">
                      {t("tools.testUnset", "Leave out")}
                    </option>
                    {(f.type === "boolean"
                      ? ["true", "false"]
                      : // `fieldUsesPicker` already established this list is non-empty.
                        (f.enumValues ?? [])
                    ).map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </Select>
                ) : f.type === "array" || f.type === "object" ? (
                  <Textarea
                    rows={2}
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    placeholder={
                      f.type === "array" ? '["a", "b"]' : '{"key": "value"}'
                    }
                  />
                ) : (
                  <div className="flex flex-col gap-1">
                    <Input
                      value={value}
                      onChange={(e) => set(e.target.value)}
                      // A blank box is two different requests, and the placeholder is where the
                      // operator is already looking. It says which one is armed, so the switch
                      // below can carry a FIXED label instead of a sentence that rewrites itself
                      // on click — a control whose text changes when you use it has no identity to
                      // scan for.
                      placeholder={
                        canSendEmpty
                          ? sendEmpty[f.slot]
                            ? t("tools.testEmptyString", 'goes in empty: ""')
                            : t(
                                "tools.testNotSent",
                                "not included in the request",
                              )
                          : undefined
                      }
                    />
                    {/* Only while the box is blank AND the field is optional: filled, there is
                        nothing to disambiguate, and required cannot be omitted at all. */}
                    {canSendEmpty && (
                      <SwitchField
                        className="self-start text-xs"
                        checked={sendEmpty[f.slot] ?? false}
                        onCheckedChange={(on) =>
                          setSendEmpty((m) => ({ ...m, [f.slot]: on }))
                        }
                        label={t(
                          "tools.testSendEmpty",
                          "Send it as empty in the request",
                        )}
                        // A switch's label only ever describes the ON state, so the OFF one is left
                        // to inference — and here OFF is the surprising half: the field vanishes
                        // from the payload with nothing on screen saying so. The help carries that,
                        // plus the reason anyone would want the other one.
                        help={t(
                          "tools.testSendEmptyHelp",
                          "If unchecked, the field is not included in the request. Checked, it goes with the empty string, which is how a value is cleared at the provider.",
                        )}
                      />
                    )}
                  </div>
                )}
              </FormField>
            );
          })
        )}
        {result && (
          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <div className="flex items-center gap-2 text-xs">
              {result.failed ? (
                <AlertTriangle
                  className="h-4 w-4 shrink-0 text-warning"
                  aria-hidden="true"
                />
              ) : (
                <Check
                  className="h-4 w-4 shrink-0 text-success"
                  aria-hidden="true"
                />
              )}
              <span className="text-text-primary">
                {t("tools.testStatus", "HTTP {{status}} in {{ms}} ms", {
                  status: result.status,
                  ms: result.durationMs,
                })}
              </span>
              <span className="text-text-secondary">
                {t("tools.testSize", "{{chars}} characters", {
                  chars: result.rawChars,
                })}
              </span>
            </div>
            {result.rawClipped && (
              <p className="text-warning text-xs">
                {t(
                  "tools.testTooLarge",
                  "This response is too large to bring back as a sample, so the field above was left as it was. The agent still receives what is shown below.",
                )}
              </p>
            )}
            {result.notes.length > 0 && (
              <ul className="flex flex-col gap-1">
                {result.notes.map((n) => (
                  <li
                    key={n.phase + n.message}
                    className="text-warning text-xs"
                  >
                    {n.message}
                  </li>
                ))}
              </ul>
            )}
            <FormField
              group
              label={t("tools.testModelText", "What the agent would receive")}
              description={t(
                "tools.testModelTextHint",
                "The response after your template and the size limit are applied. The sample field was filled with the full response.",
              )}
            >
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-tertiary p-2 text-text-primary text-xs">
                {result.modelText}
              </pre>
            </FormField>
          </div>
        )}
      </div>
    </Modal>
  );
}
