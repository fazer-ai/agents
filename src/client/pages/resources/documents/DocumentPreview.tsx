import { FileWarning } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/client/components";
import type { DocumentPreviewState } from "./useDocumentPreview";

// The rendered document, in an <iframe> fed by a blob URL. The CSP had to grow `blob:` in frame-src
// for this to show anything at all (src/api/lib/csp.ts) — without it the frame is blocked and the
// only trace is a line in the browser console.
export function DocumentPreview({
  state,
  className,
}: {
  state: DocumentPreviewState;
  className?: string;
}) {
  const { t } = useTranslation();
  if (state.error) {
    return (
      <div
        className={`flex flex-col items-center justify-center gap-2 rounded-lg border border-border bg-bg-secondary p-6 text-center ${className ?? ""}`}
      >
        <FileWarning className="h-5 w-5 text-warning" aria-hidden="true" />
        <p className="font-medium text-sm text-text-primary">
          {t("documents.preview.errorTitle", "This document does not render")}
        </p>
        <p className="text-text-muted text-xs">{state.error}</p>
      </div>
    );
  }
  if (!state.url) {
    return (
      <div
        role="status"
        className={`rounded-lg border border-border bg-bg-secondary p-3 ${className ?? ""}`}
      >
        <span className="sr-only">{t("common.loading", "Loading…")}</span>
        <Skeleton className="h-full min-h-64 w-full" />
      </div>
    );
  }
  return (
    <div className={`relative ${className ?? ""}`}>
      <iframe
        // NOTE: keyed by the blob URL. Some browsers keep showing the previous PDF when only the src
        // of a live <iframe> changes, so a preview would silently lag one edit behind.
        key={state.url}
        src={state.url}
        title={t("documents.preview.title", "Document preview")}
        className="h-full min-h-64 w-full rounded-lg border border-border bg-white"
      />
      {state.loading && (
        <div className="absolute inset-0 rounded-lg bg-bg-primary/40" />
      )}
    </div>
  );
}
