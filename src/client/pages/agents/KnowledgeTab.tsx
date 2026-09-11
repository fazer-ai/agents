import { useTranslation } from "react-i18next";
import { KnowledgeGrantsEditor } from "./KnowledgeGrantsEditor";
import { TabActionBar } from "./TabActionBar";
import type { GrantState, ToolCatalog } from "./types";

interface KnowledgeTabProps {
  catalog: ToolCatalog;
  grants: GrantState[];
  onChange: React.Dispatch<React.SetStateAction<GrantState[]>>;
  onCatalogChange: () => void | Promise<void>;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  // Absent for a WATCHER, for the reason ToolsTab states.
  onOpenPlayground?: () => void;
}

export function KnowledgeTab({
  catalog,
  grants,
  onChange,
  onCatalogChange,
  dirty,
  saving,
  onSave,
  onDiscard,
  onOpenPlayground,
}: KnowledgeTabProps) {
  const { t } = useTranslation();

  return (
    <div className="flex grow flex-col gap-4">
      <KnowledgeGrantsEditor
        catalog={catalog}
        grants={grants}
        onChange={onChange}
        onCatalogChange={onCatalogChange}
      />
      <TabActionBar
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onDiscard={onDiscard}
        saveLabel={t("editor.saveKnowledge", "Save knowledge")}
        onOpenPlayground={onOpenPlayground}
      />
    </div>
  );
}
