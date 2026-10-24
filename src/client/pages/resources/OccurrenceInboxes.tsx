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

// Another monitor of the account, as the list gives it: an inbox it also reads is marked here.
export type OtherMonitor = { id: string; name: string; inboxIds: string[] };

// Whether the product receives an inbox's conversations: a responder bound to it, or an observer
// watching it. The monitor reads only what the product receives.
export const inboxReceived = (i: InboxOption) =>
  i.agentId !== null || i.observerAgentIds.length > 0;

// The inboxes the monitor reads, in the picker the agent editor uses for "Other inboxes". An inbox no
// agent receives is not offered (the save would refuse it), and one line counts them; one already
// chosen that lost its agent stays as a chip marked as not read, and is removed like any other. An
// inbox another monitor also reads says which, on its chip and in the list: each monitor reads it and
// pays for its own reading.
export function OccurrenceInboxesSection({
  inboxes,
  value,
  onChange,
  otherMonitors = [],
}: {
  inboxes: InboxOption[];
  value: string[];
  onChange: (v: string[]) => void;
  otherMonitors?: OtherMonitor[];
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
  const alsoReadBy = (id: string) => {
    const names = otherMonitors
      .filter((m) => m.inboxIds.includes(id))
      .map((m) => m.name);
    return names.length === 0
      ? null
      : t("occurrences.inboxes.alsoReadBy", "also read by {{names}}", {
          names: names.join(", "),
        });
  };
  const items = [
    // One no agent receives is named (a chip if it is chosen) but never offered.
    ...inboxes.map((i) => {
      const shared = alsoReadBy(i.id);
      return {
        id: i.id,
        label: inboxOptionLabel(i, t),
        hint: shared ?? "",
        ...(inboxReceived(i)
          ? shared
            ? { note: shared }
            : {}
          : { unlisted: true, note: notRead }),
      };
    }),
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
  const shared = value.some((id) => alsoReadBy(id) !== null);
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
      {shared && (
        <p className="text-text-muted text-xs">
          {t(
            "occurrences.inboxes.sharedHelp",
            "An inbox marked as also read by another monitor is read by each of them on its own: each one keeps its own themes and pays for its own reading.",
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
