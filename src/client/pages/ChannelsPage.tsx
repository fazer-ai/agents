import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  ExternalLink,
  Inbox as InboxIcon,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  RadioTower,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  Unplug,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  EmptyState,
  FormField,
  InboxRow,
  Input,
  Modal,
  PageContainer,
  Skeleton,
  StrongConfirmModal,
  type StrongConfirmPayload,
  Tooltip,
  useModalController,
  useToast,
} from "@/client/components";
import { ServiceLogo } from "@/client/components/icons/ServiceLogo";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { chatwootInboxNewUrl } from "@/client/lib/chatwootLinks";
import { cn } from "@/client/lib/utils";
import { isValidHttpUrl } from "@/client/lib/validation";

type DeploymentData = Awaited<
  ReturnType<typeof api.api.v1.chatwoot.deployment.get>
>["data"];
type Deployment = NonNullable<DeploymentData>["deployment"];
type Account = NonNullable<DeploymentData>["accounts"][number];
type InboxesData = Awaited<
  ReturnType<typeof api.api.v1.chatwoot.inboxes.get>
>["data"];
type Inbox = NonNullable<InboxesData>["inboxes"][number];
type AgentsData = Awaited<ReturnType<typeof api.api.v1.agents.get>>["data"];
type AgentLite = NonNullable<AgentsData>["agents"][number];
type ReachableData = Awaited<
  ReturnType<typeof api.api.v1.chatwoot.deployment.accounts.get>
>["data"];
type ReachableAccount = NonNullable<ReachableData>["accounts"][number];

// NOTE: Static keys so the skeleton rows don't key off the array index.
const CHANNELS_ACCOUNT_KEYS = ["acct-0", "acct-1"];
const CHANNELS_INBOX_KEYS = ["inbox-0", "inbox-1", "inbox-2"];

const pickerItemCls =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary";

