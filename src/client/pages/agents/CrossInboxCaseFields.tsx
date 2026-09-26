import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormField, Input, Select, SwitchField } from "@/client/components";
import { api } from "@/client/lib/api";
import {
  CROSS_INBOX_CASE_ATTRIBUTE_KEY_RE,
  destinationIdentity,
} from "@/modules/cross-inbox-case/settings";

// NOTE: Mirrors agent.settings.crossInboxCase (modules/cross-inbox-case/settings). The inbox is kept
// with the instance it was picked from, because an inbox id only means something inside one Chatwoot
// account.
export interface CrossInboxCaseState {
  targetInboxId: string;
  targetInstanceId: string;
  originLabel: string;
  caseAttributeKey: string;
  mergeContacts: boolean;
  resolveOrigin: boolean;
}

export function readCrossInboxCaseState(raw: unknown): CrossInboxCaseState {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const id = (v: unknown) => (typeof v === "number" ? String(v) : "");
  return {
    targetInboxId: id(o.targetInboxId),
    targetInstanceId: id(o.targetInstanceId),
    originLabel: typeof o.originLabel === "string" ? o.originLabel : "",
    caseAttributeKey:
      typeof o.caseAttributeKey === "string" ? o.caseAttributeKey : "",
    mergeContacts: o.mergeContacts === true,
    resolveOrigin: o.resolveOrigin === true,
  };
}

// A key the settings write refuses (the reader would replace it with the default). Shared by the
// field's inline error and the Tools save, which checks it before the grants PUT goes out.
export function invalidCaseAttributeKey(s: CrossInboxCaseState): boolean {
  const key = s.caseAttributeKey.trim();
  return key !== "" && !CROSS_INBOX_CASE_ATTRIBUTE_KEY_RE.test(key);
}

export function serializeCrossInboxCase(
  s: CrossInboxCaseState,
): Record<string, unknown> {
  return {
    targetInboxId: s.targetInboxId ? Number(s.targetInboxId) : null,
    targetInstanceId: s.targetInboxId
      ? Number(s.targetInstanceId) || null
      : null,
    originLabel: s.originLabel.trim() || null,
    ...(s.caseAttributeKey.trim()
      ? { caseAttributeKey: s.caseAttributeKey.trim() }
      : {}),
    mergeContacts: s.mergeContacts,
    resolveOrigin: s.resolveOrigin,
  };
}

type InboxesData = Awaited<
  ReturnType<typeof api.api.v1.chatwoot.inboxes.get>
>["data"];
type Inbox = NonNullable<InboxesData>["inboxes"][number];

const optionValue = (instanceId: string, inboxId: string | number) =>
  `${instanceId}:${inboxId}`;

export function CrossInboxCaseFields({
  value,
  onChange,
}: {
  value: CrossInboxCaseState;
  onChange: (next: CrossInboxCaseState) => void;
}) {
  const { t } = useTranslation();
  const [inboxes, setInboxes] = useState<Inbox[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await api.api.v1.chatwoot.inboxes.get();
        if (!cancelled && data) setInboxes([...data.inboxes]);
      } catch {
        // NOTE: best-effort, the picker falls back to the saved value alone
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Only inboxes that can START a conversation: Instagram, Facebook, Telegram and Line only answer.
  const eligible = inboxes.filter(
    (ib) => destinationIdentity(ib.channelType) !== null,
  );
  const selected = value.targetInboxId
    ? optionValue(value.targetInstanceId, value.targetInboxId)
    : "";
  const savedMissing =
    selected !== "" &&
    !eligible.some(
      (ib) =>
        optionValue(ib.chatwootInstanceId, ib.chatwootInboxId) === selected,
    );
  const label = (ib: Inbox) => {
    const type = ib.channelType ? ib.channelType.replace("Channel::", "") : "";
    return type
      ? `${ib.name} · ${type} #${ib.chatwootInboxId}`
      : `${ib.name} #${ib.chatwootInboxId}`;
  };

  return (
    <>
      <FormField
        label={t("editor.crossInboxCase.inbox", "Destination inbox")}
        description={t(
          "editor.crossInboxCase.inboxHint",
          "The inbox where the case is opened, in the queue of the team.",
        )}
      >
        <Select
          value={selected}
          onChange={(e) => {
            const [instanceId = "", inboxId = ""] = e.target.value.split(":");
            onChange({
              ...value,
              targetInboxId: inboxId,
              targetInstanceId: instanceId,
            });
          }}
        >
          <option value="">
            {t("editor.crossInboxCase.inboxNone", "No inbox (tool off)")}
          </option>
          {eligible.map((ib) => (
            <option
              key={ib.id}
              value={optionValue(ib.chatwootInstanceId, ib.chatwootInboxId)}
            >
              {label(ib)}
            </option>
          ))}
          {savedMissing && (
            <option value={selected}>
              {t("editor.crossInboxCase.inboxSaved", "Saved inbox #{{id}}", {
                id: value.targetInboxId,
              })}
            </option>
          )}
        </Select>
      </FormField>
      {!value.targetInboxId && (
        <p className="text-warning text-xs">
          {t(
            "editor.crossInboxCase.noInbox",
            "Pick a destination inbox: until then the agent is not offered this tool.",
          )}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <SwitchField
          checked={value.resolveOrigin}
          onCheckedChange={(v) => onChange({ ...value, resolveOrigin: v })}
          label={t(
            "editor.crossInboxCase.resolveOrigin",
            "Close the origin conversation once the case is open",
          )}
        />
        <p className="text-text-muted text-xs">
          {t(
            "editor.crossInboxCase.resolveOriginHint",
            "Closed after the reply that tells the customer where the case went, and kept open if they write again first. Never on a failed opening.",
          )}
        </p>
      </div>
      <FormField
        label={t("editor.crossInboxCase.originLabel", "Label on the origin")}
        description={t(
          "editor.crossInboxCase.originLabelHint",
          "Written on the conversation the case came from, once the case is open. Leave empty for none.",
        )}
      >
        <Input
          value={value.originLabel}
          onChange={(e) => onChange({ ...value, originLabel: e.target.value })}
          placeholder="caso-aberto"
        />
      </FormField>
      <FormField
        label={t("editor.crossInboxCase.attributeKey", "Case number attribute")}
        description={t(
          "editor.crossInboxCase.attributeKeyHint",
          "The origin conversation's attribute that receives the case's conversation number. Default: case_conversation_id.",
        )}
        error={
          invalidCaseAttributeKey(value)
            ? t(
                "editor.crossInboxCase.attributeKeyInvalid",
                "Use lowercase letters, digits and _, starting with a letter.",
              )
            : null
        }
      >
        <Input
          value={value.caseAttributeKey}
          onChange={(e) =>
            onChange({ ...value, caseAttributeKey: e.target.value })
          }
          placeholder="case_conversation_id"
        />
      </FormField>
      <div className="flex flex-col gap-1.5">
        <SwitchField
          checked={value.mergeContacts}
          onCheckedChange={(v) => onChange({ ...value, mergeContacts: v })}
          label={t(
            "editor.crossInboxCase.merge",
            "Merge contacts when the email belongs to another one",
          )}
        />
        <p className="text-text-muted text-xs">
          {t(
            "editor.crossInboxCase.mergeHint",
            "Off: the case opens on the contact that already has the email. On: the two become one contact, irreversibly, and the other contact's data reaches this agent.",
          )}
        </p>
      </div>
    </>
  );
}
