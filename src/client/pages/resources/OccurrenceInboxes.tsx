import { useTranslation } from "react-i18next";
import { ComboBox } from "@/client/components";
import type { api } from "@/client/lib/api";
import { inboxOptionLabel } from "@/client/lib/inboxOption";

export type InboxOption = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.chatwoot.inboxes.get>>["data"]
>["inboxes"][number] & {
  // Only on an inbox whose name another inbox of the workspace also has, as the filter options give it.
  account?: { id: number; name: string | null };
};

// Whether the product receives an inbox's conversations: a responder bound to it, or an observer
// watching it. The monitor reads only what the product receives.
export const inboxReceived = (i: InboxOption) =>
  i.agentId !== null || i.observerAgentIds.length > 0;

// The inboxes the monitor reads, in the picker the agent editor uses for "Other inboxes". An inbox no
// agent receives is not offered (the save would refuse it), and one line counts them; one already
// chosen that lost its agent stays as a chip marked as not read, and is removed like any other.
export function OccurrenceInboxesSection({
  inboxes,
  value,
  onChange,
}: {
  inboxes: InboxOption[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const { t } = useTranslation();
  const chosen = new Set(value);
  // An id on the list the account no longer has (the inbox was removed): shown so it can be taken off.
  const gone = value.filter((id) => !inboxes.some((i) => i.id === id));
  if (inboxes.length === 0 && gone.length === 0)
    return (
      <p className="text-sm text-text-muted">
        {t(
          "occurrences.inboxes.none",
          "This account has no inboxes yet. Connect a Chatwoot account in Channels first.",
        )}
      </p>
    );
  const notRead = t("occurrences.inboxes.notRead", "not read");
  const items = [
    // One no agent receives is named (a chip if it is chosen) but never offered.
    ...inboxes.map((i) => ({
      id: i.id,
      label: inboxOptionLabel(i, t),
      hint: "",
      ...(inboxReceived(i) ? {} : { unlisted: true, note: notRead }),
    })),
    ...gone.map((id) => ({
      id,
      label: t(
        "occurrences.inboxes.removed",
        "An inbox removed from this account",
      ),
      hint: "",
      unlisted: true,
    })),
  ];
  const leftOut = inboxes.filter(
    (i) => !inboxReceived(i) && !chosen.has(i.id),
  ).length;
  const lost = inboxes.some((i) => chosen.has(i.id) && !inboxReceived(i));
  return (
    <div className="flex flex-col gap-1.5">
      <ComboBox
        multiple
        allowCustom={false}
        values={value}
        onChange={onChange}
        items={items}
        placeholder={t(
          "editor.otherInboxes.inboxesPlaceholder",
          "Add an inbox…",
        )}
        searchPlaceholder={t(
          "editor.otherInboxes.inboxesSearch",
          "Search inboxes…",
        )}
        aria-label={t(
          "occurrences.inboxes.picker",
          "Inboxes the monitor reads",
        )}
      />
      {lost && (
        <p className="text-text-muted text-xs">
          {t(
            "occurrences.inboxes.lostAgentChips",
            "No agent receives the inboxes marked as not read any more, so the monitor reads nothing from them. Bind or observe them with an agent in Channels, or remove them.",
          )}
        </p>
      )}
      {leftOut > 0 && (
        <p className="text-text-muted text-xs">
          {t(
            "occurrences.inboxes.leftOut",
            "{{count}} inboxes no agent receives are not listed. Bind or observe them with an agent in Channels to monitor them.",
            { count: leftOut },
          )}
        </p>
      )}
    </div>
  );
}
