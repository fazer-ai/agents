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
import type { AgentMode } from "@/modules/agents/mode";

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

// Agent editor "Channels" tab: bind/unbind THIS agent to inboxes from the agent's side. Mirrors the
// Channels page but with a per-inbox switch instead of an agent picker, and acts IMMEDIATELY (no
// Save button — like the Playground tab) since binding has side effects on Chatwoot (it provisions +
// connects/disconnects the persona bot via the same PATCH /inboxes/:id endpoint).
export function ChannelsTab({
  agentId,
  agentName,
  mode,
  onBindingChanged,
}: {
  agentId: string;
  agentName: string;
  // A monitoring agent is bound as an OBSERVER, never as the responder, so the SAVED mode picks the
  // endpoint a NEW binding goes through: binding acts immediately and the server judges the stored
  // agent, so a draft mode would be refused. The mode does NOT decide what the row shows: an inbox can
  // carry a monitoring agent as its responder, so the role is read off the inbox row.
  mode: AgentMode;
  // Binding acts immediately, with no save to piggyback on, and the editor's warning panel asks a
  // question whose answer is per-BOUND-inbox (whether Chatwoot already replies out of hours there).
  // Without this the panel would only catch up on the next load, which is the one moment the
  // operator has already stopped looking for it.
  onBindingChanged?: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const confirm = useModalController<ConfirmPayload>();
  const watcher = mode === "monitoring";

  const [instances, setInstances] = useState<Instance[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [botStatus, setBotStatus] = useState<
    Record<string, "active" | "missing">
  >({});
  // Keyed `${inboxId}:${agentId}`, one entry per observer binding, the same shape the Channels
  // page reads, so a watcher whose observer bot is gone shows as missing rather than healthy.
  const [observerStatus, setObserverStatus] = useState<
    Record<string, "active" | "missing">
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);

  const loadBotStatus = useCallback(async () => {
    try {
      const { data } = await api.api.v1.chatwoot.inboxes["bot-status"].get();
      if (data) {
        setBotStatus({ ...data.statuses });
        setObserverStatus({ ...data.observerStatuses });
      }
    } catch {
      // ignore — leave statuses unverified
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [dep, inb, ag] = await Promise.all([
        api.api.v1.chatwoot.deployment.get(),
        api.api.v1.chatwoot.inboxes.get(),
        api.api.v1.agents.get({ query: { pageSize: 100 } }),
      ]);
      if (dep.error || !dep.data) {
        setError(true);
        return;
      }
      setInstances([...dep.data.accounts]);
      setBaseUrl(dep.data.deployment?.baseUrl ?? "");
      if (inb.data) setInboxes([...inb.data.inboxes]);
      if (ag.data) setAgents([...ag.data.agents]);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
    void loadBotStatus();
  }, [loadBotStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  // Persist a binding (agentId = this agent to bind, null to unbind). Non-optimistic: local state
  // changes only on success; on failure the switch reverts because it reads from `inboxes`.
  async function setBinding(inboxId: string, nextAgentId: string | null) {
    setPending(inboxId);
    try {
      const { error: err } = await api.api.v1.chatwoot
        .inboxes({ id: inboxId })
        .patch({ agentId: nextAgentId });
      if (err) throw err;
      setInboxes((prev) =>
        prev.map((i) =>
          i.id === inboxId ? { ...i, agentId: nextAgentId } : i,
        ),
      );
      setBotStatus((prev) => {
        const next = { ...prev };
        if (nextAgentId) next[inboxId] = "active";
        else delete next[inboxId];
        return next;
      });
      showToast(t("channels.bound", "Inbox updated."), "success");
      onBindingChanged?.();
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("channels.bindError", "Could not update the inbox."),
        "error",
      );
    } finally {
      setPending(null);
    }
  }

  // Applies BOTH roles from an observe's answer. `observeInbox` can answer 200 with the observe NOT
  // done: racing a bind of this same agent, the responder wins (`responderWon` in management.ts) and
  // the DTO names this agent as the RESPONDER, so reading only `observerAgentIds` would leave
  // `agentId` stale. The status map follows the answer too: `active` only where the response still
  // lists us among the observers.
  function applyInboxRoles(
    inboxId: string,
    dto: { agentId: string | null; observerAgentIds: string[] },
  ) {
    setInboxes((prev) =>
      prev.map((i) =>
        i.id === inboxId
          ? {
              ...i,
              agentId: dto.agentId,
              observerAgentIds: dto.observerAgentIds,
            }
          : i,
      ),
    );
    setObserverStatus((prev) => {
      const nextMap = { ...prev };
      const key = `${inboxId}:${agentId}`;
      if (dto.observerAgentIds.includes(agentId)) nextMap[key] = "active";
      else delete nextMap[key];
      return nextMap;
    });
  }

  // The observer binding, the way the Channels page drives it: both calls reach Chatwoot, and the
  // row's list moves only on success. Returns whether it worked, because the combined removal below
  // must not unbind the responder after a failed observer removal.
  async function setObserving(
    inboxId: string,
    next: boolean,
  ): Promise<boolean> {
    setPending(inboxId);
    try {
      const res = next
        ? await api.api.v1.chatwoot
            .inboxes({ id: inboxId })
            .observers.post({ agentId })
        : await api.api.v1.chatwoot
            .inboxes({ id: inboxId })
            .observers({ agentId })
            .delete();
      if (res.error || !res.data) throw res.error;
      applyInboxRoles(inboxId, res.data.inbox);
      // The message is the answer's, not the request's: an observe the responder race won returns
      // 200 with no observer.
      const observing = res.data.inbox.observerAgentIds.includes(agentId);
      showToast(
        next
          ? observing
            ? t("channels.observed", "Observer added.")
            : t(
                "channels.observeResponderWon",
                "This agent was bound as the inbox's responder, so it was not added as an observer.",
              )
          : t("channels.unobserved", "Observer removed."),
        "success",
      );
      onBindingChanged?.();
      return true;
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          (next
            ? t("channels.observeError", "Could not add the observer.")
            : t("channels.unobserveError", "Could not remove the observer.")),
        "error",
      );
      return false;
    } finally {
      setPending(null);
    }
  }

  // Which role this agent has on this inbox, off the row rather than off the mode: a
  // monitoring agent can be an inbox's responder after a mode change (docs/chatwoot.md), and reading
  // the role from the mode would hide that binding and leave no way to remove it.
  const rolesOn = (ib: Inbox) => ({
    responds: ib.agentId === agentId,
    observes: ib.observerAgentIds.includes(agentId),
  });

  function onToggle(ib: Inbox, next: boolean) {
    const role = rolesOn(ib);
    if (!next) {
      // NOTE: Whatever is actually there comes off, both if the inbox carries both: the switch says "this
      // agent is on this inbox", so turning it off has to leave nothing behind.
      void (async () => {
        // NOTE: The observer first, and the responder only if that worked, so a failed removal does not
        // leave the agent half-removed.
        if (role.observes && !(await setObserving(ib.id, false))) return;
        if (role.responds) await setBinding(ib.id, null);
      })();
      return;
    }
    if (watcher) {
      void setObserving(ib.id, true);
      return;
    }
    // Connecting to an inbox already owned by another agent steals it — confirm first.
    if (ib.agentId !== null && ib.agentId !== agentId) {
      const owner =
        agents.find((a) => a.id === ib.agentId)?.name ??
        t("editor.channels.otherAgent", "another agent");
      confirm.open({
        title: t("editor.channels.reassignTitle", "Reassign inbox"),
        message: t(
          "editor.channels.reassignBody",
          '"{{inbox}}" is currently answered by "{{owner}}". Reassign it to "{{agent}}"?',
          { inbox: ib.name, owner, agent: agentName },
        ),
        confirmLabel: t("editor.channels.reassignConfirm", "Reassign"),
        onConfirm: () => setBinding(ib.id, agentId),
      });
      return;
    }
    void setBinding(ib.id, agentId);
  }

  // The repair for a MISSING OBSERVER bot is an observe, not the inbox reconnect: that endpoint
  // repairs the responder's bot and would leave this pair broken. `observeInbox` provisions the bot
  // again and re-attaches it.
  async function reobserve(inboxId: string) {
    setReconnecting(inboxId);
    try {
      const res = await api.api.v1.chatwoot
        .inboxes({ id: inboxId })
        .observers.post({ agentId });
      if (res.error || !res.data) throw res.error;
      // NOTE: Through `applyInboxRoles` for the same reason as the observe: this call can come back
      // having made this agent the responder instead.
      applyInboxRoles(inboxId, res.data.inbox);
      showToast(t("channels.reconnected", "Bot reconnected."), "success");
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("channels.reconnectError", "Could not reconnect the bot."),
        "error",
      );
    } finally {
      setReconnecting(null);
    }
  }

  async function reconnectBot(inboxId: string) {
    setReconnecting(inboxId);
    try {
      const { error: err } = await api.api.v1.chatwoot
        .inboxes({ id: inboxId })
        .reconnect.post();
      if (err) throw err;
      setBotStatus((prev) => ({ ...prev, [inboxId]: "active" }));
      showToast(t("channels.reconnected", "Bot reconnected."), "success");
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("channels.reconnectError", "Could not reconnect the bot."),
        "error",
      );
    } finally {
      setReconnecting(null);
    }
  }

  const accountLabel = (inst: Instance) =>
    inst.accountName ??
    t("channels.account", "Account {{id}}", { id: inst.accountId });
  const inboxesByInstance = instances
    .map((inst) => ({
      inst,
      items: inboxes.filter((ib) => ib.chatwootInstanceId === inst.id),
    }))
    .filter((g) => g.items.length > 0)
    .sort(
      (a, b) =>
        accountLabel(a.inst).localeCompare(accountLabel(b.inst), undefined, {
          sensitivity: "base",
        }) || a.inst.accountId - b.inst.accountId,
    );
  const showInstanceHeaders = inboxesByInstance.length > 1;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="flex items-center gap-2 font-medium text-text-primary">
          <InboxIcon className="h-4 w-4 text-accent" aria-hidden="true" />
          {t("editor.channels.title", "Inboxes")}
        </h2>
        <p className="mt-0.5 text-text-muted text-xs">
          {watcher
            ? t(
                "editor.channels.observeDesc",
                "Pick the inboxes this agent observes. It receives every message there and answers none; whoever answers the inbox keeps it. Changes apply immediately on Chatwoot.",
              )
            : t(
                "editor.channels.desc",
                "Connect this agent to the inboxes it should answer. Changes apply immediately on Chatwoot.",
              )}
        </p>
      </div>

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
        ) : inboxesByInstance.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon={InboxIcon}
              title={t("editor.channels.empty", "No inboxes available")}
              description={t(
                "editor.channels.emptyDesc",
                "Sync this Chatwoot instance's inboxes under Channels first.",
              )}
            />
          </Card>
        ) : (
          inboxesByInstance.map(({ inst, items }) => {
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
                      const role = rolesOn(ib);
                      // ON when this agent is on this inbox in EITHER role.
                      const mine = role.responds || role.observes;
                      const observerBroken =
                        role.observes &&
                        observerStatus[`${ib.id}:${agentId}`] === "missing";
                      // Watching an inbox we do not answer: the row whose health is the observer pair's and
                      // nobody else's.
                      const observerOnly = role.observes && !role.responds;
                      const otherOwner =
                        ib.agentId !== null && ib.agentId !== agentId
                          ? (agents.find((a) => a.id === ib.agentId)?.name ??
                            t("editor.channels.otherAgent", "another agent"))
                          : null;
                      return (
                        <InboxRow
                          key={ib.id}
                          name={ib.name}
                          chatwootInboxId={ib.chatwootInboxId}
                          channelType={ib.channelType}
                          instanceBaseUrl={baseUrl}
                          instanceAccountId={inst.accountId}
                          status={
                            // NOTE: A disconnected account says nothing about a bot, EXCEPT that our own observer
                            // row is still there and still removable: shown active so the row reads as one this
                            // agent is on, which is what the removal control beside it acts on.
                            disconnected
                              ? role.observes
                                ? "active"
                                : "none"
                              : // NOTE: Where we only OBSERVE, the chip is the observer pair's
                                // health, not the responder's: another agent's missing bot must
                                // not mark this observer missing or offer to repair that bot.
                                observerOnly
                                ? observerBroken
                                  ? "missing"
                                  : "active"
                                : role.responds
                                  ? botStatus[ib.id] === "missing"
                                    ? "missing"
                                    : "active"
                                  : ib.agentId === null
                                    ? "none"
                                    : botStatus[ib.id] === "missing"
                                      ? "missing"
                                      : "active"
                          }
                          reconnecting={reconnecting === ib.id}
                          onReconnect={() =>
                            observerOnly || observerBroken
                              ? reobserve(ib.id)
                              : reconnectBot(ib.id)
                          }
                        >
                          {disconnected && role.observes ? (
                            // NOTE: Removal stays reachable while the account is disconnected:
                            // `unobserveInbox` asks no account, and the observer row is what blocks
                            // switching this agent out of monitoring or deleting it. Only removal:
                            // adding needs the account.
                            pending === ib.id ? (
                              <Loader2
                                className="h-5 w-5 animate-spin text-text-muted"
                                aria-hidden="true"
                              />
                            ) : (
                              <Switch
                                checked
                                onCheckedChange={() =>
                                  void setObserving(ib.id, false)
                                }
                                aria-label={t(
                                  "editor.channels.observeToggleAria",
                                  "Observe {{inbox}} with this agent",
                                  { inbox: ib.name },
                                )}
                              />
                            )
                          ) : disconnected ? (
                            <span className="shrink-0 text-text-muted text-xs">
                              {t(
                                "channels.accountDisconnectedOff",
                                "Account disconnected",
                              )}
                            </span>
                          ) : (
                            <>
                              {otherOwner && (
                                <span className="text-text-muted text-xs">
                                  {t(
                                    "editor.channels.ownedBy",
                                    "Answered by {{name}}",
                                    { name: otherOwner },
                                  )}
                                </span>
                              )}
                              {pending === ib.id ? (
                                <Loader2
                                  className="h-5 w-5 animate-spin text-text-muted"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Switch
                                  checked={mine}
                                  onCheckedChange={(next) => onToggle(ib, next)}
                                  aria-label={
                                    role.observes || (watcher && !role.responds)
                                      ? t(
                                          "editor.channels.observeToggleAria",
                                          "Observe {{inbox}} with this agent",
                                          { inbox: ib.name },
                                        )
                                      : t(
                                          "editor.channels.toggleAria",
                                          "Answer {{inbox}} with this agent",
                                          { inbox: ib.name },
                                        )
                                  }
                                />
                              )}
                            </>
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
