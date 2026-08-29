import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  HelpPopover,
  Modal,
  type ModalController,
  Switch,
  useOnModalOpen,
} from "@/client/components";

// Export flow modal (items 2/3/4): choose whether to bundle full component definitions, and — when
// there are unsaved edits — whether to save first or export the last-saved version. The page does the
// actual work via `onExport`; this component only collects the choices.
export function ExportAgentModal({
  modal,
  anyDirty,
  onExport,
}: {
  modal: ModalController;
  anyDirty: boolean;
  onExport: (opts: {
    includeComponents: boolean;
    includeDocuments: boolean;
    saveFirst: boolean;
  }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const switchId = useId();
  const documentsSwitchId = useId();
  const [includeComponents, setIncludeComponents] = useState(true);
  // Off by default: bundling document text makes the file data-bearing (tenant content).
  const [includeDocuments, setIncludeDocuments] = useState(false);
  const [busy, setBusy] = useState(false);

  useOnModalOpen(modal, () => {
    setIncludeComponents(true);
    setIncludeDocuments(false);
    setBusy(false);
  });

  const run = async (saveFirst: boolean) => {
    setBusy(true);
    try {
      await onExport({
        includeComponents,
        // Documents ride under components; never send docs without them.
        includeDocuments: includeComponents && includeDocuments,
        saveFirst,
      });
      modal.close();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      modal={modal}
      size="md"
      title={t("editor.exportModalTitle", "Export agent")}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => modal.close()}
            disabled={busy}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          {anyDirty ? (
            <>
              <Button
                variant="secondary"
                onClick={() => run(false)}
                loading={busy}
              >
                {t("editor.exportSaved", "Export saved version")}
              </Button>
              <Button onClick={() => run(true)} loading={busy}>
                {t("editor.saveAndExport", "Save and export")}
              </Button>
            </>
          ) : (
            <Button onClick={() => run(false)} loading={busy}>
              {t("editor.export", "Export")}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <label
              htmlFor={switchId}
              data-clickable="true"
              className="font-medium text-sm text-text-primary"
            >
              {t("editor.exportIncludeComponents", "Include full components")}
            </label>
            <HelpPopover
              content={t(
                "editor.exportIncludeComponentsHelp",
                "This option controls whether the file contains copies of the components used by the agent.\n\nWhen on, it includes HTTP tools, MCP servers, integrations, and knowledge base settings. When off, it stores only their names.\n\nAPI keys are never included, and documents depend on the next option.",
              )}
              label={t(
                "editor.exportIncludeComponents",
                "Include full components",
              )}
            />
          </div>
          <Switch
            id={switchId}
            checked={includeComponents}
            onCheckedChange={(v) => {
              setIncludeComponents(v);
              if (!v) setIncludeDocuments(false);
            }}
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <label
              htmlFor={documentsSwitchId}
              data-clickable="true"
              className="font-medium text-sm text-text-primary"
            >
              {t(
                "editor.exportIncludeDocuments",
                "Include knowledge base documents",
              )}
            </label>
            <HelpPopover
              content={t(
                "editor.exportIncludeDocumentsHelp",
                "This option adds the full text of knowledge base documents to the file.\n\nThis lets the import make those documents searchable by the agent again.\n\nThe file will contain that information and must be treated as sensitive. This option is off by default and requires the components option.",
              )}
              label={t(
                "editor.exportIncludeDocuments",
                "Include knowledge base documents",
              )}
            />
          </div>
          <Switch
            id={documentsSwitchId}
            checked={includeDocuments}
            disabled={!includeComponents}
            onCheckedChange={setIncludeDocuments}
          />
        </div>
        {anyDirty && (
          <p className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-text-primary text-xs">
            {t(
              "editor.exportUnsavedNote",
              "You have unsaved changes. Save first to export the current version, or export the last saved one.",
            )}
          </p>
        )}
      </div>
    </Modal>
  );
}
