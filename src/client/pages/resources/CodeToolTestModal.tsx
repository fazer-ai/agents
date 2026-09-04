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
import { CONTEXT_VAR_NAMES } from "@/modules/tool-definitions/normalize";
import {
  type ArgProblem,
  argProblem,
  coerceTestArg,
  fieldTakesEmptyString,
  fieldUsesPicker,
  type ToolTestField,
} from "./ToolTestModal";
import { fieldTypeLabels } from "./toolFieldTypes";

// Run a code tool's body once, unsaved, with typed arguments — the operator's "test step" — through
// the same POST /v1/code-tools/test the runtime's own path answers (modules/code-tools/test-run.ts).
// The sibling of ToolTestModal for the HTTP tool: it collects the same typed arguments (a value the
// declared type cannot take is refused before the button, so the operator reads it here instead of
// out of a failed call) but reports a code tool's answer — the text the agent would receive, whether
// it failed, and the console output — not an HTTP status and a body.

// Which of the runtime's context variables this body actually reads, in the runtime's own order.
//
// The same question the HTTP tool's dialog asks of a template (`contextNamesReferencedBy`), and
// asked for the same reason: the operator can only supply a value for a name they are shown, and
// showing all ten when the body reads one is a form nobody fills. TEXT, not a parse: a body that
// does not compile is savable and testable by design, so a parser that refuses it would take the
// dialog down with it, and the cost of reading one name too many is one empty field.
//
// Only the ten the runtime exposes as strings. `conversationAttributes` and `contactAttributes` are
// objects a turn loads from the database, and no text field can stand for them.
export function contextNamesUsedBy(code: string): string[] {
  const used = new Set<string>();
  for (const m of code.matchAll(
    /\bcontext\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(?:"([^"]*)"|'([^']*)')\s*\])/g,
  )) {
    const name = m[1] ?? m[2] ?? m[3];
    if (name) used.add(name);
  }
  return CONTEXT_VAR_NAMES.filter((n) => used.has(n));
}

// The operator's own zone, and UTC when the browser will not say (a locked-down runtime answers
// with an empty string). Never thrown: a dialog that cannot open is worse than one that opens on
// UTC and says so in the field.
function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Every IANA zone the browser knows, so the operator picks the agent's instead of typing it. Older
// runtimes have no `supportedValuesOf`; there the list is the two zones that are always meaningful.
function zoneOptions(current: string): string[] {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf?.("timeZone") ?? [];
  } catch {
    all = [];
  }
  const out = all.length > 0 ? all : ["UTC", browserZone()];
  return out.includes(current) ? out : [current, ...out];
}

export interface CodeToolTestTarget {
  // The definition the dialog will run: the unsaved name/schema/code as the editor holds them.
  definition: {
    name?: string;
    inputSchema?: Record<string, unknown>;
    code: string;
  };
  // The AI-filled fields the model would supply, read off the schema the request will carry.
  aiFields: ToolTestField[];
}

type CodeTestResult = NonNullable<
  Awaited<ReturnType<(typeof api.api.v1)["code-tools"]["test"]["post"]>>["data"]
>["result"];

// The console output the sandbox captured, present on value/error/limit and absent otherwise.
function logsOf(result: CodeTestResult): string[] {
  return "logs" in result.outcome ? result.outcome.logs : [];
}

