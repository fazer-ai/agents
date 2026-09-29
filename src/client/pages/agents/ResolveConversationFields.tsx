import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormField } from "@/client/components";
import { api } from "@/client/lib/api";
import { normalizeResolveLabels } from "@/modules/agents/resolve-labels";
import { type InboxLabelOption, LabelPicker } from "./LabelPicker";

// Mirrors agent.settings.resolveConversation (modules/agents/resolve-labels): the
// labels resolve_conversation writes itself before it closes.
export interface ResolveConversationState {
  assignLabels: string[];
}

export function readResolveConversationState(
  raw: unknown,
): ResolveConversationState {
  const o =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return { assignLabels: normalizeResolveLabels(o.assignLabels) };
}

export function serializeResolveConversation(state: ResolveConversationState): {
  assignLabels: string[];
} {
  return { assignLabels: normalizeResolveLabels(state.assignLabels) };
}

export function ResolveConversationFields({
  agentId,
  value,
  onChange,
}: {
  agentId: string;
  value: ResolveConversationState;
  onChange: (next: ResolveConversationState) => void;
}) {
  const { t } = useTranslation();
  const [labels, setLabels] = useState<InboxLabelOption[]>([]);
  const [multiAccount, setMultiAccount] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLabels([]);
    setMultiAccount(false);
    void (async () => {
      try {
        const { data } = await api.api.v1.chatwoot.labels({ agentId }).get();
        if (!cancelled && data) {
          setLabels(data.labels);
          setMultiAccount(data.accountCount > 1);
        }
      } catch {
        // NOTE: best-effort, the picker still takes a typed label
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  return (
    <FormField
      label={t("editor.resolveLabels", "Labels on close")}
      group
      description={t(
        "editor.resolveLabelsHint",
        "Added before this tool closes a conversation, labelled by the agent or not. Held off while the contact waits on an open case. A label the account lacks is left off and reported.",
      )}
    >
      <LabelPicker
        values={value.assignLabels}
        onChange={(v) => onChange({ assignLabels: v })}
        labels={labels}
        multiAccount={multiAccount}
        ariaLabel={t("editor.resolveLabels", "Labels on close")}
      />
    </FormField>
  );
}
