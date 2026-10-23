import { useTranslation } from "react-i18next";
import type { api } from "@/client/lib/api";

export type InboxOption = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.chatwoot.inboxes.get>>["data"]
>["inboxes"][number];

// Whether the product receives an inbox's conversations: a responder bound to it, or an observer
// watching it. The monitor reads only what the product receives.
export const inboxReceived = (i: InboxOption) =>
  i.agentId !== null || i.observerAgentIds.length > 0;

// The inboxes the monitor reads, by name. An inbox no agent receives cannot be picked (the save would
// refuse it); one already on the list that lost its agent stays checked and says it reads nothing.
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
  return (
    <ul className="flex flex-col gap-1.5">
      {inboxes.map((i) => {
        const received = inboxReceived(i);
        const on = chosen.has(i.id);
        return (
          <li key={i.id}>
            <label
              className={`flex items-start gap-2 text-sm ${received || on ? "text-text-primary" : "text-text-muted"}`}
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={on}
                disabled={!received && !on}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...value, i.id]
                      : value.filter((id) => id !== i.id),
                  )
                }
              />
              <span className="flex flex-col">
                <span>{i.name}</span>
                {!received && (
                  <span className="text-text-muted text-xs">
                    {on
                      ? t(
                          "occurrences.inboxes.lostAgent",
                          "No agent receives this inbox any more, so the monitor reads nothing from it. Bind or observe it with an agent in Channels.",
                        )
                      : t(
                          "occurrences.inboxes.unreceived",
                          "No agent receives this inbox. Bind or observe it with an agent in Channels to monitor it.",
                        )}
                  </span>
                )}
              </span>
            </label>
          </li>
        );
      })}
      {gone.map((id) => (
        <li key={id}>
          <label className="flex items-start gap-2 text-sm text-text-muted">
            <input
              type="checkbox"
              className="mt-1"
              checked
              onChange={() => onChange(value.filter((x) => x !== id))}
            />
            <span>
              {t(
                "occurrences.inboxes.removed",
                "An inbox removed from this account",
              )}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
