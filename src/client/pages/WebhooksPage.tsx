import { Pencil, Plus, Send, Trash2, Webhook } from "lucide-react";
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
  PageContainer,
  Switch,
  Tooltip,
  useModalController,
  useToast,
} from "@/client/components";
import { AlertChannelsSection } from "@/client/components/alerts/AlertChannelsSection";
import {
  type WebhookModalPayload,
  type WebhookSubscription,
  WebhookSubscriptionModal,
} from "@/client/components/webhooks/WebhookSubscriptionModal";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { formatDate } from "@/client/lib/utils";
import { webhookEventLabel } from "@/client/lib/webhookEvents";

// Outbound webhook subscriptions console (TENANT_ADMIN). Lists targets, creates/edits via a modal,
// toggles enabled inline, and deletes with a confirm. The secret value never appears here — only
// the vault reference name. The event catalog is fetched once for the modal.

export function WebhooksPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [subscriptions, setSubscriptions] = useState<WebhookSubscription[]>([]);
  const [events, setEvents] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const modal = useModalController<WebhookModalPayload>();
  const confirm = useModalController<ConfirmPayload>();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [subs, evs] = await Promise.all([
        api.api.v1.webhooks.subscriptions.get(),
        api.api.v1.webhooks.events.get(),
      ]);
      if (subs.error || evs.error) {
        setError(true);
        return;
      }
      setSubscriptions(subs.data?.subscriptions ?? []);
      setEvents(evs.data?.events ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const toggleEnabled = async (sub: WebhookSubscription) => {
    const next = !sub.enabled;
    // Optimistic flip; revert + toast on failure.
    setSubscriptions((prev) =>
      prev.map((s) => (s.id === sub.id ? { ...s, enabled: next } : s)),
    );
    const { error: err } = await api.api.v1.webhooks
      .subscriptions({ id: sub.id })
      .patch({ enabled: next });
    if (err) {
      setSubscriptions((prev) =>
        prev.map((s) => (s.id === sub.id ? { ...s, enabled: sub.enabled } : s)),
      );
      showToast(
        apiErrorMessage(err) ||
          t("webhooks.saveFailed", "Could not save the subscription"),
        "error",
      );
    }
  };

  const runTest = async (sub: WebhookSubscription) => {
    setTestingId(sub.id);
    try {
      const { data, error: err } = await api.api.v1.webhooks
        .subscriptions({ id: sub.id })
        .test.post();
      const result = data?.result;
      if (err || !result) {
        showToast(
          apiErrorMessage(err) ||
            t("webhooks.testFailed", "Test delivery failed"),
          "error",
        );
        return;
      }
      if (result.ok) {
        showToast(
          t("webhooks.testDelivered", "Test delivered ({{status}})", {
            status: result.status ?? 200,
          }),
          "success",
        );
      } else {
        // A 200 carrying the TARGET's rejection, not a refusal of ours: `err` is null by the guard
        // above, and `result.error` is the reason the endpoint gave. Reading `err` here would be the
        // sweep's own idiom applied where it can only ever answer null.
        showToast(
          t("webhooks.testFailedReason", "Test failed: {{reason}}", {
            reason: result.error ?? String(result.status ?? "unknown"),
          }),
          "error",
        );
      }
    } catch {
      showToast(t("webhooks.testFailed", "Test delivery failed"), "error");
    } finally {
      setTestingId(null);
    }
  };

  const requestDelete = (sub: WebhookSubscription) => {
    confirm.open({
      title: t("webhooks.deleteTitle", "Delete subscription"),
      message: t(
        "webhooks.deleteMessage",
        "This endpoint will stop receiving events. This cannot be undone.",
      ),
      confirmLabel: t("common.delete", "Delete"),
      danger: true,
      onConfirm: async () => {
        const { error: err } = await api.api.v1.webhooks
          .subscriptions({ id: sub.id })
          .delete();
        if (err) {
          showToast(
            apiErrorMessage(err) ||
              t("webhooks.deleteFailed", "Could not delete the subscription"),
            "error",
          );
          throw new Error("delete failed");
        }
        showToast(t("webhooks.deleted", "Subscription deleted"), "success");
        void fetchAll();
      },
    });
  };

  return (
    <PageContainer className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-bold text-2xl text-text-primary">
            {t("webhooks.title", "Webhooks")}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t(
              "webhooks.subtitle",
              "Send signed events to your own endpoints when things happen in this workspace.",
            )}
          </p>
        </div>
        <Button onClick={() => modal.open({})}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("webhooks.create", "New subscription")}
        </Button>
      </header>

      <WebhookSubscriptionModal
        modal={modal}
        events={events}
        onSaved={() => {
          showToast(t("webhooks.saved", "Subscription saved"), "success");
          void fetchAll();
        }}
      />
      <ConfirmDialog modal={confirm} />

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={subscriptions.length === 0}
        onRetry={() => void fetchAll()}
        empty={
          <EmptyState
            icon={Webhook}
            title={t("webhooks.emptyTitle", "No webhooks yet")}
            description={t(
              "webhooks.emptyDescription",
              "Create a subscription to forward events to an external endpoint.",
            )}
          />
        }
      >
        <div className="flex flex-col gap-3">
          {subscriptions.map((sub) => (
            <Card
              key={sub.id}
              className="flex flex-wrap items-center justify-between gap-4"
            >
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-sm text-text-primary">
                    {sub.url}
                  </span>
                  {!sub.enabled && (
                    <Badge variant="secondary">
                      {t("webhooks.disabled", "Disabled")}
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {sub.events.map((ev) => (
                    <Badge key={ev} variant="secondary">
                      <Tooltip content={ev}>
                        <span>{webhookEventLabel(ev, t)}</span>
                      </Tooltip>
                    </Badge>
                  ))}
                </div>
                <span className="text-text-muted text-xs">
                  {sub.secretRef
                    ? t("webhooks.signedWith", "Signed with: {{ref}}", {
                        ref: sub.secretRef,
                      })
                    : t("webhooks.unsigned", "Unsigned")}
                  {" · "}
                  {t("webhooks.createdAt", "Created {{date}}", {
                    date: formatDate(sub.createdAt),
                  })}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={sub.enabled}
                  onCheckedChange={() => void toggleEnabled(sub)}
                  aria-label={t("webhooks.enabled", "Enabled")}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={testingId === sub.id}
                  disabled={testingId === sub.id}
                  onClick={() => void runTest(sub)}
                >
                  <Send className="h-4 w-4" aria-hidden="true" />
                  {t("webhooks.test", "Test")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => modal.open({ subscription: sub })}
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  {t("common.edit", "Edit")}
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => requestDelete(sub)}
                  aria-label={t("webhooks.deleteAria", "Delete subscription")}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      </DataBoundary>

      <AlertChannelsSection />
    </PageContainer>
  );
}
