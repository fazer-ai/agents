import { MessageSquare, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components";
import { useStaleNotice } from "./StaleNotice";

// Save/Discard bar shared by the editor tabs, styled as a card. `mt-auto` rests it at the bottom of a
// short page and `sticky bottom-0` keeps it in view on a long one. With `onOpenPlayground` it also
// opens the playground; Discard shows only when dirty. Inside the agent editor, while the "changed
// elsewhere" notice is up, it repeats the notice on a row of its own, since on a long tab the card
// at the top is off screen. Both rows wrap, so a narrow viewport keeps Save on screen.
export function TabActionBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  saveDisabled,
  saveLabel,
  onOpenPlayground,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  saveDisabled?: boolean;
  saveLabel?: string;
  onOpenPlayground?: () => void;
}) {
  const { t } = useTranslation();
  const stale = useStaleNotice();
  return (
    <div className="sticky bottom-0 z-10 mt-auto">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3 shadow-lg">
        {stale && (
          <div
            data-testid="stale-notice-strip"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-border border-b pb-3"
          >
            <span className="flex min-w-0 items-center gap-1.5 text-sm text-text-primary">
              <TriangleAlert
                className="h-4 w-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              {t("editor.staleShort", "Changed elsewhere")}
            </span>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={stale.reload}>
                {t("editor.reload", "Reload")}
              </Button>
              {stale.overwrite && (
                <Button size="sm" variant="danger" onClick={stale.overwrite}>
                  {t("editor.overwriteAnyway", "Save anyway")}
                </Button>
              )}
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {onOpenPlayground ? (
            <Button variant="secondary" onClick={onOpenPlayground}>
              <MessageSquare className="h-4 w-4" aria-hidden="true" />
              {t("editor.openPlayground", "Test in playground")}
            </Button>
          ) : (
            <span />
          )}
          <div className="ml-auto flex items-center gap-2">
            {dirty && (
              <Button variant="secondary" onClick={onDiscard}>
                {t("editor.discard", "Discard")}
              </Button>
            )}
            <Button
              onClick={onSave}
              loading={saving}
              disabled={saving || !!saveDisabled}
            >
              {saveLabel ?? t("common.save", "Save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
