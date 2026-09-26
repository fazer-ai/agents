import { useTranslation } from "react-i18next";
import { ComboBox } from "@/client/components";

export type InboxLabelOption = { title: string; color: string | null };

// Multi-select label picker, shared by a follow-up step's "assign label" action (item 4) and the
// labels open_case_in_inbox puts on every case (issue #901): one ComboBox over the agent inbox's
// known labels (with their Chatwoot color), where the operator picks any number of labels and can
// still type one that doesn't exist yet. When the agent spans more than one Chatwoot
// account (item 5) the label set can't be listed coherently, so it shows a warning and stays free-text.
export function LabelPicker({
  values,
  onChange,
  labels,
  multiAccount,
  ariaLabel,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  labels: InboxLabelOption[];
  multiAccount: boolean;
  ariaLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <ComboBox
        multiple
        values={values}
        onChange={onChange}
        items={labels.map((l) => ({
          id: l.title,
          color: l.color ?? undefined,
        }))}
        placeholder={t("editor.followUpLabelPlaceholder", "Add a label…")}
        searchPlaceholder={t("editor.followUpLabelSearch", "Search labels…")}
        aria-label={ariaLabel}
      />
      {multiAccount && (
        <span className="text-text-muted text-xs">
          {t(
            "editor.followUpLabelMultiAccount",
            "This agent serves more than one Chatwoot account, so labels can't be listed. Type each label exactly as it appears.",
          )}
        </span>
      )}
    </div>
  );
}
