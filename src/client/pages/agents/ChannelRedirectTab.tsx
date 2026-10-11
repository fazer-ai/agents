import { Bell, Globe, MessageCircle, Send, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FormField,
  Input,
  Select,
  Switch,
  SwitchField,
  Textarea,
} from "@/client/components";
import { api } from "@/client/lib/api";
import type { RedirectDelayUnit } from "@/modules/channel-redirect/service";
import { Section, SectionNav } from "./SectionNav";
import { TabActionBar } from "./TabActionBar";

// Editor form shape for agent.settings.channelRedirect. Numeric fields are held as strings (like the
// split/serviceWindow forms) and converted on save. Both inboxes (entry + widget) are picked manually
// from the tenant's synced inboxes. Mirrors ChannelRedirectConfig in modules/channel-redirect.
export interface ChannelRedirectFormState {
  enabled: boolean;
  entryInboxId: string; // chatwootInboxId as string; "" = none
  widgetInboxId: number | null; // chatwootInboxId of the picked web-widget inbox; null = none
  redirectMessage: string;
  resendDelayValue: string; // numeric held as string; unit picks the meaning
  resendDelayUnit: RedirectDelayUnit;
  maxResends: string;
  openWidget: boolean;
  cloneWaMessage: boolean;
  chatFollowupEnabled: boolean;
  chatFollowupDelayValue: string;
  chatFollowupDelayUnit: RedirectDelayUnit;
  chatFollowupInstructions: string;
  waFollowupEnabled: boolean;
  waFollowupDelayValue: string;
  waFollowupDelayUnit: RedirectDelayUnit;
  waFollowupMessage: string;
  closingEnabled: boolean;
  closingDelayValue: string;
  closingDelayUnit: RedirectDelayUnit;
  closingMessage: string;
}

// A value + unit delay picker (minutes/hours/days), mirroring the follow-up steps in the Behavior tab.
// Reuses the follow-up unit-label i18n keys so there is one vocabulary for time units across the editor.
function DelayField({
  label,
  description,
  value,
  unit,
  onValueChange,
  onUnitChange,
}: {
  label: string;
  description?: string;
  value: string;
  unit: RedirectDelayUnit;
  onValueChange: (v: string) => void;
  onUnitChange: (u: RedirectDelayUnit) => void;
}) {
  const { t } = useTranslation();
  return (
    <FormField label={label} description={description} group>
      <div className="flex items-stretch gap-2">
        <Input
          type="number"
          min={1}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className="w-24 text-sm"
        />
        <Select
          value={unit}
          onChange={(e) => onUnitChange(e.target.value as RedirectDelayUnit)}
        >
          <option value="minutes">
            {t("editor.followUpMinutes", "Minutes")}
          </option>
          <option value="hours">
            {t("editor.followUpHoursUnit", "Hours")}
          </option>
          <option value="days">{t("editor.followUpDays", "Days")}</option>
        </Select>
      </div>
    </FormField>
  );
}

// Empty-state shown under a picker when no eligible inbox is bound to this agent yet: a one-line
// explanation + a one-click jump to the Channels tab where inboxes are activated for the agent.
function ActivateInChannelsHint({
  text,
  label,
  onGoToChannels,
}: {
  text: string;
  label: string;
  onGoToChannels: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-1">
      <p className="text-text-muted text-xs">{text}</p>
      <button
        type="button"
        onClick={onGoToChannels}
        className="text-accent text-xs underline underline-offset-2"
      >
        {label}
      </button>
    </div>
  );
}

type InboxesData = Awaited<
  ReturnType<typeof api.api.v1.chatwoot.inboxes.get>
>["data"];
type Inbox = NonNullable<InboxesData>["inboxes"][number];

// The redirect message must carry this placeholder — the per-lead website-chat link is interpolated
// into it at send time. Kept as a value (not a JSX literal) so it can be shown inline.
const LINK_TOKEN = "{link}";

function isWhatsappInbox(channelType: string | null | undefined): boolean {
  return !!channelType && channelType.toLowerCase().includes("whatsapp");
}

function isWebWidgetInbox(channelType: string | null | undefined): boolean {
  return !!channelType && channelType.toLowerCase().includes("webwidget");
}

