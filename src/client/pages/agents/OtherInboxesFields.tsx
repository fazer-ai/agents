import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ComboBox, FormField, Input, SwitchField } from "@/client/components";
import { api } from "@/client/lib/api";
import {
  OTHER_INBOXES_LIMITS,
  OTHER_INBOXES_MAX_INBOXES,
  readOtherInboxesConfig,
} from "@/modules/other-inboxes/settings";

// Mirrors agent.settings.otherInboxes (modules/other-inboxes/settings). Each inbox is kept as
// `<our instance id>:<chatwoot inbox id>`, because an inbox id only means something inside one
// Chatwoot account. The numbers stay text while edited, so a half-typed value is not snapped.
export interface OtherInboxesState {
  enabled: boolean;
  inboxes: string[];
  maxConversations: string;
  lookbackDays: string;
  fullTranscriptMaxChars: string;
}

export function readOtherInboxesState(settings: unknown): OtherInboxesState {
  const cfg = readOtherInboxesConfig(settings);
  return {
    enabled: cfg.enabled,
    inboxes: cfg.inboxes.map((i) => `${i.instanceId}:${i.inboxId}`),
    maxConversations: String(cfg.maxConversations),
    lookbackDays: String(cfg.lookbackDays),
    fullTranscriptMaxChars: String(cfg.fullTranscriptMaxChars),
  };
}

// What the save writes. A number outside its range goes as typed while the switch is on, where the
// field shows it and `otherInboxesBlocksSave` holds Save; with the switch off the numbers are not on
// screen, so one out of range is left out and the reader answers it with its default.
export function otherInboxesToStored(s: OtherInboxesState) {
  const number = (key: keyof typeof OTHER_INBOXES_LIMITS) =>
    s.enabled || !outOfRange(s[key], OTHER_INBOXES_LIMITS[key])
      ? { [key]: Number(s[key]) }
      : {};
  return {
    enabled: s.enabled,
    // Past the server's cap the switch-on field says so and holds Save; switched off, the list is not
    // on screen, so the excess is left out rather than refusing a save nobody can see the reason for.
    inboxes: s.inboxes
      .filter((_, i) => s.enabled || i < OTHER_INBOXES_MAX_INBOXES)
      .flatMap((v) => {
        const [instanceId, inboxId] = v.split(":").map(Number);
        return Number.isInteger(instanceId) && Number.isInteger(inboxId)
          ? [{ instanceId: instanceId as number, inboxId: inboxId as number }]
          : [];
      }),
    ...number("maxConversations"),
    ...number("lookbackDays"),
    ...number("fullTranscriptMaxChars"),
  };
}

// The settings patch for this block. A watcher's editor hides the card, so its save keeps the stored
// block rather than writing a draft nobody can see or correct.
export function otherInboxesPatch(
  s: OtherInboxesState,
  watcher: boolean,
): { otherInboxes?: ReturnType<typeof otherInboxesToStored> } {
  return watcher ? {} : { otherInboxes: otherInboxesToStored(s) };
}

// Save is held while a number on screen is out of range: only where the card is drawn and switched on.
export function otherInboxesBlocksSave(
  s: OtherInboxesState,
  mode: string,
): boolean {
  return (
    mode !== "monitoring" &&
    s.enabled &&
    (s.inboxes.length > OTHER_INBOXES_MAX_INBOXES ||
      (
        Object.keys(
          OTHER_INBOXES_LIMITS,
        ) as (keyof typeof OTHER_INBOXES_LIMITS)[]
      ).some((key) => outOfRange(s[key], OTHER_INBOXES_LIMITS[key])))
  );
}

type Limit = { min: number; max: number };

export function outOfRange(value: string, limit: Limit): boolean {
  const n = Number(value);
  return !Number.isInteger(n) || n < limit.min || n > limit.max;
}

type Inbox = {
  id: string;
  name: string;
  channelType: string | null;
  chatwootInboxId: number;
  chatwootInstanceId: string;
};

