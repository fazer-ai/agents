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
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CodeTestResult | null>(null);

  // One request belongs to one opening of this dialog. Without the token a slow run whose dialog was
  // dismissed still lands, clearing a `running` that belongs to another request (docs/modals.md,
  // "Drop stale responses with a session token").
  const sessionRef = useRef(0);
  const target = modal.payload;
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
      const { data, error: err } = await api.api.v1["code-tools"].test.post({
        definition: target.definition,
        args,
        // The agent runs in the operator's browser zone here; Date/TIMEZONE/NOW_LOCAL follow it.
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
            "This runs the code once in the sandbox, exactly as the agent would. Fill in the arguments the agent would provide.",
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
