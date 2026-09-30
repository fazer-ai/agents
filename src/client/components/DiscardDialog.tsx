import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useTranslation } from "react-i18next";
import { cn } from "@/client/lib/utils";
import { Button } from "./Button";

// The "discard unsaved changes?" confirmation shown over a <Modal> when the
// user tries to close it (Esc / outside click / X / Back button) with unsaved
// edits. Deliberately NOT built on <Modal>: every <Modal> renders one of these,
// so reusing <Modal> would recurse infinitely. It is a thin, self-contained
// Radix dialog instead. `depth` is the parent modal's depth + 1 so it always
// stacks one step above its parent.
const STEP = 2;

export function DiscardDialog({
  open,
  depth,
  onKeep,
  onDiscard,
}: {
  open: boolean;
  depth: number;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  const z = `calc(var(--z-modal) + ${depth * STEP})`;
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        // Esc / overlay click on the confirm itself means "keep editing".
        if (!next) onKeep();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          style={{ zIndex: `calc(var(--z-modal) + ${depth * STEP - 1})` }}
          className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 bg-overlay data-[state=closed]:animate-out data-[state=open]:animate-in"
        />
        <DialogPrimitive.Content
          style={{ zIndex: z }}
          aria-describedby={undefined}
          className={cn(
            "data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 fixed top-[50dvh] left-1/2 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-bg-secondary focus:outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
          )}
        >
          <div className="flex shrink-0 items-center justify-between border-border border-b px-6 py-4">
            <DialogPrimitive.Title className="font-semibold text-text-primary text-xl">
              {t("common.discardChanges", "Discard changes?")}
            </DialogPrimitive.Title>
          </div>
          <div className="px-6 py-4">
            <p className="text-sm text-text-secondary">
              {t(
                "common.discardChangesBody",
                "You have unsaved changes. If you leave now, they will be lost.",
              )}
            </p>
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-border border-t px-6 py-4">
            <Button variant="secondary" onClick={onKeep}>
              {t("common.keepEditing", "Keep editing")}
            </Button>
            <Button variant="danger" onClick={onDiscard}>
              {t("common.discardChangesConfirm", "Discard")}
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
