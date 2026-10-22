import { CircleCheck, CircleX } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  SwitchField,
  Textarea,
} from "@/client/components";
import { useToast } from "@/client/components/Toast";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";

// "Test reception": a sample notification pasted here runs through the SAVED instance on the server
// (src/modules/webhooks/inbound/test-reception.ts), and each stage comes back with its verdict.

export interface TestStage {
  stage: string;
  ok: boolean;
  reason?: string;
  detail?: Record<string, unknown>;
}

export interface TestResult {
  dryRun: boolean;
  outcome: string;
  stages: TestStage[];
}

// `Name: value` per line, as a request's headers are usually copied from a provider's log. A line
// without a colon is ignored rather than sent with an empty name. A name repeated (in any case) is
// one header whose values join with ", ", as the webhook route's Fetch `Headers` read it.
export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const spelled = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.substring(0, at).trim();
    if (!name) continue;
    const value = line.substring(at + 1).trim();
    const first = spelled.get(name.toLowerCase());
    if (first === undefined) {
      spelled.set(name.toLowerCase(), name);
      out[name] = value;
    } else {
      out[first] = `${out[first]}, ${value}`;
    }
  }
  return out;
}

export type RunTest = (input: {
  body: string;
  headers: Record<string, string>;
  query: string;
  dryRun: boolean;
}) => Promise<TestResult>;

export function apiRunTest(instanceId: string): RunTest {
  return async (input) => {
    const { data, error } = await api.api.v1.integrations
      .instances({ id: instanceId })
      ["test-reception"].post(input);
    if (error || !data) throw error ?? new Error("no result");
    return data as unknown as TestResult;
  };
}

function detailLines(detail: Record<string, unknown> | undefined): string[] {
  return Object.entries(detail ?? {}).map(
    ([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
  );
}

export function TestReceptionPanel({
  run,
  onRunningChange,
  disabled = false,
}: {
  run: RunTest;
  // The editor is saving: a test started now would be unmounted by the close that follows the save.
  disabled?: boolean;
  // The editor holds its close and save while a test is out (docs/modals.md, async flows): a real
  // test delivers, and closing would lose its result without stopping it.
  onRunningChange?: (running: boolean) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [body, setBody] = useState("");
  const [headers, setHeaders] = useState("");
  const [query, setQuery] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const stageLabel: Record<string, string> = {
    signature: t("integrations.test.stageSignature", "Signature"),
    mapping: t("integrations.test.stageMapping", "Reading the event"),
    fetch_back: t("integrations.test.stageFetchBack", "Lookup"),
    correlation: t("integrations.test.stageCorrelation", "Conversation"),
    record: t("integrations.test.stageRecord", "Record"),
    agent: t("integrations.test.stageAgent", "Agent turn"),
    delivery: t("integrations.test.stageDelivery", "Delivery"),
  };

  async function submit() {
    setRunning(true);
    onRunningChange?.(true);
    try {
      setResult(
        await run({
          body,
          headers: parseHeaderLines(headers),
          query: query.trim(),
          dryRun,
        }),
      );
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("integrations.test.error", "The test could not run."),
        "error",
      );
    } finally {
      setRunning(false);
      onRunningChange?.(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-secondary">
        {t(
          "integrations.test.hint",
          "Paste a notification as the provider sends it. The test uses the saved settings.",
        )}
      </p>
      <FormField label={t("integrations.test.body", "Notification body")}>
        <Textarea
          rows={5}
          className="font-mono text-xs"
          value={body}
          placeholder='{"type":"payment","data":{"id":"123"}}'
          onChange={(e) => setBody(e.target.value)}
        />
      </FormField>
      <FormField
        label={t("integrations.test.headers", "Headers")}
        description={t(
          "integrations.test.headersHint",
          "One per line, as Name: value.",
        )}
      >
        <Textarea
          rows={3}
          className="font-mono text-xs"
          value={headers}
          placeholder={"x-signature: ts=…,v1=…\nx-request-id: …"}
          onChange={(e) => setHeaders(e.target.value)}
        />
      </FormField>
      <FormField
        label={t("integrations.test.query", "URL parameters")}
        description={t(
          "integrations.test.queryHint",
          "What comes after the ? in the webhook URL.",
        )}
      >
        <Input
          className="font-mono text-xs"
          value={query}
          placeholder="data.id=123&type=payment"
          onChange={(e) => setQuery(e.target.value)}
        />
      </FormField>
      <SwitchField
        checked={dryRun}
        onCheckedChange={setDryRun}
        label={t(
          "integrations.test.dryRun",
          "Simulate only (nothing is recorded or sent)",
        )}
      />
      <Button
        variant="secondary"
        className="self-start"
        disabled={disabled || running || !body.trim()}
        onClick={() => void submit()}
      >
        {t("integrations.test.run", "Run test")}
      </Button>
      {result && (
        <ol
          className="flex flex-col gap-2"
          aria-label={t("integrations.test.result", "Test result")}
        >
          {result.stages.map((s, i) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: a stage can repeat (the lookup's mapping)
              key={i}
              className="rounded-md border border-border p-2 text-sm"
            >
              <div className="flex items-center gap-2 font-medium">
                {s.ok ? (
                  <CircleCheck
                    className="h-4 w-4 text-success"
                    aria-label={t("integrations.test.passed", "passed")}
                  />
                ) : (
                  <CircleX
                    className="h-4 w-4 text-error"
                    aria-label={t("integrations.test.stopped", "stopped here")}
                  />
                )}
                {stageLabel[s.stage] ?? s.stage}
                {s.reason && (
                  <span className="font-mono text-text-secondary text-xs">
                    {s.reason}
                  </span>
                )}
              </div>
              {detailLines(s.detail).length > 0 && (
                <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-text-secondary text-xs">
                  {detailLines(s.detail).join("\n")}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
