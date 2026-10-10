import { useTranslation } from "react-i18next";
import { ComboBox } from "@/client/components";

export type InboxLabelOption = { title: string; color: string | null };

// Label picker, shared by a follow-up step's "assign label" action, the labels open_case_in_inbox
// puts on every case (both multi-select) and the label that picks a snoozed follow-up cadence (one
// label, `single`): one ComboBox over the agent inbox's known labels (with their Chatwoot color),
// where the operator picks from the list and can still type a new one. When the agent spans more than
// one Chatwoot account the label set can't be listed coherently, so it shows a warning and stays
// free-text.
type LabelPickerProps = {
  labels: InboxLabelOption[];
  multiAccount: boolean;
  ariaLabel: string;
  placeholder?: string;
} & (
  | { single?: false; values: string[]; onChange: (v: string[]) => void }
  | { single: true; value: string; onChange: (v: string) => void }
);

export function LabelPicker(props: LabelPickerProps) {
  const { labels, multiAccount, ariaLabel } = props;
  const { t } = useTranslation();
  const items = labels.map((l) => ({
    id: l.title,
    color: l.color ?? undefined,
  }));
  const placeholder =
    props.placeholder ?? t("editor.followUpLabelPlaceholder", "Add a label…");
  const searchPlaceholder = t("editor.followUpLabelSearch", "Search labels…");
  return (
    <div className="flex flex-col gap-1.5">
      {props.single ? (
        <ComboBox
          value={props.value}
          onChange={props.onChange}
          items={items}
          placeholder={placeholder}
          searchPlaceholder={searchPlaceholder}
          aria-label={ariaLabel}
        />
      ) : (
        <ComboBox
          multiple
          values={props.values}
          onChange={props.onChange}
          items={items}
          placeholder={placeholder}
          searchPlaceholder={searchPlaceholder}
          aria-label={ariaLabel}
        />
      )}
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