export function CodeToolTestModal({
  modal,
}: {
  modal: ModalController<CodeToolTestTarget>;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  // Which blank boxes are an empty STRING rather than a field left out — the same distinction the
  // HTTP dialog draws, because the model omits an optional argument it has nothing to say about.
  const [sendEmpty, setSendEmpty] = useState<Record<string, boolean>>({});
  // The conversation variables, which no model supplies and no dialog can guess. Collected the way
  // the HTTP tool's dialog collects the `{{names}}` its template mentions.
  const [context, setContext] = useState<Record<string, string>>({});
  // The zone `Date`, TIMEZONE and NOW_LOCAL run in. It is the AGENT's at run time and the dialog has
  // no agent, so it is asked rather than assumed: silently using the browser's made a body that
  // reads a date pass here and behave differently in production, with the two zones never named on
  // screen. The browser's is the first guess because it is the one the operator can sanity-check.
  const [timezone, setTimezone] = useState("UTC");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CodeTestResult | null>(null);

  // One request belongs to one opening of this dialog. Without the token a slow run whose dialog was
  // dismissed still lands, clearing a `running` that belongs to another request (docs/modals.md,
  // "Drop stale responses with a session token").
  const sessionRef = useRef(0);
  const target = modal.payload;
  // Asked of the BODY, so the dialog shows the variables this code reads and no others.
  const contextNames = contextNamesUsedBy(target?.definition.code ?? "");
  const typeLabels = fieldTypeLabels(t);
  const typeText = (bad: { reason: string; itemType?: string }) =>
    bad.itemType
      ? `${typeLabels[bad.reason] ?? bad.reason} (${typeLabels[bad.itemType] ?? bad.itemType})`
      : (typeLabels[bad.reason] ?? bad.reason);
  const problemText = (field: string, problem: ArgProblem) =>
    problem.kind === "missing"
      ? t("codeTools.testMissingArg", '"{{field}}" is required.', { field })
      : t("codeTools.testBadArg", '"{{field}}" has to be: {{type}}.', {
          field,
          type: typeText(problem.got),
        });

  useOnModalOpen(modal, () => {
    sessionRef.current += 1;
    setValues({});
    setSendEmpty({});
    setContext({});
    setTimezone(browserZone());
    setError(null);
    setResult(null);
    setRunning(false);
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
        const v = values[f.name] ?? "";
        const problem = argProblem(f, v);
        if (problem) {
          setError(problemText(f.name, problem));
          return;
        }
        if (v === "") {
          if (fieldTakesEmptyString(f) && (f.required || sendEmpty[f.name])) {
            args[f.name] = "";
          }
          continue;
        }
        const coerced = coerceTestArg(f, v);
        if (!coerced.ok) return;
        args[f.name] = coerced.value;
      }
      // Only what the operator actually filled in: a blank box is a variable the turn did not have
      // either, which is a real case the body has to survive, and sending "" for it would test a
      // different one.
      const ctx: Record<string, string> = {};
      for (const name of contextNames) {
        const v = context[name] ?? "";
        if (v !== "") ctx[name] = v;
      }
      const { data, error: err } = await api.api.v1["code-tools"].test.post({
        definition: target.definition,
        args,
        context: ctx,
        timezone,
      });
      // Everything past the await belongs to the opening that started it, or to nobody.
      if (sessionRef.current !== session) return;
      if (err || !data) {
        // The endpoint's own sentence when it sent one: a value the schema refuses is the operator's
        // to fix, and a fixed "could not run" would hide the part that says what to change.
        setError(
          apiErrorMessage(err) ??
            t("codeTools.testFailed", "The code could not run."),
        );
        return;
      }
      setResult(data.result);
    } catch {
      if (sessionRef.current !== session) return;
      setError(t("codeTools.testFailed", "The code could not run."));
    } finally {
      if (sessionRef.current === session) setRunning(false);
    }
  }

  const problems = target
    ? target.aiFields
        .map((f) => ({
          field: f,
          problem: argProblem(f, values[f.name] ?? ""),
        }))
        .filter(
          (x): x is { field: ToolTestField; problem: ArgProblem } =>
            x.problem !== null,
        )
    : [];

  const logs = result ? logsOf(result) : [];

  return (
    <Modal
      modal={modal}
      size="lg"
      title={t("codeTools.testTitle", "Test this code tool")}
      // NO WAY OUT WHILE A REQUEST IS IN FLIGHT: the token makes a late answer harmless but does not
      // un-run the body, so dismissing and running again would run it twice (docs/modals.md).
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
              {t("codeTools.testRun", "Run")}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-text-secondary text-xs">
          {t(
            "codeTools.testIntro",
            "This runs the code once in the sandbox, through the same path a turn uses. What the agent would supply is yours to fill in here: the arguments, the conversation variables the body reads, and the zone the agent runs in.",
          )}
        </p>
        {!target || target.aiFields.length === 0 ? (
          <p className="text-text-secondary text-xs">
            {t(
              "codeTools.testNoFields",
              "This tool takes no arguments, so there is nothing to fill in.",
            )}
          </p>
        ) : (
          target.aiFields.map((f) => {
            const value = values[f.name] ?? "";
            const set = (next: string) =>
              setValues((v) => ({ ...v, [f.name]: next }));
            const bad = problems.find((b) => b.field.name === f.name);
            const picker = fieldUsesPicker(f);
            const canSendEmpty =
              value === "" && !f.required && fieldTakesEmptyString(f);
            return (
              <FormField
                key={f.name}
                label={f.name}
                description={f.description}
                // `picker` is one control; `canSendEmpty` puts a switch beside the input, and a
                // FormField wrapping two focusable controls has to be a group or the click on its
                // title reaches the first of them (CLAUDE.md, FormField `group`).
                group={picker || canSendEmpty}
                error={bad ? problemText(f.name, bad.problem) : undefined}
              >
                {picker ? (
                  <Select value={value} onChange={(e) => set(e.target.value)}>
                    <option value="">
                      {t("codeTools.testUnset", "Leave out")}
                    </option>
                    {(f.type === "boolean"
                      ? ["true", "false"]
                      : (f.enumValues ?? [])
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
                      placeholder={
                        canSendEmpty
                          ? sendEmpty[f.name]
                            ? t(
                                "codeTools.testEmptyString",
                                'goes in empty: ""',
                              )
                            : t(
                                "codeTools.testNotSent",
                                "not included in the call",
                              )
                          : undefined
                      }
                    />
                    {canSendEmpty && (
                      <SwitchField
                        className="self-start text-xs"
                        checked={sendEmpty[f.name] ?? false}
                        onCheckedChange={(on) =>
                          setSendEmpty((m) => ({ ...m, [f.name]: on }))
                        }
                        label={t(
                          "codeTools.testSendEmpty",
                          "Send it as empty in the call",
                        )}
                        help={t(
                          "codeTools.testSendEmptyHelp",
                          "If unchecked, the field is not included in the call. Checked, it goes with the empty string.",
                        )}
                      />
                    )}
                  </div>
                )}
              </FormField>
            );
          })
        )}

        {contextNames.length > 0 && (
          <FormField
            label={t("codeTools.testContext", "Conversation variables")}
            group
            description={t(
              "codeTools.testContextHint",
              "The values a turn would carry, for the variables this body reads. Leave one blank to test what the body does when the turn did not have it.",
            )}
          >
            <div className="flex flex-col gap-2">
              {contextNames.map((name) => (
                <div key={name} className="flex items-center gap-2 text-xs">
                  <code className="w-40 shrink-0 truncate rounded bg-bg-tertiary px-1 py-0.5 font-mono">
                    {name}
                  </code>
                  <Input
                    aria-label={name}
                    value={context[name] ?? ""}
                    onChange={(e) =>
                      setContext((c) => ({ ...c, [name]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
          </FormField>
        )}

        <FormField
          label={t("codeTools.testTimezone", "Agent timezone")}
          description={t(
            "codeTools.testTimezoneHint",
            "Date, TIMEZONE and NOW_LOCAL run in this zone, as they will in a turn. Your browser's is the starting guess, not the agent's.",
          )}
        >
          <Select
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {zoneOptions(timezone).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
        </FormField>

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
                {result.failed
                  ? t("codeTools.testFailedBadge", "Failed")
                  : t("codeTools.testOk", "Returned a value")}
              </span>
            </div>
            <FormField
              group
              label={t("codeTools.testResult", "What the agent would receive")}
            >
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-tertiary p-2 text-text-primary text-xs">
                {result.text}
              </pre>
            </FormField>
            {logs.length > 0 && (
              <FormField
                group
                label={t("codeTools.testLogs", "Console output")}
              >
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-tertiary p-2 text-text-secondary text-xs">
                  {logs.join("\n")}
                </pre>
              </FormField>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