// Custom value-picker (Radix dropdown) for the inbox → answering-agent binding. Binding is a network
// call (it lazily provisions + connects the bot on Chatwoot), so the trigger shows a spinner while
// `onChange` is in flight; the displayed value is controlled by `value`, so a failed bind leaves it
// unchanged.
function InboxAgentPicker({
  value,
  agents,
  onChange,
  label,
}: {
  value: string | null;
  agents: AgentLite[];
  onChange: (agentId: string | null) => Promise<void>;
  label: string;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const current = agents.find((a) => a.id === value) ?? null;

  async function select(next: string | null) {
    if (next === value) return;
    setPending(true);
    try {
      await onChange(next);
    } catch {
      // handled by the caller (toast); `value` is unchanged so the trigger reverts on its own
    } finally {
      setPending(false);
    }
  }

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          disabled={pending}
          aria-label={label}
          className="flex w-56 shrink-0 items-center justify-between gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none disabled:opacity-60"
        >
          <span className={cn("truncate", { "text-text-muted": !current })}>
            {current ? current.name : t("channels.noAgent", "No agent")}
          </span>
          {pending ? (
            <Loader2
              className="h-4 w-4 shrink-0 animate-spin text-text-muted"
              aria-hidden="true"
            />
          ) : (
            <ChevronDown
              className="h-4 w-4 shrink-0 text-text-muted"
              aria-hidden="true"
            />
          )}
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="z-50 max-h-72 w-56 overflow-y-auto rounded-lg border border-border bg-bg-secondary p-1 shadow-lg"
        >
          <DropdownMenuPrimitive.Item
            className={pickerItemCls}
            onSelect={() => void select(null)}
          >
            <span className="flex-1 truncate">
              {t("channels.noAgent", "No agent")}
            </span>
            {value === null && (
              <Check
                className="h-4 w-4 shrink-0 text-accent"
                aria-hidden="true"
              />
            )}
          </DropdownMenuPrimitive.Item>
          {agents.map((a) => (
            <DropdownMenuPrimitive.Item
              key={a.id}
              className={pickerItemCls}
              onSelect={() => void select(a.id)}
            >
              <span className="flex-1 truncate">{a.name}</span>
              {value === a.id && (
                <Check
                  className="h-4 w-4 shrink-0 text-accent"
                  aria-hidden="true"
                />
              )}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

// Bespoke loading placeholder: the deployment card + account rows, then the inbox list.
function ChannelsSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <section className="flex flex-col gap-3">
        <Skeleton className="h-5 w-44" />
        <Card className="flex items-center justify-between gap-4">
          <Skeleton className="h-5 w-64" />
          <div className="flex gap-1">
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-9 w-28" />
          </div>
        </Card>
        {CHANNELS_ACCOUNT_KEYS.map((key) => (
          <Card key={key} className="flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-9 w-28" />
          </Card>
        ))}
      </section>
      <section className="flex flex-col gap-3">
        <Skeleton className="h-5 w-28" />
        <Card className="p-0">
          <ul>
            {CHANNELS_INBOX_KEYS.map((key) => (
              <li
                key={key}
                className="flex items-center justify-between gap-4 border-border border-b px-4 py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-col gap-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="h-9 w-56" />
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </div>
  );
}

export function ChannelsPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const connectModal = useModalController();
  const tokenModal = useModalController();
  // The account picker (super-admin): choose which of the server's accounts this workspace answers.
  const manageModal = useModalController();
  // Strong confirmation (backup warning + re-typed name + password) for the two irreversible,
  // SUPER_ADMIN-only actions: tearing down the whole instance, and removing one account (to move it).
  const strongConfirm = useModalController<StrongConfirmPayload>();
  const confirm = useModalController<ConfirmPayload>();

  // Connect form (base URL + admin token, entered once).
  const [baseUrl, setBaseUrl] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [connecting, setConnecting] = useState(false);

  // Every account the deployment's token can reach (from /profile), listed inline under the instance
  // with a connect toggle. Loaded best-effort on mount; "Resync" re-fetches to pick up new accounts.
  const [reachable, setReachable] = useState<ReachableAccount[]>([]);
  const [resyncing, setResyncing] = useState(false);
  // The picker's pending selection (account ids to newly enable) + the apply spinner.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [applying, setApplying] = useState(false);

  // Rotate-token modal.
  const [newToken, setNewToken] = useState("");
  const [savingToken, setSavingToken] = useState(false);

  // Per-inbox bot existence on Chatwoot (live reconcile). "missing" = bound here but the persona's
  // bot was deleted on Chatwoot → show the Reconnect affordance. Absent = unverified (assume ok).
  const [botStatus, setBotStatus] = useState<
    Record<string, "active" | "missing">
  >({});
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [removingInbox, setRemovingInbox] = useState<string | null>(null);

  const loadBotStatus = useCallback(async () => {
    try {
      const { data } = await api.api.v1.chatwoot.inboxes["bot-status"].get();
      if (data) setBotStatus({ ...data.statuses });
    } catch {
      // ignore — leave statuses unverified
    }
  }, []);

  // The accounts the deployment's stored token can reach (no token re-entry). Best-effort: when there
  // is no deployment, or Chatwoot is unreachable, it stays empty and the page shows just the connected
  // accounts (from the DB). Refreshed by "Resync".
  const loadReachable = useCallback(async () => {
    // The reachable-account probe (the server's full roster) is SUPER_ADMIN-only — on a shared
    // Chatwoot it would expose other tenants' accounts. A TENANT_ADMIN just sees its own connected
    // accounts (from GET /deployment); the endpoint would 403 anyway.
    if (!isSuperAdmin) return;
    try {
      const { data } = await api.api.v1.chatwoot.deployment.accounts.get();
      if (data) setReachable([...data.accounts]);
    } catch {
      // ignore — not connected yet, or Chatwoot down; the connected accounts still render
    }
  }, [isSuperAdmin]);

  // Quietly refresh just the inbox mirror (+ bot status), WITHOUT toggling `loading` — so per-account
  // actions (connect/disconnect/sync) update in place instead of flashing the whole page skeleton.
  const refreshInboxes = useCallback(async () => {
    try {
      const { data } = await api.api.v1.chatwoot.inboxes.get();
      if (data) setInboxes([...data.inboxes]);
    } catch {
      // keep the current list on a transient failure
    }
    void loadBotStatus();
  }, [loadBotStatus]);

  // Accounts with a sync request in flight, shared by the load-time auto-sync and the manual button
  // so the same account is never synced twice concurrently (the server reconcile is race-hardened;
  // skipping here just avoids redundant Chatwoot calls).
  const syncInFlight = useRef<Set<string>>(new Set());

  // An inbox created in Chatwoot is invisible here until a sync pulls it into the local mirror, and
  // nothing does that automatically after the account's first connect — so the screen revalidates on
  // load: the mirror renders immediately, every connected account syncs in the background, then the
  // list refreshes. Silent on failure (Chatwoot down / non-admin role just keeps the mirror as-is);
  // the toast fires only when a NEW inbox actually appeared.
  const autoSyncInboxes = useCallback(
    async (accts: Account[]) => {
      const targets = accts.filter((a) => !syncInFlight.current.has(a.id));
      if (targets.length === 0) return;
      for (const a of targets) syncInFlight.current.add(a.id);
      let created = 0;
      let synced = false;
      try {
        const results = await Promise.allSettled(
          targets.map((a) =>
            api.api.v1.chatwoot.instances({ id: a.id })["sync-inboxes"].post(),
          ),
        );
        for (const r of results) {
          if (r.status !== "fulfilled" || r.value.error || !r.value.data)
            continue;
          synced = true;
          created += r.value.data.result.created;
        }
      } finally {
        for (const a of targets) syncInFlight.current.delete(a.id);
      }
      if (created > 0) {
        showToast(
          t(
            "channels.autoSynced",
            "{{count}} new inbox(es) synced from Chatwoot.",
            { count: created },
          ),
          "success",
        );
      }
      if (synced) await refreshInboxes();
    },
    [refreshInboxes, showToast, t],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [dep, inb, ag] = await Promise.all([
        api.api.v1.chatwoot.deployment.get(),
        api.api.v1.chatwoot.inboxes.get(),
        api.api.v1.agents.get(),
      ]);
      if (dep.error || !dep.data) {
        setError(true);
        return;
      }
      setDeployment(dep.data.deployment);
      setAccounts([...dep.data.accounts]);
      if (inb.data) setInboxes([...inb.data.inboxes]);
      if (ag.data) setAgents([...ag.data.agents]);
      // Only active accounts: a soft-disconnected account must not be re-synced (its mirror is
      // frozen until it is reconnected).
      void autoSyncInboxes(
        dep.data.accounts.filter((a) => a.disconnectedAt === null),
      );
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
    void loadBotStatus();
    void loadReachable();
  }, [autoSyncInboxes, loadBotStatus, loadReachable]);

  useEffect(() => {
    void load();
  }, [load]);

  // Deep-link: /channels?connect=<baseUrl> pre-opens the connect modal with the Base URL filled
  // (only the admin token is left to paste). The onboarding agent links the operator here as the
  // fallback when it can't run deployment_connect itself, instead of pasting a secret. Mirrors the
  // vault's ?fill= pilot: acts only after load, honors the same guards as the manual button
  // (SUPER_ADMIN + no deployment yet), normalizes a bare host to https://, then strips the param.
  const [searchParams, setSearchParams] = useSearchParams();
  const connectParam = searchParams.get("connect");
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per connect target; clearing the param makes connectParam null so it won't re-fire.
  useEffect(() => {
    if (!connectParam || loading) return;
    if (isSuperAdmin && !deployment) {
      setBaseUrl(
        /^https?:\/\//i.test(connectParam)
          ? connectParam
          : `https://${connectParam}`,
      );
      setAdminToken("");
      connectModal.open();
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("connect");
        return next;
      },
      { replace: true },
    );
  }, [connectParam, loading, isSuperAdmin, deployment]);

  const baseUrl0 = deployment?.baseUrl ?? "";
  // The host the operator must re-type to confirm a teardown (e.g. "chat.example.com").
  const deploymentHost = (() => {
    if (!deployment) return "";
    try {
      return new URL(deployment.baseUrl).host;
    } catch {
      return deployment.baseUrl;
    }
  })();

  function openConnect() {
    setBaseUrl("");
    setAdminToken("");
    connectModal.open();
  }

  // Register the deployment (base URL + token, once). The server validates the credentials by probing
  // /profile; on success the modal closes and the account picker opens with the reachable accounts so
  // the operator immediately chooses which to register.
  async function connectDeployment() {
    if (!baseUrl.trim() || !adminToken.trim()) return;
    setConnecting(true);
    try {
      const { data, error: err } = await api.api.v1.chatwoot.deployment.post({
        baseUrl: baseUrl.trim(),
        adminToken: adminToken.trim(),
      });
      if (err || !data) {
        const status =
          typeof err === "object" && err && "status" in err
            ? (err as { status?: number }).status
            : undefined;
        showToast(
          apiErrorMessage(err) ||
            (status === 409
              ? t(
                  "channels.connectDifferent",
                  "This tenant is already connected to a different Chatwoot. Disconnect it first to switch servers.",
                )
              : t(
                  "channels.connectError",
                  "Could not connect. Check the URL and token.",
                )),
          "error",
        );
        return;
      }
      showToast(t("channels.connected", "Chatwoot connected."), "success");
      connectModal.close();
      setDeployment(data.deployment);
      setReachable([...data.accounts]);
      void load();
      // Open the picker right away so the operator chooses which accounts to answer.
      openManage();
    } catch {
      showToast(
        t(
          "channels.connectError",
          "Could not connect. Check the URL and token.",
        ),
        "error",
      );
    } finally {
      setConnecting(false);
    }
  }

  // Re-fetch the reachable-account list from Chatwoot (picks up accounts created after the connection).
  async function resyncAccounts() {
    setResyncing(true);
    try {
      const { data, error: err } =
        await api.api.v1.chatwoot.deployment.accounts.get();
      if (err || !data) throw err ?? new Error("no data");
      setReachable([...data.accounts]);
      showToast(
        t("channels.accountsResynced", "Account list updated."),
        "success",
      );
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t(
            "channels.accountsError",
            "Could not list accounts. Check the URL and token.",
          ),
        "error",
      );
    } finally {
      setResyncing(false);
    }
  }

  // Open the account picker (super-admin): reset the pending selection, show the modal, and refresh the
  // server roster (silent). The page list shows only ACTIVE accounts; enabling more happens here,
  // removing happens from the list (a hard, slot-freeing delete that returns the account to this picker).
  function openManage() {
    setSelected(new Set());
    manageModal.open();
    void loadReachable();
  }

  function toggleSelected(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Enable the newly-picked accounts. Sends the UNION of the already-active ids and the selection, so the
  // diff applier only ever CONNECTS here (it never drops an active account — removal is the explicit
  // hard-delete on the list). Connecting syncs each account's inboxes.
  async function applySelection() {
    const activeIds = accounts
      .filter((a) => !a.disconnectedAt)
      .map((a) => a.accountId);
    const wanted = [...new Set([...activeIds, ...selected])];
    setApplying(true);
    try {
      const { data, error: err } =
        await api.api.v1.chatwoot.deployment.accounts.put({
          accountIds: wanted,
        });
      if (err || !data) throw err ?? new Error("no data");
      setAccounts([...data.accounts]);
      await refreshInboxes();
      manageModal.close();
      setSelected(new Set());
      showToast(t("channels.accountsEnabled", "Accounts updated."), "success");
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("channels.accountsSaveError", "Could not update the accounts."),
        "error",
      );
    } finally {
      setApplying(false);
    }
  }

  function openToken() {
    setNewToken("");
    tokenModal.open();
  }

  async function saveToken() {
    if (!newToken.trim()) return;
    setSavingToken(true);
    try {
      const { error: err } = await api.api.v1.chatwoot.deployment.patch({
        adminToken: newToken.trim(),
      });
      if (err) throw err;
      showToast(t("channels.tokenSaved", "Token updated."), "success");
      tokenModal.close();
      void load();
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t(
            "channels.tokenSaveError",
            "Could not update the token (check it).",
          ),
        "error",
      );
    } finally {
      setSavingToken(false);
    }
  }

  // Irreversible teardown: wipes the local Chatwoot mirror so a different instance can be connected.
  // Guarded by the re-typed domain + password (verified server-side; SUPER_ADMIN-only endpoint).
  function openTeardown() {
    if (!deployment) return;
    strongConfirm.open({
      title: t("channels.disconnectInstance", "Disconnect instance"),
      warning: t(
        "channels.teardownWarning",
        "This permanently deletes the local mirror of this Chatwoot: every conversation, contact, inbox and the dashboard analytics for this instance. It cannot be undone. The data in Chatwoot itself is not touched.",
      ),
      backupNote: t(
        "channels.teardownBackup",
        "Recommended: export or back up your analytics before continuing.",
      ),
      confirmPhrase: deploymentHost,
      confirmLabel: t("channels.teardownDomain", "Type {{host}} to confirm", {
        host: deploymentHost,
      }),
      actionLabel: t("channels.disconnectInstance", "Disconnect instance"),
      onConfirm: async (password) => {
        const { error: err } = await api.api.v1.chatwoot.deployment.delete({
          confirmDomain: deploymentHost,
          password,
        });
        if (err) {
          showToast(
            apiErrorMessage(err) ||
              t(
                "channels.teardownError",
                "Could not disconnect. Check your password and try again.",
              ),
            "error",
          );
          throw err; // keep the dialog open
        }
        showToast(
          t("channels.instanceDisconnected", "Chatwoot disconnected."),
          "success",
        );
        setDeployment(null);
        setAccounts([]);
        setReachable([]);
        void load();
      },
    });
  }

  // Irreversible per-account removal (the "move account to another tenant" path): wipes the account's
  // local mirror and frees its (server, account) slot. Confirm by re-typing the account name (or id)
  // + password (SUPER_ADMIN-only endpoint).
  function removeAccount(account: Account) {
    const phrase = account.accountName ?? String(account.accountId);
    strongConfirm.open({
      title: t("channels.removeAccountTitle", "Remove account"),
      warning: t(
        "channels.removeAccountWarning",
        "This permanently deletes this account's local mirror: its conversations, inboxes, bots and analytics. It cannot be undone, and frees the account to be connected by another tenant. The data in Chatwoot itself is not touched.",
      ),
      backupNote: t(
        "channels.teardownBackup",
        "Recommended: export or back up your analytics before continuing.",
      ),
      confirmPhrase: phrase,
      confirmLabel: t(
        "channels.removeAccountConfirm",
        "Type {{name}} to confirm",
        { name: phrase },
      ),
      actionLabel: t("channels.removeAccountAction", "Remove account"),
      onConfirm: async (password) => {
        const { error: err } = await api.api.v1.chatwoot
          .instances({ id: account.id })
          .remove.post({ confirmName: phrase, password });
        if (err) {
          showToast(
            apiErrorMessage(err) ||
              t(
                "channels.removeAccountError",
                "Could not remove the account. Check your password and try again.",
              ),
            "error",
          );
          throw err; // keep the dialog open
        }
        showToast(
          t("channels.removeAccountDone", "Account removed."),
          "success",
        );
        void load();
      },
    });
  }

  async function syncInboxesFor(account: Account) {
    if (syncInFlight.current.has(account.id)) return; // auto-sync already on it
    syncInFlight.current.add(account.id);
    setBusy(true);
    try {
      const { data, error: err } = await api.api.v1.chatwoot
        .instances({ id: account.id })
        ["sync-inboxes"].post();
      if (err || !data) throw err ?? new Error("no data");
      showToast(
        t("channels.synced", "{{created}} new, {{updated}} updated.", {
          created: data.result.created,
          updated: data.result.updated,
        }),
        "success",
      );
      await refreshInboxes();
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("channels.syncError", "Could not sync inboxes."),
        "error",
      );
    } finally {
      syncInFlight.current.delete(account.id);
      setBusy(false);
    }
  }

  // Binding an inbox to an agent lazily provisions + connects the Chatwoot bot; unbinding (null)
  // disconnects it. Non-optimistic: update local state only on success, rethrow on failure so the
  // row's picker stops its spinner without changing the displayed value.
  async function bindInbox(inboxId: string, agentId: string | null) {
    const { error: err } = await api.api.v1.chatwoot
      .inboxes({ id: inboxId })
      .patch({ agentId });
    if (err) {
      showToast(
        apiErrorMessage(err) ||
          t("channels.bindError", "Could not update the inbox."),
        "error",
      );
      throw err;
    }
    setInboxes((prev) =>
      prev.map((i) => (i.id === inboxId ? { ...i, agentId } : i)),
    );
    setBotStatus((prev) => {
      const next = { ...prev };
      if (agentId) next[inboxId] = "active";
      else delete next[inboxId];
      return next;
    });
    showToast(t("channels.bound", "Inbox updated."), "success");
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

  // Remove one inbox's local mirror. Only ever succeeds for an inbox that no longer exists in
  // Chatwoot; a live one comes back 409 and the toast says so, which is the only place an operator
  // learns why the row is still there. Kept out of the agent editor's Channels tab on purpose.
  function removeInboxMirror(inbox: { id: string; name: string }) {
    confirm.open({
      title: t("channels.removeInboxTitle", "Remove inbox mirror"),
      message: t(
        "channels.removeInboxWarning",
        "This removes the local copy of an inbox that was deleted in Chatwoot. Past conversations are kept and stop naming an inbox; past usage and log lines are kept. It cannot be undone, and only works once the inbox is gone from Chatwoot.",
      ),
      danger: true,
      confirmLabel: t("channels.removeInboxAction", "Remove mirror"),
      onConfirm: async () => {
        setRemovingInbox(inbox.id);
        try {
          const { error: err } = await api.api.v1.chatwoot
            .inboxes({ id: inbox.id })
            .delete();
          if (err) throw err;
          setInboxes((prev) => prev.filter((i) => i.id !== inbox.id));
          showToast(
            t("channels.removedInbox", "Inbox mirror removed."),
            "success",
          );
        } catch (e) {
          // The server's own sentence, because it is the one that TEACHES: a live inbox comes back
          // 409 "This inbox still exists in Chatwoot. Delete it there first.", already localized. The
          // fallback covers a transport failure with no server behind it, which is the case a bare
          // `if (err)` never reaches — the await rejects before `err` is ever assigned (docs/ui.md).
          showToast(
            apiErrorMessage(e) ??
              t("channels.removeInboxError", "Could not remove the inbox."),
            "error",
          );
          throw e;
        } finally {
          setRemovingInbox(null);
        }
      },
    });
  }

  const baseUrlInvalid = !isValidHttpUrl(baseUrl);
  const connectDirty = baseUrl.trim() !== "" || adminToken.trim() !== "";

  // Accounts are ordered alphabetically by name (the #id breaks ties / orders the unnamed), so the
  // page list and the manage modal show the same, stable order regardless of connection order.
  const accountLabel = (name: string | null, id: number) =>
    name ?? t("channels.account", "Account {{id}}", { id });
  const byName = (
    a: { name: string; id: number },
    b: { name: string; id: number },
  ) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
    a.id - b.id;
  const sortedAccounts = [...accounts].sort((a, b) =>
    byName(
      { name: accountLabel(a.accountName, a.accountId), id: a.accountId },
      { name: accountLabel(b.accountName, b.accountId), id: b.accountId },
    ),
  );

  // Group inboxes under their owning account. chatwootInboxId/name are per-account, so with more than
  // one account the flat list would be ambiguous; the per-group header disambiguates.
  const inboxesByAccount = sortedAccounts
    .map((acct) => ({
      acct,
      items: inboxes.filter((ib) => ib.chatwootInstanceId === acct.id),
    }))
    .filter((g) => g.items.length > 0);
  const showAccountHeaders = accounts.length > 1;

  // The page list shows only ACTIVE accounts (connected, not paused) — clean, no roster noise.
  const connectedById = new Map(accounts.map((a) => [a.accountId, a]));
  const activeAccounts = sortedAccounts.filter(
    (a) => a.disconnectedAt === null,
  );
  // The picker's rows: every reachable account (from /profile) plus any connected account the token can
  // no longer see. `instance` present ⇒ connected here; `claim` (super-admin only) carries cross-tenant
  // ownership on a shared server. Active rows render as already-on; in-use-by-others as blocked.
  const manageRows = [
    ...reachable.map((r) => ({
      id: r.id,
      name: r.name,
      instance: connectedById.get(r.id) ?? null,
      claim: r.claim ?? null,
    })),
    ...accounts
      .filter((a) => !reachable.some((r) => r.id === a.accountId))
      .map((a) => ({
        id: a.accountId,
        name: accountLabel(a.accountName, a.accountId),
        instance: a,
        claim: null,
      })),
  ].sort(byName);

  return (
    <PageContainer className="flex flex-col gap-6">
      <header className="flex items-center gap-3">
        <RadioTower className="h-6 w-6 text-accent" aria-hidden="true" />
        <div>
          <h1 className="font-semibold text-text-primary text-xl">
            {t("channels.title", "Channels")}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {t(
              "channels.subtitle",
              "Connect Chatwoot accounts and decide which agent answers each inbox.",
            )}
          </p>
        </div>
      </header>

      <DataBoundary
        loading={loading}
        error={error}
        onRetry={load}
        skeleton={<ChannelsSkeleton />}
      >
        <section className="flex flex-col gap-3">
          <h2 className="flex items-center gap-2 font-medium text-text-primary">
            <Plug className="h-4 w-4 text-accent" aria-hidden="true" />
            {t("channels.instance", "Chatwoot instance")}
          </h2>

          {!deployment ? (
            <Card className="p-0">
              <EmptyState
                icon={Plug}
                title={t("channels.notConnected", "No Chatwoot connected")}
                description={
                  isSuperAdmin
                    ? t(
                        "channels.notConnectedDesc",
                        "Register your Chatwoot once with its base URL and admin token, then pick which accounts to answer.",
                      )
                    : t(
                        "channels.notConnectedTenant",
                        "No Chatwoot account is connected for this workspace yet. Ask an administrator to connect one.",
                      )
                }
                action={
                  isSuperAdmin ? (
                    <Button onClick={openConnect}>
                      <Plug className="h-4 w-4" aria-hidden="true" />
                      {t("channels.connect", "Connect instance")}
                    </Button>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            // The deployment is the section container; its accounts are nested sub-rows inside the
            // same card so they read as belonging to this one Chatwoot instance.
            <Card className="overflow-hidden p-0">
              <div className="flex flex-wrap items-center justify-between gap-3 border-border border-b bg-bg-tertiary/40 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <ServiceLogo
                    service="chatwoot"
                    className="h-5 w-5 shrink-0 text-text-secondary"
                  />
                  <span className="truncate font-medium text-text-primary">
                    {deployment.baseUrl}
                  </span>
                  <Tooltip
                    content={t("channels.openInChatwoot", "Open in Chatwoot")}
                  >
                    <a
                      href={deployment.baseUrl.replace(/\/+$/, "")}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t(
                        "channels.openInChatwoot",
                        "Open in Chatwoot",
                      )}
                      className="inline-flex shrink-0 items-center justify-center rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                    >
                      <ExternalLink
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      />
                    </a>
                  </Tooltip>
                </div>
                {isSuperAdmin && (
                  <div className="flex shrink-0 gap-1">
                    <Button variant="secondary" size="sm" onClick={openManage}>
                      <SlidersHorizontal
                        className="h-4 w-4"
                        aria-hidden="true"
                      />
                      {t("channels.manageAccounts", "Manage accounts")}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={openToken}>
                      <KeyRound className="h-4 w-4" aria-hidden="true" />
                      {t("channels.editToken", "Edit token")}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={openTeardown}
                      aria-label={t(
                        "channels.disconnectInstance",
                        "Disconnect instance",
                      )}
                    >
                      <Unplug className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                )}
              </div>

              {activeAccounts.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
                  <p className="text-sm text-text-muted">
                    {isSuperAdmin
                      ? t(
                          "channels.noActiveAccounts",
                          "No accounts are active. Manage accounts to choose which ones this workspace answers.",
                        )
                      : t(
                          "channels.noActiveAccountsTenant",
                          "No accounts are active yet. Ask an administrator to enable one.",
                        )}
                  </p>
                  {isSuperAdmin && (
                    <Button variant="secondary" size="sm" onClick={openManage}>
                      <SlidersHorizontal
                        className="h-4 w-4"
                        aria-hidden="true"
                      />
                      {t("channels.manageAccounts", "Manage accounts")}
                    </Button>
                  )}
                </div>
              ) : (
                <ul>
                  {activeAccounts.map((acct) => (
                    <li
                      key={acct.id}
                      className="flex items-center justify-between gap-4 border-border border-b py-3 pr-4 pl-8 last:border-b-0"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate text-sm text-text-primary">
                          {accountLabel(acct.accountName, acct.accountId)}
                        </span>
                        <Badge variant="secondary">{`#${acct.accountId}`}</Badge>
                        <Tooltip
                          content={t(
                            "channels.openDashboard",
                            "Open dashboard in Chatwoot",
                          )}
                        >
                          <a
                            href={`${baseUrl0.replace(/\/+$/, "")}/app/accounts/${acct.accountId}/dashboard`}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={t(
                              "channels.openDashboard",
                              "Open dashboard in Chatwoot",
                            )}
                            className="inline-flex shrink-0 items-center justify-center rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                          >
                            <ExternalLink
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                          </a>
                        </Tooltip>
                        <Tooltip
                          content={t(
                            "channels.createInbox",
                            "Create inbox in Chatwoot",
                          )}
                        >
                          <a
                            href={chatwootInboxNewUrl(baseUrl0, acct.accountId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={t(
                              "channels.createInbox",
                              "Create inbox in Chatwoot",
                            )}
                            className="inline-flex shrink-0 items-center justify-center rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                          >
                            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                          </a>
                        </Tooltip>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Tooltip
                          content={t("channels.syncInboxes", "Sync inboxes")}
                        >
                          <button
                            type="button"
                            onClick={() => syncInboxesFor(acct)}
                            disabled={busy}
                            aria-label={t(
                              "channels.syncInboxes",
                              "Sync inboxes",
                            )}
                            className="inline-flex shrink-0 items-center justify-center rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
                          >
                            <RefreshCw className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </Tooltip>
                        {isSuperAdmin && (
                          <Tooltip
                            content={t(
                              "channels.removeAccountTitle",
                              "Remove account",
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => removeAccount(acct)}
                              disabled={busy}
                              aria-label={t(
                                "channels.removeAccountTitle",
                                "Remove account",
                              )}
                              className="inline-flex shrink-0 items-center justify-center rounded p-1 text-text-muted transition-colors hover:bg-error/10 hover:text-error disabled:opacity-50"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <div>
            <h2 className="flex items-center gap-2 font-medium text-text-primary">
              <InboxIcon className="h-4 w-4 text-accent" aria-hidden="true" />
              {t("channels.inboxes", "Inboxes")}
            </h2>
            <p className="mt-0.5 text-text-muted text-xs">
              {t(
                "channels.inboxesHelp",
                'Assigning an agent connects the bot to that inbox; "No agent" leaves it silent.',
              )}
            </p>
          </div>
          {inboxes.length === 0 ? (
            <Card className="p-0">
              <EmptyState
                icon={InboxIcon}
                title={t("channels.noInboxes", "No inboxes yet")}
                description={t(
                  "channels.noInboxesDesc",
                  "Connect an instance to pull in its inboxes, then assign an agent to each one to activate it.",
                )}
              />
            </Card>
          ) : (
            inboxesByAccount.map(({ acct, items }) => {
              // A disconnected account answers nothing: its inboxes show as off, with no agent
              // picker (binding is also refused server-side until the account is reconnected).
              const disconnected = acct.disconnectedAt !== null;
              return (
                <div key={acct.id} className="flex flex-col gap-1.5">
                  {showAccountHeaders && (
                    <div className="flex items-center gap-1.5 px-1 text-text-muted text-xs">
                      <ServiceLogo
                        service="chatwoot"
                        className="h-3.5 w-3.5 shrink-0"
                      />
                      <span className="shrink-0">
                        {acct.accountName ??
                          t("channels.account", "Account {{id}}", {
                            id: acct.accountId,
                          })}
                      </span>
                      {disconnected && (
                        <Badge variant="warning">
                          {t("channels.disconnectedBadge", "Disconnected")}
                        </Badge>
                      )}
                    </div>
                  )}
                  <Card className="p-0">
                    <ul>
                      {items.map((ib) => (
                        <InboxRow
                          key={ib.id}
                          name={ib.name}
                          chatwootInboxId={ib.chatwootInboxId}
                          channelType={ib.channelType}
                          instanceBaseUrl={baseUrl0}
                          instanceAccountId={acct.accountId}
                          status={
                            disconnected || ib.agentId === null
                              ? "none"
                              : botStatus[ib.id] === "missing"
                                ? "missing"
                                : "active"
                          }
                          reconnecting={reconnecting === ib.id}
                          onReconnect={() => reconnectBot(ib.id)}
                          removing={removingInbox === ib.id}
                          onRemove={() => removeInboxMirror(ib)}
                        >
                          {disconnected ? (
                            <span className="shrink-0 text-text-muted text-xs">
                              {t(
                                "channels.accountDisconnectedOff",
                                "Account disconnected",
                              )}
                            </span>
                          ) : (
                            <InboxAgentPicker
                              value={ib.agentId}
                              agents={agents}
                              label={t("channels.bindLabel", "Answering agent")}
                              onChange={(agentId) => bindInbox(ib.id, agentId)}
                            />
                          )}
                        </InboxRow>
                      ))}
                    </ul>
                  </Card>
                </div>
              );
            })
          )}
        </section>
      </DataBoundary>

      <Modal
        modal={connectModal}
        unsavedChanges={connectDirty}
        title={t("channels.connectTitle", "Connect Chatwoot instance")}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => connectModal.close()}
              disabled={connecting}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              onClick={connectDeployment}
              loading={connecting}
              disabled={!baseUrl.trim() || baseUrlInvalid || !adminToken.trim()}
            >
              {t("common.connect", "Connect")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="flex justify-center">
            <ServiceLogo
              service="chatwoot"
              className="h-8 w-8 text-text-secondary"
            />
          </div>
          <p className="text-center text-sm text-text-muted">
            {t(
              "channels.connectDesc",
              "Enter your Chatwoot URL and admin token once. We validate them and then let you pick which accounts to answer.",
            )}
          </p>
          <FormField
            label={t("channels.baseUrl", "Base URL")}
            required
            error={
              baseUrlInvalid && baseUrl.trim()
                ? t("common.invalidUrl", "Must be a valid http(s) URL.")
                : null
            }
          >
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://chat.example.com"
            />
          </FormField>
          <FormField
            label={t("channels.adminToken", "Admin access token")}
            required
            description={t(
              "channels.adminTokenHint",
              "Stored encrypted, never shown again.",
            )}
          >
            <Input
              type="password"
              showPasswordToggle
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
            />
          </FormField>
        </div>
      </Modal>

      <Modal
        modal={tokenModal}
        unsavedChanges={newToken.trim() !== ""}
        title={t("channels.editTokenTitle", "Edit admin token")}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => tokenModal.close()}
              disabled={savingToken}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              onClick={saveToken}
              loading={savingToken}
              disabled={!newToken.trim()}
            >
              {t("common.save", "Save")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            {t(
              "channels.editTokenDesc",
              "Paste a new admin token. It is validated against your Chatwoot and shared by every account.",
            )}
          </p>
          <FormField
            label={t("channels.adminToken", "Admin access token")}
            required
            description={t(
              "channels.adminTokenHint",
              "Stored encrypted, never shown again.",
            )}
          >
            <Input
              type="password"
              showPasswordToggle
              value={newToken}
              onChange={(e) => setNewToken(e.target.value)}
            />
          </FormField>
        </div>
      </Modal>

      <Modal
        modal={manageModal}
        title={t("channels.manageTitle", "Manage accounts")}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => manageModal.close()}
              disabled={applying}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              onClick={applySelection}
              loading={applying}
              disabled={selected.size === 0}
            >
              {t("channels.enableSelected", "Enable selected ({{n}})", {
                n: selected.size,
              })}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-text-muted">
              {t(
                "channels.manageDesc",
                "Pick which of this Chatwoot's accounts this workspace answers. Active ones are managed from the list; removing one there frees it for another workspace.",
              )}
            </p>
            <Button
              variant="secondary"
              size="sm"
              onClick={resyncAccounts}
              loading={resyncing}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {t("channels.resync", "Resync")}
            </Button>
          </div>
          {manageRows.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-muted">
              {t(
                "channels.noAccounts",
                "No accounts found. Make sure your Chatwoot user is a member of the account.",
              )}
            </p>
          ) : (
            <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto">
              {manageRows.map((row) => {
                const active = !!(row.instance && !row.instance.disconnectedAt);
                // Owned by ANOTHER tenant on this shared server → cannot be claimed here.
                const claimedByOther = !!row.claim && !row.claim.isCurrent;
                const disabled = active || claimedByOther;
                const checked = active || selected.has(row.id);
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      disabled={disabled}
                      aria-pressed={checked}
                      onClick={() => toggleSelected(row.id)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed",
                        checked
                          ? "border-accent bg-accent/5"
                          : "border-border bg-bg-tertiary hover:bg-bg-hover",
                        { "opacity-60": disabled },
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-5 w-5 shrink-0 items-center justify-center rounded border",
                          checked
                            ? "border-accent bg-accent text-accent-foreground"
                            : "border-border",
                        )}
                      >
                        {checked && (
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                        {row.name}
                      </span>
                      <Badge variant="secondary">{`#${row.id}`}</Badge>
                      {active && (
                        <span className="shrink-0 text-text-muted text-xs">
                          {t("channels.statusActive", "Active")}
                        </span>
                      )}
                      {claimedByOther && (
                        <Badge variant="warning">
                          {t(
                            "channels.accountInUseBy",
                            "In use by {{tenant}}",
                            {
                              tenant:
                                row.claim?.tenantName ??
                                row.claim?.tenantId ??
                                "",
                            },
                          )}
                        </Badge>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Modal>

      <StrongConfirmModal modal={strongConfirm} />
      <ConfirmDialog modal={confirm} />
    </PageContainer>
  );
}
