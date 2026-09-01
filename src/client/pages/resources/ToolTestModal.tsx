import { AlertTriangle, Check } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  useOnModalOpen,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";

// One real request for the definition on screen, so the operator can see what the API answers and
// what the model would be given (issue #456). The sample field upstairs is filled from the response,
// which is the whole point: the path picker needs a response, and pasting one by hand is the step
// this removes.
//
// Everything about the request itself is decided server-side (`modules/tool-definitions/test-run.ts`),
// including which context names are honoured. This screen only collects values.

export interface ToolTestTarget {
  // The definition as the editor would save it, snapshotted when this dialog opens.
  definition: Record<string, unknown>;
  // The AI-filled fields the model would supply, and the conversation placeholders it would not.
  aiFields: { name: string; description: string; required: boolean }[];
  contextNames: string[];
}

type TestResult = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.tools.test.post>>["data"]
>["result"];

export function ToolTestModal({
  modal,
  onResponse,
}: {
  modal: ModalController<ToolTestTarget>;
  onResponse: (raw: string) => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);

  const target = modal.payload;

  useOnModalOpen(modal, () => {
    // The component outlives the dialog: a previous run's answer must not read as this one's.
    setValues({});
    setError(null);
    setResult(null);
    setRunning(false);
  });

  async function run() {
    if (!target) return;
    setError(null);
    setResult(null);
    setRunning(true);
    try {
      const args: Record<string, unknown> = {};
      for (const f of target.aiFields) {
        const v = values[f.name];
        if (v !== undefined && v !== "") args[f.name] = v;
      }
      const context: Record<string, string> = {};
      for (const name of target.contextNames) {
        const v = values[name];
        if (v !== undefined && v !== "") context[name] = v;
      }
      const { data, error: err } = await api.api.v1.tools.test.post({
        definition: target.definition as never,
        args,
        context,
      });
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
      onResponse(data.result.raw);
    } catch {
      setError(t("tools.testFailed", "The request could not run."));
    } finally {
      setRunning(false);
    }
  }

  const fields = target
    ? [
        ...target.aiFields.map((f) => ({
          name: f.name,
          hint: f.description,
          required: f.required,
        })),
        ...target.contextNames.map((name) => ({
          name,
          hint: t(
            "tools.testContextHint",
            "Supplied by the platform during a real conversation.",
          ),
          required: false,
        })),
      ]
    : [];

  return (
    <Modal
      modal={modal}
      size="lg"
      title={t("tools.testTitle", "Test this tool")}
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-error text-xs">{error}</span>
          <div className="flex gap-2">
            <ModalCancelButton disabled={running} />
            <Button onClick={run} loading={running}>
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
          fields.map((f) => (
            <FormField key={f.name} label={f.name} description={f.hint}>
              <Input
                value={values[f.name] ?? ""}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [f.name]: e.target.value }))
                }
              />
            </FormField>
          ))
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