interface ChannelRedirectTabProps {
  channelRedirect: ChannelRedirectFormState;
  setChannelRedirect: React.Dispatch<
    React.SetStateAction<ChannelRedirectFormState>
  >;
  // The edited agent's id (InboxDto.agentId is this same string) — the pickers only offer inboxes
  // already bound to THIS agent, since the redirect gate runs off the entry inbox's bound agent.
  agentId: string;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onOpenPlayground: () => void;
  // Jump to the Channels tab (the empty-state CTA when no eligible inbox is bound to this agent yet).
  onGoToChannels: () => void;
}

// Agent editor "Redirect" tab: configure the WhatsApp → website-chat redirect (agent.settings
// .channelRedirect). Guided, numbered layout that tells the flow's story: receive the lead on
// WhatsApp → auto-reply a no-AI link → serve the conversation in the website chat (no per-message
// WhatsApp cost) → chase idle leads with a cross-channel follow-up.
export function ChannelRedirectTab({
  channelRedirect: cr,
  setChannelRedirect: setCr,
  agentId,
  dirty,
  saving,
  onSave,
  onDiscard,
  onOpenPlayground,
  onGoToChannels,
}: ChannelRedirectTabProps) {
  const { t } = useTranslation();

  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  // Live website_url health of the picked web-widget inbox ("ok" | "recovered" | "invalid" |
  // "missing", or null while unknown), fetched from Chatwoot; drives the misconfig warning below.
  const [widgetHealth, setWidgetHealth] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await api.api.v1.chatwoot.inboxes.get();
        if (!cancelled && data) setInboxes([...data.inboxes]);
      } catch {
        // best-effort: the entry picker falls back to an empty list
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const boundToThis = (ib: Inbox) => ib.agentId === agentId;

  // Both pickers only offer inboxes ALREADY bound to this agent (item 3) and of the right channel
  // (item 2): the redirect gate runs off the entry inbox's bound agent, so an inbox bound elsewhere is
  // dead config. The currently-saved value is always kept visible (even if it no longer qualifies — e.g.
  // it was re-bound to another agent) so the selection never silently vanishes; a warning explains it.
  const withSelected = (
    eligible: Inbox[],
    selected: Inbox | undefined,
  ): Inbox[] =>
    selected && !eligible.some((ib) => ib.id === selected.id)
      ? [...eligible, selected]
      : eligible;

  const selectedEntry = inboxes.find(
    (ib) => String(ib.chatwootInboxId) === cr.entryInboxId,
  );
  const selectedWidget =
    cr.widgetInboxId === null
      ? undefined
      : inboxes.find((ib) => ib.chatwootInboxId === cr.widgetInboxId);

  const entryEligible = inboxes.filter(
    (ib) => isWhatsappInbox(ib.channelType) && boundToThis(ib),
  );
  const widgetEligible = inboxes.filter(
    (ib) => isWebWidgetInbox(ib.channelType) && boundToThis(ib),
  );
  const entryInboxOptions = withSelected(entryEligible, selectedEntry);
  const widgetInboxOptions = withSelected(widgetEligible, selectedWidget);

  // The saved value points at an inbox that no longer qualifies (wrong channel, or bound to another
  // agent / unbound) — surfaced as a warning under the picker.
  const entryNotWhatsapp =
    !!selectedEntry && !isWhatsappInbox(selectedEntry.channelType);
  const entryNotBound = !!selectedEntry && !boundToThis(selectedEntry);
  const widgetNotBound = !!selectedWidget && !boundToThis(selectedWidget);

  const missingLink = cr.enabled && !cr.redirectMessage.includes(LINK_TOKEN);
  // The WhatsApp follow-up re-sends the link, so its message must carry {link} too (when enabled).
  const waMissingLink =
    cr.enabled &&
    cr.waFollowupEnabled &&
    !cr.waFollowupMessage.includes(LINK_TOKEN);
  // Item 4: redirect is on but an inbox is missing → it can't run. A warning, not a hard block: the
  // runtime already no-ops without both inboxes, and the operator may be mid-configuration.
  const missingInbox =
    cr.enabled && (cr.entryInboxId === "" || cr.widgetInboxId === null);

  // Fetch the live health of the picked web-widget inbox's website_url so a missing/invalid domain
  // surfaces here instead of silently degrading to the WhatsApp fallback at redirect time. A
  // scheme-less URL is "recovered" (the runtime repairs it), so only invalid/missing warn.
  const selectedWidgetId = selectedWidget?.id;
  useEffect(() => {
    if (!selectedWidgetId) {
      setWidgetHealth(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await api.api.v1.chatwoot
          .inboxes({ id: selectedWidgetId })
          ["widget-health"].get();
        if (!cancelled) setWidgetHealth(data?.status ?? null);
      } catch {
        if (!cancelled) setWidgetHealth(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedWidgetId]);

  const sections = [
    {
      id: "cr-entry",
      icon: MessageCircle,
      label: t("editor.channelRedirect.navEntry", "Entry (WhatsApp)"),
    },
    {
      id: "cr-widget",
      icon: Globe,
      label: t("editor.channelRedirect.navWidget", "Website chat"),
    },
    {
      id: "cr-message",
      icon: Send,
      label: t("editor.channelRedirect.navMessage", "Redirect message"),
    },
    {
      id: "cr-followup",
      icon: Bell,
      label: t("editor.channelRedirect.navFollowup", "Follow-up"),
    },
  ];

  const inboxLabel = (ib: Inbox) => {
    const type = ib.channelType ? ib.channelType.replace("Channel::", "") : "";
    return type
      ? `${ib.name} · ${type} #${ib.chatwootInboxId}`
      : `${ib.name} #${ib.chatwootInboxId}`;
  };

  return (
    <div className="flex grow flex-col gap-4">
      <div className="flex gap-6">
        <SectionNav sections={sections} />
        <div className="flex min-w-0 grow flex-col gap-4">
          {/* Top: the master switch + the one-paragraph story of the whole flow. */}
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-bg-secondary p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="font-semibold text-base text-text-primary">
                  {t(
                    "editor.channelRedirect.title",
                    "WhatsApp → website chat redirect",
                  )}
                </h2>
                <p className="mt-1 text-sm text-text-muted">
                  {t(
                    "editor.channelRedirect.intro",
                    "Receive the lead on WhatsApp, reply with an automatic link that sends them to your website chat, and handle the conversation there, with no per-message WhatsApp cost.",
                  )}
                </p>
              </div>
              <Switch
                checked={cr.enabled}
                onCheckedChange={(v) => setCr({ ...cr, enabled: v })}
                aria-label={t(
                  "editor.channelRedirect.enabledAria",
                  "Enable the WhatsApp to website-chat redirect",
                )}
              />
            </div>
          </div>

          {/* Item 4: enabled but an inbox is missing → the redirect can't run. Also surfaced as a
              config-health warning at the top of the editor (deep-links back to this tab). */}
          {missingInbox && (
            <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-soft px-3 py-2 text-sm text-warning">
              <TriangleAlert
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              <span>
                {t(
                  "editor.channelRedirect.missingInboxWarning",
                  "Redirect is on but an inbox is missing. It won't run until both the WhatsApp entry inbox and the website-chat inbox are selected below.",
                )}
              </span>
            </div>
          )}

          {/* Step 1 — the OFFICIAL WhatsApp inbox leads arrive on. */}
          <Section
            id="cr-entry"
            icon={MessageCircle}
            title={t(
              "editor.channelRedirect.step1Title",
              "1. Entry (WhatsApp)",
            )}
            description={t(
              "editor.channelRedirect.step1Desc",
              "The WhatsApp inbox where leads first reach you. The redirect only fires for this inbox.",
            )}
          >
            <FormField
              label={t(
                "editor.channelRedirect.entryInbox",
                "WhatsApp entry inbox",
              )}
            >
              <Select
                value={cr.entryInboxId}
                onChange={(e) => setCr({ ...cr, entryInboxId: e.target.value })}
              >
                <option value="">
                  {t("editor.channelRedirect.entryNone", "Select an inbox…")}
                </option>
                {entryInboxOptions.map((ib) => (
                  <option key={ib.id} value={String(ib.chatwootInboxId)}>
                    {inboxLabel(ib)}
                  </option>
                ))}
              </Select>
            </FormField>
            {entryEligible.length === 0 && (
              <ActivateInChannelsHint
                onGoToChannels={onGoToChannels}
                text={t(
                  "editor.channelRedirect.noEntryInbox",
                  "No WhatsApp inbox is activated for this agent yet. Activate it in the Channels tab, then pick it here.",
                )}
                label={t(
                  "editor.channelRedirect.goToChannels",
                  "Go to Channels",
                )}
              />
            )}
            {entryNotBound && (
              <p className="text-warning text-xs">
                {t(
                  "editor.channelRedirect.entryNotBound",
                  "The selected inbox is not activated for this agent (it's bound to another agent, or none). Activate it in Channels, or pick one that is.",
                )}
              </p>
            )}
            {entryNotWhatsapp && (
              <p className="text-warning text-xs">
                {t(
                  "editor.channelRedirect.entryNotWhatsapp",
                  "This channel has no per-message cost, so redirecting it saves nothing. The redirect is meant for the official (paid) WhatsApp.",
                )}
              </p>
            )}
          </Section>

          {/* Step 2 — the Chatwoot web-widget inbox the lead lands on (created manually in Chatwoot). */}
          <Section
            id="cr-widget"
            icon={Globe}
            title={t(
              "editor.channelRedirect.step2Title",
              "2. Website chat (web widget)",
            )}
            description={t(
              "editor.channelRedirect.step2Desc",
              "The Chatwoot web-widget inbox embedded on your site, where the AI serves the conversation. Create it in Chatwoot with its Website URL set, then pick it here.",
            )}
          >
            <FormField
              label={t(
                "editor.channelRedirect.widgetInbox",
                "Website chat inbox",
              )}
              description={t(
                "editor.channelRedirect.widgetInboxHint",
                "Pick the web-widget inbox where redirected leads land. Its Website URL (set in Chatwoot) is where the link points.",
              )}
            >
              <Select
                value={
                  cr.widgetInboxId === null ? "" : String(cr.widgetInboxId)
                }
                onChange={(e) =>
                  setCr({
                    ...cr,
                    widgetInboxId:
                      e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              >
                <option value="">
                  {t("editor.channelRedirect.widgetNone", "Select an inbox…")}
                </option>
                {widgetInboxOptions.map((ib) => (
                  <option key={ib.id} value={String(ib.chatwootInboxId)}>
                    {inboxLabel(ib)}
                  </option>
                ))}
              </Select>
            </FormField>
            {widgetEligible.length === 0 && (
              <ActivateInChannelsHint
                onGoToChannels={onGoToChannels}
                text={t(
                  "editor.channelRedirect.noWidgetInbox",
                  "No website-chat inbox is activated for this agent. Create one in Chatwoot (Inbox → Website) with its Website URL, sync under Channels, then activate it for this agent.",
                )}
                label={t(
                  "editor.channelRedirect.goToChannels",
                  "Go to Channels",
                )}
              />
            )}
            {widgetNotBound && (
              <p className="text-warning text-xs">
                {t(
                  "editor.channelRedirect.widgetNotBound",
                  "The selected inbox is not activated for this agent (it's bound to another agent, or none). Activate it in Channels, or pick one that is.",
                )}
              </p>
            )}
            {(widgetHealth === "invalid" || widgetHealth === "missing") && (
              <p className="flex items-start gap-1.5 text-warning text-xs">
                <TriangleAlert
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  {widgetHealth === "missing"
                    ? t(
                        "editor.channelRedirect.widgetUrlMissing",
                        "This web-widget inbox has no Website URL set in Chatwoot. Set it (e.g. https://your-site.com) so the redirect link can be built.",
                      )
                    : t(
                        "editor.channelRedirect.widgetUrlInvalid",
                        "This inbox's Website URL in Chatwoot isn't a valid address. Fix it (e.g. https://your-site.com) so the redirect works.",
                      )}
                </span>
              </p>
            )}
            {widgetHealth === "unknown" && (
              <p className="text-muted text-xs">
                {t(
                  "editor.channelRedirect.widgetUrlUnknown",
                  "Couldn't reach Chatwoot to verify this inbox's Website URL right now, so it isn't checked here. The redirect still uses whatever is set in Chatwoot.",
                )}
              </p>
            )}
          </Section>

          {/* Step 3 — the no-AI auto-reply that carries the link, plus its knobs. */}
          <Section
            id="cr-message"
            icon={Send}
            title={t(
              "editor.channelRedirect.step3Title",
              "3. Redirect message",
            )}
            description={t(
              "editor.channelRedirect.step3Desc",
              "The automatic reply sent on WhatsApp with the link to the website chat.",
            )}
          >
            <FormField
              label={t(
                "editor.channelRedirect.redirectMessage",
                "Auto-reply message",
              )}
              description={t(
                "editor.channelRedirect.redirectMessageHint",
                "Must contain {{token}}: the per-lead chat link is interpolated there.",
                { token: LINK_TOKEN },
              )}
            >
              <Textarea
                rows={3}
                value={cr.redirectMessage}
                onChange={(e) =>
                  setCr({ ...cr, redirectMessage: e.target.value })
                }
                error={missingLink}
              />
            </FormField>
            {missingLink && (
              <p className="text-error text-xs">
                {t(
                  "editor.channelRedirect.redirectMessageMissingLink",
                  "The message is missing {{token}}, so the lead won't get the chat link.",
                  { token: LINK_TOKEN },
                )}
              </p>
            )}
            <div className="flex flex-col gap-1.5">
              <SwitchField
                checked={cr.openWidget}
                onCheckedChange={(v) => setCr({ ...cr, openWidget: v })}
                label={t(
                  "editor.channelRedirect.openWidget",
                  "Open the chat automatically",
                )}
              />
              <p className="text-text-muted text-xs">
                {t(
                  "editor.channelRedirect.openWidgetHint",
                  "The lead lands on the page with the chat already open.",
                )}
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <SwitchField
                checked={cr.cloneWaMessage}
                onCheckedChange={(v) => setCr({ ...cr, cloneWaMessage: v })}
                label={t(
                  "editor.channelRedirect.cloneWaMessage",
                  "Carry over the WhatsApp message",
                )}
              />
              <p className="text-text-muted text-xs">
                {t(
                  "editor.channelRedirect.cloneWaMessageHint",
                  "The message the lead sent on WhatsApp is sent into the chat, so the agent answers it right away.",
                )}
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <DelayField
                label={t(
                  "editor.channelRedirect.resendDelay",
                  "Resend interval",
                )}
                description={t(
                  "editor.channelRedirect.resendDelayHint",
                  "Minimum wait before the link is sent again if the contact messages on WhatsApp again.",
                )}
                value={cr.resendDelayValue}
                unit={cr.resendDelayUnit}
                onValueChange={(v) => setCr({ ...cr, resendDelayValue: v })}
                onUnitChange={(u) => setCr({ ...cr, resendDelayUnit: u })}
              />
              <FormField
                label={t("editor.channelRedirect.maxResends", "Max resends")}
                description={t(
                  "editor.channelRedirect.maxResendsHint",
                  "How many times the link may be re-sent before going silent. 0-10.",
                )}
              >
                <Input
                  type="number"
                  min={0}
                  max={10}
                  value={cr.maxResends}
                  onChange={(e) => setCr({ ...cr, maxResends: e.target.value })}
                />
              </FormField>
            </div>
          </Section>

          {/* Step 4 — the cross-channel follow-up chain: chat → WhatsApp → closing. */}
          <Section
            id="cr-followup"
            icon={Bell}
            title={t("editor.channelRedirect.step4Title", "4. Follow-up")}
            description={t(
              "editor.channelRedirect.step4Desc",
              "Chase the lead when they go idle after the redirect.",
            )}
          >
            {/* Step 4a — follow up in the website chat. */}
            <div className="flex flex-col gap-4">
              <SwitchField
                checked={cr.chatFollowupEnabled}
                onCheckedChange={(v) =>
                  setCr({ ...cr, chatFollowupEnabled: v })
                }
                label={t(
                  "editor.channelRedirect.chatFollowup",
                  "Follow up in the website chat",
                )}
              />
              {cr.chatFollowupEnabled && (
                <div className="flex flex-col gap-4">
                  <DelayField
                    label={t("editor.channelRedirect.delay", "Delay")}
                    value={cr.chatFollowupDelayValue}
                    unit={cr.chatFollowupDelayUnit}
                    onValueChange={(v) =>
                      setCr({ ...cr, chatFollowupDelayValue: v })
                    }
                    onUnitChange={(u) =>
                      setCr({ ...cr, chatFollowupDelayUnit: u })
                    }
                  />
                  <FormField
                    label={t(
                      "editor.channelRedirect.instructions",
                      "Instructions",
                    )}
                  >
                    <Textarea
                      rows={3}
                      value={cr.chatFollowupInstructions}
                      onChange={(e) =>
                        setCr({
                          ...cr,
                          chatFollowupInstructions: e.target.value,
                        })
                      }
                      placeholder={t(
                        "editor.channelRedirect.chatFollowupPlaceholder",
                        "E.g.: ask if the customer is still interested and offer to help them continue.",
                      )}
                    />
                  </FormField>
                </div>
              )}
            </div>

            {/* Step 4b — re-send the link on WhatsApp if still idle: the crucial recovery. The lead may
                have left the chat, where a chat nudge can't reach them; WhatsApp can. Fixed message, not AI. */}
            <div className="flex flex-col gap-4 border-border border-t pt-4">
              <SwitchField
                checked={cr.waFollowupEnabled}
                onCheckedChange={(v) => setCr({ ...cr, waFollowupEnabled: v })}
                label={t(
                  "editor.channelRedirect.waFollowup",
                  "Re-send the link on WhatsApp",
                )}
              />
              <p className="text-text-muted text-xs">
                {t(
                  "editor.channelRedirect.waFollowupHint",
                  "If the lead goes idle, re-send the chat link on WhatsApp to pull them back, crucial when they left the chat, where a chat follow-up can't reach them.",
                )}
              </p>
              {cr.waFollowupEnabled && (
                <div className="flex flex-col gap-4">
                  <DelayField
                    label={t("editor.channelRedirect.delay", "Delay")}
                    value={cr.waFollowupDelayValue}
                    unit={cr.waFollowupDelayUnit}
                    onValueChange={(v) =>
                      setCr({ ...cr, waFollowupDelayValue: v })
                    }
                    onUnitChange={(u) =>
                      setCr({ ...cr, waFollowupDelayUnit: u })
                    }
                  />
                  <FormField
                    label={t(
                      "editor.channelRedirect.waFollowupMessage",
                      "Message",
                    )}
                    description={t(
                      "editor.channelRedirect.waFollowupMessageHint",
                      "Fixed message sent on WhatsApp, like the redirect message. Must contain {{token}}: the chat link is interpolated there.",
                      { token: LINK_TOKEN },
                    )}
                  >
                    <Textarea
                      rows={3}
                      value={cr.waFollowupMessage}
                      onChange={(e) =>
                        setCr({ ...cr, waFollowupMessage: e.target.value })
                      }
                      error={waMissingLink}
                    />
                  </FormField>
                  {waMissingLink && (
                    <p className="text-error text-xs">
                      {t(
                        "editor.channelRedirect.waFollowupMissingLink",
                        "The message is missing {{token}}, so the lead won't get the chat link.",
                        { token: LINK_TOKEN },
                      )}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Step 4c — fixed closing message on both the chat + WhatsApp before resolving. */}
            <div className="flex flex-col gap-4 border-border border-t pt-4">
              <SwitchField
                checked={cr.closingEnabled}
                onCheckedChange={(v) => setCr({ ...cr, closingEnabled: v })}
                label={t(
                  "editor.channelRedirect.closing",
                  "Closing message (chat + WhatsApp)",
                )}
              />
              <p className="text-text-muted text-xs">
                {t(
                  "editor.channelRedirect.closingHint",
                  "Sent on both the website chat and WhatsApp as the last step if the lead is still idle after the WhatsApp escalation, and when the conversation is resolved. Delivered at most once.",
                )}
              </p>
              {cr.closingEnabled && (
                <div className="flex flex-col gap-4">
                  <DelayField
                    label={t(
                      "editor.channelRedirect.closingDelay",
                      "Delay after the WhatsApp step",
                    )}
                    value={cr.closingDelayValue}
                    unit={cr.closingDelayUnit}
                    onValueChange={(v) =>
                      setCr({ ...cr, closingDelayValue: v })
                    }
                    onUnitChange={(u) => setCr({ ...cr, closingDelayUnit: u })}
                  />
                  <FormField
                    label={t(
                      "editor.channelRedirect.closingMessage",
                      "Message",
                    )}
                    description={t(
                      "editor.channelRedirect.closingMessageHint",
                      "Fixed goodbye, sent verbatim on both channels (not AI-generated).",
                    )}
                  >
                    <Textarea
                      rows={3}
                      value={cr.closingMessage}
                      onChange={(e) =>
                        setCr({ ...cr, closingMessage: e.target.value })
                      }
                    />
                  </FormField>
                </div>
              )}
            </div>

            <p className="text-text-muted text-xs">
              {t(
                "editor.channelRedirect.serviceWindowNote",
                "WhatsApp messages sent outside the 24h window use the template set in Behavior → WhatsApp 24h window.",
              )}
            </p>
          </Section>
        </div>
      </div>

      <TabActionBar
        dirty={dirty}
        saving={saving}
        onSave={onSave}
        onDiscard={onDiscard}
        saveDisabled={missingLink || waMissingLink}
        onOpenPlayground={onOpenPlayground}
      />
    </div>
  );
}