export function OtherInboxesFields({
  value,
  onChange,
}: {
  value: OtherInboxesState;
  onChange: (next: OtherInboxesState) => void;
}) {
  const { t } = useTranslation();
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  // Account names by our instance id. Two accounts can each hold an inbox with the same name, channel
  // and number, so with more than one the account goes into every option and chip.
  const [accounts, setAccounts] = useState<
    { id: string; accountId: number; accountName: string | null }[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [{ data }, dep] = await Promise.all([
          api.api.v1.chatwoot.inboxes.get(),
          api.api.v1.chatwoot.deployment.get(),
        ]);
        if (!cancelled && Array.isArray(dep.data?.accounts)) {
          setAccounts(
            dep.data.accounts.map((a) => ({
              id: String(a.id),
              accountId: a.accountId,
              accountName: a.accountName,
            })),
          );
        }
        if (!cancelled && data) {
          setInboxes(
            data.inboxes.map((ib) => ({
              id: String(ib.id),
              name: ib.name,
              channelType: ib.channelType,
              chatwootInboxId: ib.chatwootInboxId,
              chatwootInstanceId: String(ib.chatwootInstanceId),
            })),
          );
        }
      } catch {
        // NOTE: best-effort, the picker still shows the saved inboxes by number
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const items = inboxes.map((ib) => {
    const type = ib.channelType ? ib.channelType.replace("Channel::", "") : "";
    const owner =
      accounts.length > 1
        ? accounts.find((a) => a.id === ib.chatwootInstanceId)
        : undefined;
    const account = owner
      ? (owner.accountName ??
        t("channels.account", "Account {{id}}", { id: owner.accountId }))
      : undefined;
    return {
      id: `${ib.chatwootInstanceId}:${ib.chatwootInboxId}`,
      label: account ? `${ib.name} · ${account}` : ib.name,
      hint: type ? `${type} #${ib.chatwootInboxId}` : `#${ib.chatwootInboxId}`,
    };
  });
  const rangeError = (v: string, limit: Limit) =>
    outOfRange(v, limit)
      ? t("editor.otherInboxes.range", "Between {{min}} and {{max}}.", {
          min: limit.min,
          max: limit.max,
        })
      : null;

  return (
    <div className="flex flex-col gap-4">
      <SwitchField
        checked={value.enabled}
        onCheckedChange={(enabled) => onChange({ ...value, enabled })}
        label={t(
          "editor.otherInboxes.enabled",
          "Read this contact's conversations in other inboxes",
        )}
      />
      {value.enabled && (
        <>
          <FormField
            group
            label={t("editor.otherInboxes.inboxes", "Inboxes the agent reads")}
            description={t(
              "editor.otherInboxes.inboxesHint",
              "Only these inboxes are read. With none picked, nothing is read.",
            )}
            error={
              value.inboxes.length > OTHER_INBOXES_MAX_INBOXES
                ? t(
                    "editor.otherInboxes.tooManyInboxes",
                    "At most {{max}} inboxes. Remove {{extra}} to save.",
                    {
                      max: OTHER_INBOXES_MAX_INBOXES,
                      extra: value.inboxes.length - OTHER_INBOXES_MAX_INBOXES,
                    },
                  )
                : undefined
            }
          >
            <ComboBox
              multiple
              allowCustom={false}
              values={value.inboxes}
              onChange={(inboxIds) => onChange({ ...value, inboxes: inboxIds })}
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
                "editor.otherInboxes.inboxes",
                "Inboxes the agent reads",
              )}
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              label={t(
                "editor.otherInboxes.maxConversations",
                "Conversations at most",
              )}
              description={t(
                "editor.otherInboxes.maxConversationsHint",
                "The most recent first.",
              )}
              error={rangeError(
                value.maxConversations,
                OTHER_INBOXES_LIMITS.maxConversations,
              )}
            >
              <Input
                type="number"
                min={OTHER_INBOXES_LIMITS.maxConversations.min}
                max={OTHER_INBOXES_LIMITS.maxConversations.max}
                value={value.maxConversations}
                onChange={(e) =>
                  onChange({ ...value, maxConversations: e.target.value })
                }
              />
            </FormField>
            <FormField
              label={t("editor.otherInboxes.lookbackDays", "Last days")}
              description={t(
                "editor.otherInboxes.lookbackDaysHint",
                "Conversations with activity in this many days.",
              )}
              error={rangeError(
                value.lookbackDays,
                OTHER_INBOXES_LIMITS.lookbackDays,
              )}
            >
              <Input
                type="number"
                min={OTHER_INBOXES_LIMITS.lookbackDays.min}
                max={OTHER_INBOXES_LIMITS.lookbackDays.max}
                value={value.lookbackDays}
                onChange={(e) =>
                  onChange({ ...value, lookbackDays: e.target.value })
                }
              />
            </FormField>
            <FormField
              label={t(
                "editor.otherInboxes.fullTranscriptMaxChars",
                "Whole up to (characters)",
              )}
              description={t(
                "editor.otherInboxes.fullTranscriptMaxCharsHint",
                "Longer conversations go as a summary.",
              )}
              error={rangeError(
                value.fullTranscriptMaxChars,
                OTHER_INBOXES_LIMITS.fullTranscriptMaxChars,
              )}
            >
              <Input
                type="number"
                min={OTHER_INBOXES_LIMITS.fullTranscriptMaxChars.min}
                max={OTHER_INBOXES_LIMITS.fullTranscriptMaxChars.max}
                value={value.fullTranscriptMaxChars}
                onChange={(e) =>
                  onChange({
                    ...value,
                    fullTranscriptMaxChars: e.target.value,
                  })
                }
              />
            </FormField>
          </div>
        </>
      )}
    </div>
  );
}
