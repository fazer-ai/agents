import { KeyRound, Plus, Trash2 } from "lucide-react";
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
  useModalController,
  useToast,
} from "@/client/components";
import { CreateApiKeyModal } from "@/client/components/api-keys/CreateApiKeyModal";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { formatDate } from "@/client/lib/utils";

// Derived from the treaty response; never hand-mirrored (see docs/eden-treaty.md).
type ApiKeysData = Awaited<
  ReturnType<(typeof api.api.v1)["api-keys"]["get"]>
>["data"];
type ApiKey = NonNullable<ApiKeysData>["apiKeys"][number];

// Per-tenant API keys console (TENANT_ADMIN). Lists keys, creates via a modal (the plaintext token is
// revealed once), and revokes with a confirm. The same key authenticates the REST v1 API and the MCP
// transport. The hash/plaintext never appear here — only the display prefix.
export function ApiKeysPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const createModal = useModalController();
  const confirm = useModalController<ConfirmPayload>();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } = await api.api.v1["api-keys"].get();
      if (err || !data) {
        setError(true);
        return;
      }
      setKeys(data.apiKeys);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const requestRevoke = (key: ApiKey) => {
    confirm.open({
      title: t("apiKeys.revokeTitle", "Revoke API key"),
      message: t(
        "apiKeys.revokeMessage",
        "Any client using this key will stop working immediately. This cannot be undone.",
      ),
      confirmLabel: t("apiKeys.revoke", "Revoke"),
      danger: true,
      onConfirm: async () => {
        const { error: err } = await api.api.v1["api-keys"]({
          id: key.id,
        }).delete();
        if (err) {
          showToast(
            apiErrorMessage(err) ||
              t("apiKeys.revokeFailed", "Could not revoke the key"),
            "error",
          );
          throw new Error("revoke failed");
        }
        showToast(t("apiKeys.revoked", "API key revoked"), "success");
        void fetchAll();
      },
    });
  };

  return (
    <PageContainer className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-bold text-2xl text-text-primary">
            {t("apiKeys.title", "API keys")}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {t(
              "apiKeys.subtitle",
              "Bearer keys for external clients of the REST API and the MCP server. Send as Authorization: Bearer <key>.",
            )}
          </p>
        </div>
        <Button onClick={() => createModal.open()}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("apiKeys.create", "Create key")}
        </Button>
      </header>

      <CreateApiKeyModal
        modal={createModal}
        onCreated={() => void fetchAll()}
      />
      <ConfirmDialog modal={confirm} />

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={keys.length === 0}
        onRetry={() => void fetchAll()}
        empty={
          <EmptyState
            icon={KeyRound}
            title={t("apiKeys.emptyTitle", "No API keys yet")}
            description={t(
              "apiKeys.emptyDescription",
              "Create a key to let an external client call the REST API or the MCP server.",
            )}
          />
        }
      >
        <div className="flex flex-col gap-3">
          {keys.map((key) => (
            <Card
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-4"
            >
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-sm text-text-primary">
                    {key.displayName}
                  </span>
                  {key.revokedAt && (
                    <Badge variant="secondary">
                      {t("apiKeys.revokedBadge", "Revoked")}
                    </Badge>
                  )}
                </div>
                <code className="w-fit rounded bg-bg-tertiary px-1.5 py-0.5 font-mono text-text-secondary text-xs">
                  {`${key.keyPrefix}…`}
                </code>
                <span className="text-text-muted text-xs">
                  {key.lastUsedAt
                    ? t("apiKeys.lastUsed", "Last used {{date}}", {
                        date: formatDate(key.lastUsedAt),
                      })
                    : t("apiKeys.neverUsed", "Never used")}
                  {" · "}
                  {t("apiKeys.createdAt", "Created {{date}}", {
                    date: formatDate(key.createdAt),
                  })}
                </span>
              </div>
              {!key.revokedAt && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => requestRevoke(key)}
                  aria-label={t("apiKeys.revokeAria", "Revoke API key")}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t("apiKeys.revoke", "Revoke")}
                </Button>
              )}
            </Card>
          ))}
        </div>
      </DataBoundary>
    </PageContainer>
  );
}
