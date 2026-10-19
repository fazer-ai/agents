import { MessageSquare, Phone, TriangleAlert } from "lucide-react";
import { createContext, useContext, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button, useRangeHeld } from "@/client/components";
import { useStaleNotice } from "./StaleNotice";

// Save/Discard bar shared by the editor tabs, styled as a card. `mt-auto` rests it at the bottom of a
// short page and `sticky bottom-0` keeps it in view on a long one. With `onOpenPlayground` it also
// opens the playground; Discard shows only when dirty, and Save is enabled only when dirty: with no
// edit there is nothing to write, the same on every tab (Gabriel's call on agents#1365). Inside the agent editor, while the "changed
// elsewhere" notice is up, it repeats the notice on a row of its own, since on a long tab the card
// at the top is off screen. Both rows wrap, so a narrow viewport keeps Save on screen.
// Set by the editor of a voice agent, whose playground is a call: the button says so.
export const PlaygroundIsCallContext = createContext(false);

// The agent editor's bar is about the agent, not the tab (agents#1520): inside the editor, every tab's
// bar reads this instead of its own props. Dirty when any section is, Save writes every dirty section,
// Discard discards them all. A tab's own hold (`saveDisabled`) holds the button while its section is
// dirty, and is reported up, so a Save pressed on another tab stops there too and names the tab.
export interface EditorBar {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  // Whether the section this tab edits is the dirty one: its own hold matters only then.
  sectionDirty: boolean;
  // Stable per section; called whenever the tab's own hold changes. `rangeHeld` is the part of it a
  // number out of range makes, which no other tab's edit can lift.
  reportBlocked: (blocked: boolean, rangeHeld: boolean) => void;
}
export const EditorBarContext = createContext<EditorBar | null>(null);

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
  const isCall = useContext(PlaygroundIsCallContext);
  const bar = useContext(EditorBarContext);
  // A number out of its range anywhere on the tab holds Save like the tab's own rule.
  const rangeHeld = useRangeHeld();
  const held = !!saveDisabled || rangeHeld;
  const report = bar?.reportBlocked;
  useEffect(() => {
    report?.(held, rangeHeld);
  }, [report, held, rangeHeld]);
  const isDirty = bar ? bar.dirty : dirty;
  const isSaving = bar ? bar.saving : saving;
  const save = bar ? bar.onSave : onSave;
  const discard = bar ? bar.onDiscard : onDiscard;
  const holds = held && (bar ? bar.sectionDirty : true);
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
              {isCall ? (
                <Phone className="h-4 w-4" aria-hidden="true" />
              ) : (
                <MessageSquare className="h-4 w-4" aria-hidden="true" />
              )}
              {isCall
                ? t("editor.openPlaygroundCall", "Call in the playground")
                : t("editor.openPlayground", "Test in playground")}
            </Button>
          ) : (
            <span />
          )}
          <div className="ml-auto flex items-center gap-2">
            {isDirty && (
              <Button variant="secondary" onClick={discard}>
                {t("editor.discard", "Discard")}
              </Button>
            )}
            <Button
              onClick={save}
              loading={isSaving}
              disabled={isSaving || !isDirty || holds}
            >
              {/* The tab's own label names one section; the agent's bar saves them all. */}
              {(!bar && saveLabel) || t("common.save", "Save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
