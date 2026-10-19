// A voice agent's Channels tab: the WhatsApp inboxes whose calls it answers. Same look as
// the text agent's tab, and the same immediacy (no Save: the switch writes the binding and Chatwoot at
// once), but the binding is the inbox's calls, beside whichever agent answers its messages. An inbox
// carries one voice agent, so switching one on here takes the calls from the agent that had them.

import { Inbox as InboxIcon, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  EmptyState,
  InboxRow,
  Switch,
  useModalController,
  useToast,
} from "@/client/components";
import { ServiceLogo } from "@/client/components/icons/ServiceLogo";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { takesCalls } from "@/modules/voice-call/channel";

type DeploymentData = Awaited<
  ReturnType<typeof api.api.v1.chatwoot.deployment.get>
>["data"];
type Instance = NonNullable<DeploymentData>["accounts"][number];
type InboxesData = Awaited<
  ReturnType<typeof api.api.v1.chatwoot.inboxes.get>
>["data"];
type Inbox = NonNullable<InboxesData>["inboxes"][number];
type AgentsData = Awaited<ReturnType<typeof api.api.v1.agents.get>>["data"];
type AgentLite = NonNullable<AgentsData>["agents"][number];

export function VoiceChannelsTab({
  agentId,
  testMode,
  disabled,
}: {
  agentId: string;
  /** The SAVED mode is test: an inbox marked here keeps ringing the team until the agent goes live. */
  testMode: boolean;
  /** The SAVED agent is turned off: an inbox marked here keeps ringing the team until it is on. */
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const confirm = useModalController<ConfirmPayload>();
  const [instances, setInstances] = useState<Instance[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [dep, inb, ag] = await Promise.all([
        api.api.v1.chatwoot.deployment.get(),
        api.api.v1.chatwoot.inboxes.get(),
        api.api.v1.agents.get({ query: { pageSize: 100 } }),
      ]);
      if (dep.error || !dep.data) throw dep.error;
      // Required as the deployment is: without it the tab would say there is no WhatsApp inbox, or
      // keep switches a failed binding left out of step with what the server saved.
      if (inb.error || !inb.data) throw inb.error;
      setInstances([...dep.data.accounts]);
      setBaseUrl(dep.data.deployment?.baseUrl ?? "");
      setInboxes([...inb.data.inboxes]);
      if (ag.data) setAgents([...ag.data.agents]);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function bind(ib: Inbox, on: boolean) {
    setPending(ib.id);
    try {
      const { data, error: err } = await api.api.v1.chatwoot
        .inboxes({ id: ib.id })
        ["voice-agent"].put({ agentId: on ? agentId : null });
      if (err || !data) throw err;
      setInboxes((prev) =>
        prev.map((x) =>
          x.id === ib.id ? { ...x, voiceAgentId: data.voiceAgentId } : x,
        ),
      );
      showToast(
        on
          ? t(
              "editor.voiceChannels.bound",
              "This agent now answers the calls of {{inbox}}.",
              {
                inbox: ib.name,
              },
            )
          : t(
              "editor.voiceChannels.unbound",
              "Calls to {{inbox}} ring your team again.",
              {
                inbox: ib.name,
              },
            ),
        "success",
      );
    } catch (e) {
      // A 502 saved the binding and only missed Chatwoot: the list shows what is stored.
      void load();
      showToast(
        apiErrorMessage(e) ||
          t(
            "editor.voiceChannels.error",
            "Could not change the inbox's calls.",
          ),
        "error",
      );
    } finally {
      setPending(null);
    }
  }

  function onToggle(ib: Inbox, on: boolean, otherName: string | null) {
    if (on && otherName) {
      confirm.open({
        title: t("editor.voiceChannels.replaceTitle", "Take over the calls?"),
        message: disabled
          ? t(
              "editor.voiceChannels.replaceMessageOff",
              "{{other}} stops answering the calls of {{inbox}}. This agent is turned off, so until it is turned on the inbox's calls ring your team.",
              { other: otherName, inbox: ib.name },
            )
          : testMode
            ? t(
                "editor.voiceChannels.replaceMessageTest",
                "{{other}} answers the calls of {{inbox}} now and stops. This agent is in test mode, so until it goes to production the inbox's calls ring your team.",
                { other: otherName, inbox: ib.name },
              )
            : t(
                "editor.voiceChannels.replaceMessage",
                "{{other}} answers the calls of {{inbox}} now. Only one agent answers an inbox's calls, so it stops.",
                { other: otherName, inbox: ib.name },
              ),
        onConfirm: () => bind(ib, true),
      });
      return;
    }
    void bind(ib, on);
  }

  const accountLabel = (inst: Instance) =>
    inst.accountName ??
    t("channels.account", "Account {{id}}", { id: inst.accountId });
  // Only the inboxes that can take calls: WhatsApp on the connector (the fork refuses the others).
  // One already bound to this agent stays, to be turned off: its provider may have turned out to take
  // no calls after the binding, and the binding keeps the agent from being deleted.
  const whatsapp = inboxes.filter(
    (ib) => takesCalls(ib) || ib.voiceAgentId === agentId,
  );
  const groups = instances
    .map((inst) => ({
      inst,
      items: whatsapp.filter((ib) => ib.chatwootInstanceId === inst.id),
    }))
    .filter((g) => g.items.length > 0);
  const showInstanceHeaders = groups.length > 1;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="flex items-center gap-2 font-medium text-text-primary">
          <InboxIcon className="h-4 w-4 text-accent" aria-hidden="true" />
          {t("editor.voiceChannels.title", "Inboxes")}
        </h2>
        <p className="mt-0.5 text-text-muted text-xs">
          {t(
            "editor.voiceChannels.desc",
            "Choose the WhatsApp inboxes whose calls this agent answers. The agent answering their messages stays as it is. A change applies at once.",
          )}
        </p>
      </div>
      <p
        className={
          disabled || testMode
            ? "rounded-md bg-warning/10 px-3 py-2 text-warning text-xs"
            : "rounded-md bg-success/10 px-3 py-2 text-success text-xs"
        }
      >
        {disabled
          ? t(
              "editor.voiceChannels.off",
              "This agent is turned off: in the inboxes marked here, calls ring your team until it is turned on.",
            )
          : testMode
            ? t(
                "editor.voiceChannels.testMode",
                "This agent is in test mode: in the inboxes marked here, calls ring your team until it goes to production on General.",
              )
            : t(
                "editor.voiceChannels.production",
                "This agent is in production: it answers the calls to the inboxes marked here.",
              )}
      </p>

      <DataBoundary loading={loading} error={error} onRetry={load}>
        {instances.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon={InboxIcon}
              title={t("editor.channels.noInstance", "No Chatwoot connected")}
              description={t(
                "editor.channels.noInstanceDesc",
                "Connect a Chatwoot instance under Channels, then come back to bind this agent to its inboxes.",
              )}
              action={
                <Button onClick={() => navigate("/channels")}>
                  {t("editor.channels.goToChannels", "Go to Channels")}
                </Button>
              }
            />
          </Card>
        ) : groups.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon={InboxIcon}
              title={t(
                "editor.voiceChannels.empty",
                "No WhatsApp inbox to take calls",
              )}
              description={t(
                "editor.voiceChannels.emptyDesc",
                "Calls come through WhatsApp inboxes connected by the fazer.ai WhatsApp connector. Connect one, sync the inboxes, and it shows up here.",
              )}
              action={
                <Button onClick={() => navigate("/channels")}>
                  {t("editor.channels.goToChannels", "Go to Channels")}
                </Button>
              }
            />
          </Card>
        ) : (
          groups.map(({ inst, items }) => {
            const disconnected = inst.disconnectedAt !== null;
            return (
              <div key={inst.id} className="flex flex-col gap-1.5">
                {showInstanceHeaders && (
                  <div className="flex items-center gap-1.5 px-1 text-text-muted text-xs">
                    <ServiceLogo
                      service="chatwoot"
                      className="h-3.5 w-3.5 shrink-0"
                    />
                    <span className="truncate">{accountLabel(inst)}</span>
                    {disconnected && (
                      <Badge variant="warning">
                        {t("channels.disconnectedBadge", "Disconnected")}
                      </Badge>
                    )}
                  </div>
                )}
                <Card className="p-0">
                  <ul>
                    {items.map((ib) => {
                      const mine = ib.voiceAgentId === agentId;
                      const otherName =
                        ib.voiceAgentId !== null && !mine
                          ? (agents.find((a) => a.id === ib.voiceAgentId)
                              ?.name ??
                            t("editor.channels.otherAgent", "another agent"))
                          : null;
                      return (
                        <InboxRow
                          key={ib.id}
                          name={ib.name}
                          chatwootInboxId={ib.chatwootInboxId}
                          channelType="WhatsApp"
                          instanceBaseUrl={baseUrl}
                          instanceAccountId={inst.accountId}
                          status={mine ? "active" : "none"}
                        >
                          {!takesCalls(ib) && (
                            <span className="text-warning text-xs">
                              {t(
                                "editor.voiceChannels.noCalls",
                                "This inbox does not take calls. Turn it off to release the agent.",
                              )}
                            </span>
                          )}
                          {otherName && (
                            <span className="text-text-muted text-xs">
                              {t(
                                "editor.voiceChannels.answeredBy",
                                "Calls answered by {{name}}",
                                { name: otherName },
                              )}
                            </span>
                          )}
                          {disconnected && !mine ? (
                            <span className="shrink-0 text-text-muted text-xs">
                              {t(
                                "channels.accountDisconnectedOff",
                                "Account disconnected",
                              )}
                            </span>
                          ) : pending === ib.id ? (
                            <Loader2
                              className="h-5 w-5 animate-spin text-text-muted"
                              aria-hidden="true"
                            />
                          ) : (
                            <Switch
                              checked={mine}
                              onCheckedChange={(next) =>
                                onToggle(ib, next, otherName)
                              }
                              aria-label={t(
                                "editor.voiceChannels.toggleAria",
                                "Answer the calls of {{inbox}} with this agent",
                                { inbox: ib.name },
                              )}
                            />
                          )}
                        </InboxRow>
                      );
                    })}
                  </ul>
                </Card>
              </div>
            );
          })
        )}
      </DataBoundary>

      <ConfirmDialog modal={confirm} />
    </div>
  );
}
