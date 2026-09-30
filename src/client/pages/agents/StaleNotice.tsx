import { TriangleAlert, X } from "lucide-react";
import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components";

// The editor's "changed elsewhere" notice, as one value the page owns: null while the loaded version
// is current. `overwrite` is set only after a refused save, and re-runs that save forcing it.
export type StaleNotice = {
  reload: () => void;
  overwrite: (() => void) | null;
  dismiss: () => void;
};

// Builds the notice from the page's two pieces of state. The overwrite clears the notice and then
// re-runs the refused save; a refusal of that save raises it again.
export function staleNoticeOf(
  up: boolean,
  retry: (() => void) | null,
  actions: { reload: () => void; clear: () => void; dismiss: () => void },
): StaleNotice | null {
  if (!up) return null;
  return {
    reload: actions.reload,
    overwrite: retry
      ? () => {
          actions.clear();
          retry();
        }
      : null,
    dismiss: actions.dismiss,
  };
}

// The page provides the same value it hands the card, so the save bar at the bottom of a long tab
// shows the notice exactly when the card does, with the same actions. Null outside the editor.
export const StaleNoticeContext = createContext<StaleNotice | null>(null);

export function StaleNoticeCard({ notice }: { notice: StaleNotice | null }) {
  const { t } = useTranslation();
  if (!notice) return null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-warning bg-warning-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert
          className="mt-0.5 h-4 w-4 shrink-0 text-warning"
          aria-hidden="true"
        />
        <p className="text-sm text-text-primary">
          {t(
            "editor.staleNotice",
            "This agent was changed elsewhere (another tab, the API, or the MCP server). Reload to get the latest version before saving.",
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 self-end sm:self-auto">
        <Button size="sm" variant="secondary" onClick={notice.reload}>
          {t("editor.reload", "Reload")}
        </Button>
        {notice.overwrite && (
          <Button size="sm" variant="danger" onClick={notice.overwrite}>
            {t("editor.overwriteAnyway", "Save anyway")}
          </Button>
        )}
        <button
          type="button"
          onClick={notice.dismiss}
          aria-label={t("common.dismiss", "Dismiss")}
          className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:text-text-primary"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function useStaleNotice() {
  return useContext(StaleNoticeContext);
}
