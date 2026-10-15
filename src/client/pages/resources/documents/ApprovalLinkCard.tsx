import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  FilterPills,
  FormField,
  Input,
  Skeleton,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";

type Mode = "console" | "custom" | "none";
interface ApprovalLink {
  mode: Mode;
  urlTemplate: string;
}

// Where the link at the end of an approval request's private note in Chatwoot points
// (docs/documents.md, Approval). Read and saved on its own, so a reload of the templates around it
// never touches a draft here.
export function ApprovalLinkCard() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [saved, setSaved] = useState<ApprovalLink | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<Mode>("console");
  const [template, setTemplate] = useState("");
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const { data, error } = await api.api.v1["tenant-settings"].get();
      if (error || !data) throw error ?? new Error("no data");
      setSaved(data.approvalLink);
      setMode(data.approvalLink.mode);
      setTemplate(data.approvalLink.urlTemplate);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!saved) {
    return (
      <Card className="flex flex-col gap-3">
        {failed ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-text-muted">
              {t(
                "documents.approvalLink.loadError",
                "Could not read the approval link setting.",
              )}
            </span>
            <Button size="sm" variant="secondary" onClick={load}>
              {t("common.retry", "Retry")}
            </Button>
          </div>
        ) : (
          <div role="status" className="flex flex-col gap-3">
            <span className="sr-only">{t("common.loading", "Loading…")}</span>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-8 w-full" />
          </div>
        )}
      </Card>
    );
  }

  const dirty =
    mode !== saved.mode ||
    (mode === "custom" && template.trim() !== saved.urlTemplate);

  async function save() {
    setSaving(true);
    setFieldError(null);
    try {
      const { data, error } = await api.api.v1["tenant-settings"][
        "approval-link"
      ].put({ mode, urlTemplate: template });
      if (error || !data) {
        const message =
          apiErrorMessage(error) ||
          t("documents.approvalLink.saveError", "Could not save.");
        if (mode === "custom") setFieldError(message);
        else showToast(message, "error");
        return;
      }
      setSaved(data.approvalLink);
      setMode(data.approvalLink.mode);
      setTemplate(data.approvalLink.urlTemplate);
      showToast(t("common.saved", "Saved."), "success");
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("documents.approvalLink.saveError", "Could not save."),
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <p className="font-medium text-sm text-text-primary">
          {t("documents.approvalLink.title", "Link in approval notes")}
        </p>
        <p className="text-text-muted text-xs">
          {t(
            "documents.approvalLink.subtitle",
            "Every private note about an approval request (opened, approved, rejected, expired) ends with a link to the request. Point it to the app where your team reviews them, or leave it out.",
          )}
        </p>
      </div>
      <FormField
        label={t("documents.approvalLink.mode", "The link opens")}
        group
      >
        <FilterPills
          aria-label={t("documents.approvalLink.mode", "The link opens")}
          value={mode}
          onChange={(k) => {
            setMode(k as Mode);
            setFieldError(null);
          }}
          items={[
            {
              key: "console",
              label: t("documents.approvalLink.modeConsole", "This console"),
            },
            {
              key: "custom",
              label: t("documents.approvalLink.modeCustom", "Another address"),
            },
            {
              key: "none",
              label: t("documents.approvalLink.modeNone", "No link"),
            },
          ]}
        />
      </FormField>
      {mode === "custom" && (
        <FormField
          label={t("documents.approvalLink.template", "Address")}
          description={t(
            "documents.approvalLink.templateHelp",
            "A full address starting with https://, with {id} where the request number goes. Leave it empty to go back to this console.",
          )}
          error={fieldError}
        >
          <Input
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value);
              setFieldError(null);
            }}
            placeholder="https://app.example.com/documents?approval={id}"
            maxLength={500}
          />
        </FormField>
      )}
      {mode === "none" && (
        <p className="text-sm text-text-secondary">
          {t(
            "documents.approvalLink.noneHelp",
            "The notes are still written, with the decision and the reviewer's note, only without the link.",
          )}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          loading={saving}
          disabled={!dirty || saving}
        >
          {t("common.save", "Save")}
        </Button>
      </div>
    </Card>
  );
}
