import { AppWindow, KeyRound, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  EmptyState,
  useModalController,
  useToast,
} from "@/client/components";
import {
  ClientAppModal,
  type ClientAppModalPayload,
} from "@/client/components/client-apps/ClientAppModal";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";

type ListData = Awaited<
  ReturnType<(typeof api.api.v1)["client-apps"]["get"]>
>["data"];
type ClientApp = NonNullable<ListData>["clientApps"][number];

// The applications that embed this agent through the client channel's SDK (docs/client-channel.md,
// "Embedding with the SDK"): who they are, where their pages may call from, and the keys their
// servers sign users in with. Rendered only with the client channel on.

const usd = (v: number) =>
  v.toLocaleString(undefined, { style: "currency", currency: "USD" });

export function ClientAppsSection({ agentId }: { agentId: string }) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const modal = useModalController<ClientAppModalPayload>();
  const confirm = useModalController<ConfirmPayload>();
  const [apps, setApps] = useState<ClientApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    const { data, error: e } = await api.api.v1["client-apps"].get({
      query: { agentId },
    });
    if (e || !data) setError(true);
    else setApps(data.clientApps);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const date = (d: Date | string) =>
    new Date(d).toLocaleString(i18n.language, {
      dateStyle: "short",
      timeStyle: "short",
    });

  const askDelete = (app: ClientApp) =>
    confirm.open({
      title: t("clientApps.deleteTitle", "Delete {{name}}?", {
        name: app.name,
      }),
      message: t(
        "clientApps.deleteMessage",
        "Its keys go with it: every user signed in through this application loses access at once.",
      ),
      danger: true,
      confirmLabel: t("common.delete", "Delete"),
      onConfirm: async () => {
        const { error: e } = await api.api.v1["client-apps"]({
          id: app.id,
        }).delete();
        if (e) {
          showToast(
            apiErrorMessage(e) ??
              t("clientApps.deleteFailed", "Could not delete the application"),
            "error",
          );
          throw e;
        }
        await load();
      },
    });

  const askRevoke = (app: ClientApp, kid: string, current: boolean) =>
    confirm.open({
      title: t("clientApps.revokeTitle", "Revoke this key?"),
      message: current
        ? t(
            "clientApps.revokeCurrentMessage",
            "This is the current key: until you mint a new one, the application signs nobody in. Do it when you believe the key leaked.",
          )
        : t(
            "clientApps.revokeMessage",
            "Tokens signed with it stop working at once, instead of at the end of the 24 hours.",
          ),
      danger: true,
      confirmLabel: t("clientApps.revoke", "Revoke"),
      onConfirm: async () => {
        const { error: e } = await api.api.v1["client-apps"]({ id: app.id })
          .secrets({ kid })
          .delete();
        if (e) {
          showToast(
            apiErrorMessage(e) ??
              t("clientApps.revokeFailed", "Could not revoke the key"),
            "error",
          );
          throw e;
        }
        await load();
      },
    });

  return (
    <section className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-sm text-text-primary">
            {t("clientApps.title", "Embedding applications")}
          </h3>
          <p className="text-text-secondary text-xs">
            {t(
              "clientApps.subtitle",
              "Web applications that put this agent on their own pages. Each one signs its users in with a key of its own.",
            )}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => modal.open({ mode: "create", agentId })}
        >
          {t("clientApps.new", "New application")}
        </Button>
      </div>
      <DataBoundary
        loading={loading}
        error={error}
        onRetry={load}
        isEmpty={apps.length === 0}
        empty={
          <EmptyState
            icon={AppWindow}
            title={t("clientApps.emptyTitle", "No application yet")}
            description={t(
              "clientApps.emptyDescription",
              "Register the application that will embed this agent to get its key.",
            )}
          />
        }
      >
        <ul className="space-y-3">
          {apps.map((app) => (
            <li key={app.id}>
              <Card className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm text-text-primary">
                      {app.name}
                    </p>
                    <code className="font-mono text-text-tertiary text-xs">
                      {app.publicId}
                    </code>
                    {app.monthlyCeilingUsd !== null && (
                      <p className="text-text-secondary text-xs">
                        {app.monthSpendUsd === null
                          ? t(
                              "clientApps.ceilingNotRead",
                              "Monthly ceiling {{ceiling}}, this month not read yet",
                              { ceiling: usd(app.monthlyCeilingUsd) },
                            )
                          : t(
                              "clientApps.ceilingSpent",
                              "{{spent}} of {{ceiling}} this month",
                              {
                                spent: usd(app.monthSpendUsd),
                                ceiling: usd(app.monthlyCeilingUsd),
                              },
                            )}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {app.anonymousEnabled && (
                      <Badge variant="warning">
                        {t("clientApps.anonymousBadge", "Anonymous allowed")}
                      </Badge>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("common.edit", "Edit")}
                      onClick={() => modal.open({ mode: "edit", app })}
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={t("common.delete", "Delete")}
                      onClick={() => askDelete(app)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-text-secondary text-xs">
                    {t("clientApps.origins", "Allowed origins")}
                  </p>
                  <ul className="flex flex-wrap gap-1">
                    {app.allowedOrigins.map((o) => (
                      <li key={o}>
                        <code className="rounded-md bg-bg-tertiary px-1.5 py-0.5 font-mono text-text-primary text-xs">
                          {o}
                        </code>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-text-secondary text-xs">
                      {t("clientApps.keys", "Keys")}
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => modal.open({ mode: "rotate", app })}
                    >
                      <KeyRound className="h-4 w-4" aria-hidden="true" />
                      {t("clientApps.rotate", "Mint new key")}
                    </Button>
                  </div>
                  {app.secrets.length === 0 ? (
                    <p className="text-error text-xs">
                      {t(
                        "clientApps.noKey",
                        "No valid key: the application signs nobody in until you mint one.",
                      )}
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {app.secrets.map((s) => (
                        <li
                          key={s.kid}
                          className="flex items-center justify-between gap-2 text-xs"
                        >
                          <span className="min-w-0 truncate">
                            <code className="font-mono text-text-primary">
                              {s.kid}
                            </code>{" "}
                            <span className="text-text-tertiary">
                              {s.expiresAt
                                ? t(
                                    "clientApps.keyExpiring",
                                    "works until {{date}}",
                                    { date: date(s.expiresAt) },
                                  )
                                : t("clientApps.keyCurrent", "current")}
                            </span>
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              askRevoke(app, s.kid, s.expiresAt === null)
                            }
                          >
                            {t("clientApps.revoke", "Revoke")}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      </DataBoundary>
      <ClientAppModal modal={modal} onSaved={() => void load()} />
      <ConfirmDialog modal={confirm} />
    </section>
  );
}
