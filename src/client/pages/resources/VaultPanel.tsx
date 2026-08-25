import { KeyRound, Link2, Plus, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import {
  Badge,
  Button,
  Card,
  CredentialForm,
  DataBoundary,
  EmptyState,
  Modal,
  useModalController,
  useToast,
} from "@/client/components";
import { ServiceLogo } from "@/client/components/icons/ServiceLogo";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { secretTypeService } from "@/client/lib/secretTypes";
import { cn } from "@/client/lib/utils";
import { invalidateVault } from "@/client/lib/vaultCache";

// Derived from the treaty response, never hand-mirrored (see docs/eden-treaty.md).
type References = NonNullable<
  Awaited<
    ReturnType<ReturnType<typeof api.api.v1.vault>["references"]["get"]>
  >["data"]
>["references"];

// Derived from the treaty response; never hand-mirrored (see docs/eden-treaty.md).
type VaultEntry = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.vault.get>>["data"]
>["entries"][number];

// Per-secret-type label. Magic comments below register the dynamic keys for the extractor.
// t('vault.secretType.generic', 'Generic')
// t('vault.secretType.bearer_token', 'Bearer token')
// t('vault.secretType.chatwoot_api_token', 'Chatwoot')
// t('vault.secretType.header', 'Header')
// t('vault.secretType.basic_auth', 'Basic auth')
// t('vault.secretType.query', 'Query')
// t('vault.secretType.openai', 'OpenAI')
// t('vault.secretType.anthropic', 'Anthropic')
// t('vault.secretType.gemini', 'Google Gemini')
// t('vault.secretType.deepseek', 'DeepSeek')
// t('vault.secretType.openrouter', 'OpenRouter')
// t('vault.secretType.openai_compatible', 'OpenAI-compatible')
// t('vault.secretType.elevenlabs', 'ElevenLabs')
// t('vault.secretType.asaas', 'Asaas')
// t('vault.secretType.google_oauth', 'Google OAuth2')
// t('vault.secretType.mcp_oauth', 'MCP OAuth2')
// t('vault.secretType.mcp_env', 'MCP env var')

// Vault: secrets are write-only. The list shows names + their type + a "set" indicator only;
// values are never returned by the API. Setting overwrites (mask-after-save). The type (kind)
// drives automatic credential injection where the secret is referenced (see secret-types.ts).
export function VaultPanel() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");

  const editModal = useModalController<{
    id?: string;
    name?: string;
    kind?: string | null;
    baseUrl?: string | null;
    paramName?: string | null;
    // "fill" mode: completing a PENDING entry (reference created without a secret). Opened via the
    // ?fill=<id> deeplink; behaves like update but the secret value becomes mandatory.
    fill?: boolean;
  }>();
  const refsModal = useModalController<{ id: string; name: string }>();
  const deleteModal = useModalController<{ id: string; name: string }>();

  const [refs, setRefs] = useState<References | null>(null);
  const [deleteRefs, setDeleteRefs] = useState<References | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } = await api.api.v1.vault.get();
      if (err || !data) {
        setError(true);
        return;
      }
      setEntries([...data.entries]);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Deeplink: /resources/vault?fill=<id> opens the fill modal for a pending entry once the list is
  // loaded, then strips the param so a re-render / back-nav doesn't re-open it.
  //
  // A MISS keeps the parameter and says so. The id belongs to a tenant, and the console resolves the
  // tenant from localStorage: a link built for another one finds nothing here (issue #151). Stripping
  // it on the way, which is what used to happen, spent the link on a page that then looked like an
  // ordinary navigation, so there was nothing to retry and nothing on screen explaining it. Kept, the
  // operator switches tenant in the header (a full reload) and the same URL resolves.
  const [searchParams, setSearchParams] = useSearchParams();
  const fillId = searchParams.get("fill");
  const missReported = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per fill target; clearing the param makes fillId null so it won't re-fire.
  useEffect(() => {
    if (!fillId || loading) return;
    // A failed load leaves `entries` empty, which is indistinguishable from "the tenant does not
    // have it" and is not the same claim at all. Say nothing and leave the parameter: the panel's
    // own error state is already on screen with its retry, and it is the honest diagnosis.
    if (error) return;
    const entry = entries.find((e) => e.id === fillId);
    if (!entry) {
      if (missReported.current !== fillId) {
        missReported.current = fillId;
        showToast(
          t(
            "vault.fillLinkNotHere",
            "That credential is not in the tenant you have open. Switch tenant and follow the link again.",
          ),
          "error",
        );
      }
      return;
    }
    editModal.open({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      baseUrl: entry.baseUrl,
      paramName: entry.paramName,
      fill: true,
    });
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("fill");
        return next;
      },
      { replace: true },
    );
  }, [fillId, loading, entries, error]);

  function openCreate() {
    editModal.open({});
  }
  function openUpdate(e: VaultEntry) {
    editModal.open({
      id: e.id,
      name: e.name,
      kind: e.kind,
      baseUrl: e.baseUrl,
      paramName: e.paramName,
      // A pending entry opens straight into "fill" mode (the secret becomes mandatory).
      fill: e.status === "pending",
    });
  }

  const isUpdate = !!editModal.payload?.name;
  const isFill = !!editModal.payload?.fill;

  async function loadRefs(id: string): Promise<References | null> {
    const { data } = await api.api.v1.vault({ id }).references.get();
    return data ? data.references : null;
  }

  async function openRefs(e: VaultEntry) {
    setRefs(null);
    refsModal.open({ id: e.id, name: e.name });
    setRefs(await loadRefs(e.id));
  }

  async function askDelete(e: VaultEntry) {
    setDeleteRefs(null);
    deleteModal.open({ id: e.id, name: e.name });
    setDeleteRefs(await loadRefs(e.id));
  }

  async function confirmDelete() {
    const id = deleteModal.payload?.id;
    if (!id) return;
    setDeleting(true);
    try {
      const { error: err } = await api.api.v1.vault({ id }).delete();
      if (err) {
        showToast(
          apiErrorMessage(err) || t("vault.deleteError", "Could not delete."),
          "error",
        );
        return;
      }
      showToast(t("vault.deleted", "Secret deleted."), "success");
      deleteModal.close();
      invalidateVault();
      load();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          {t(
            "vault.subtitle",
            "API keys and tokens your agents and integrations use.",
          )}
        </p>
        {entries.length > 0 && (
          <div className="relative w-64 max-w-xs">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-muted"
              aria-hidden="true"
            />
            <input
              value={query}
              onChange={(ev) => setQuery(ev.target.value)}
              placeholder={t(
                "vault.searchPlaceholder",
                "Search by name or type…",
              )}
              aria-label={t(
                "vault.searchPlaceholder",
                "Search by name or type…",
              )}
              className={cn(
                "w-full rounded-lg border border-border bg-bg-tertiary py-1.5 pl-9 text-sm text-text-primary placeholder-text-placeholder focus:border-border-focus focus:outline-none",
                { "pr-8": !!query, "pr-4": !query },
              )}
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-3 -translate-y-1/2 text-text-muted hover:text-text-primary"
                aria-label={t("common.clearSearch", "Clear search")}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        <Button size="sm" onClick={openCreate}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("vault.add", "Add secret")}
        </Button>
      </div>

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={entries.length === 0}
        onRetry={load}
        empty={
          <EmptyState
            icon={KeyRound}
            title={t("vault.emptyTitle", "No secrets yet")}
            description={t(
              "vault.emptyDesc",
              "Add API keys and tokens for your tools and integrations to use.",
            )}
            action={
              <Button size="sm" onClick={openCreate}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {t("vault.add", "Add secret")}
              </Button>
            }
          />
        }
      >
        <Card className="p-0">
          {(() => {
            const q = query.trim().toLowerCase();
            const filtered = q
              ? entries.filter((e) => {
                  const kindLabel = e.kind
                    ? // biome-ignore lint/plugin/no-dynamic-i18n-key: secret-type keys registered via magic comments
                      t(`vault.secretType.${e.kind}`, e.kind).toLowerCase()
                    : "";
                  return (
                    e.name.toLowerCase().includes(q) ||
                    (e.kind ?? "").toLowerCase().includes(q) ||
                    kindLabel.includes(q)
                  );
                })
              : entries;

            if (q && filtered.length === 0) {
              return (
                <p className="px-4 py-3 text-sm text-text-muted">
                  {t("vault.noSearchResults", "No secrets match your search.")}
                </p>
              );
            }

            return (
              <ul>
                {filtered.map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center justify-between gap-3 border-border border-b px-4 py-3 last:border-b-0"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <ServiceLogo
                        service={secretTypeService(e.kind)}
                        className="h-4 w-4 shrink-0 text-text-muted"
                      />
                      <div className="min-w-0">
                        <span className="truncate font-mono text-sm text-text-primary">
                          {e.name}
                        </span>
                        {e.baseUrl && (
                          <p className="truncate text-text-muted text-xs">
                            {e.baseUrl}
                          </p>
                        )}
                      </div>
                      {e.kind && e.kind !== "generic" && (
                        <Badge variant="info">
                          {/* biome-ignore lint/plugin/no-dynamic-i18n-key: secret-type keys registered via magic comments */}
                          {t(`vault.secretType.${e.kind}`, e.kind)}
                        </Badge>
                      )}
                      {e.status === "pending" && (
                        <Badge variant="warning">
                          {t("vault.statusPending", "Pending")}
                        </Badge>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openRefs(e)}
                      >
                        <Link2 className="h-4 w-4" aria-hidden="true" />
                        {t("vault.references", "Usage")}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openUpdate(e)}
                      >
                        {e.status === "pending"
                          ? t("vault.fill", "Fill")
                          : t("vault.update", "Update")}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => askDelete(e)}
                        aria-label={t("common.delete", "Delete")}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            );
          })()}
        </Card>
      </DataBoundary>

      <Modal
        modal={editModal}
        title={
          isFill
            ? t("vault.fillTitle", "Fill pending credential")
            : isUpdate
              ? t("vault.updateTitle", "Update secret")
              : t("vault.addTitle", "Add secret")
        }
      >
        <CredentialForm
          mode={isUpdate ? "update" : "create"}
          requireValue={isFill}
          initialId={editModal.payload?.id}
          initialName={editModal.payload?.name}
          initialKind={editModal.payload?.kind ?? "generic"}
          initialBaseUrl={editModal.payload?.baseUrl ?? undefined}
          initialParamName={editModal.payload?.paramName ?? undefined}
          onSaved={() => {
            editModal.close();
            invalidateVault();
            load();
          }}
          onCancel={() => editModal.close()}
        />
      </Modal>

      <Modal
        modal={refsModal}
        title={t("vault.usageTitle", "Where this secret is used")}
      >
        <RefList refs={refs} />
      </Modal>

      <Modal
        modal={deleteModal}
        size="sm"
        title={t("vault.deleteTitle", "Delete secret")}
        onCloseRequest={deleting ? () => undefined : undefined}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => deleteModal.close()}
              disabled={deleting}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button variant="danger" onClick={confirmDelete} loading={deleting}>
              {t("common.delete", "Delete")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            {t(
              "vault.deleteMessage",
              'Delete "{{name}}"? Anything using it will stop working.',
              { name: deleteModal.payload?.name ?? "" },
            )}
          </p>
          <RefList refs={deleteRefs} />
        </div>
      </Modal>
    </div>
  );
}

// Shared usage list rendered in both the "Usage" modal and the delete dialog. `null` = still loading.
function RefList({ refs }: { refs: References | null }) {
  const { t } = useTranslation();
  if (!refs) {
    return (
      <p className="text-sm text-text-muted">
        {t("common.loading", "Loading…")}
      </p>
    );
  }
  const empty =
    refs.toolDefinitions.length === 0 &&
    refs.mcpConnections.length === 0 &&
    refs.integrations.length === 0 &&
    refs.agents.length === 0 &&
    refs.webhooks.length === 0 &&
    refs.alertChannels.length === 0 &&
    refs.tenantSettings.length === 0;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <RefGroup
        label={t("vault.refTools", "Tools")}
        items={refs.toolDefinitions.map((n) => ({
          key: n,
          label: n,
          to: "/resources/tools",
        }))}
      />
      <RefGroup
        label={t("vault.refMcp", "MCP servers")}
        items={refs.mcpConnections.map((n) => ({
          key: n,
          label: n,
          to: "/resources/mcp",
        }))}
      />
      <RefGroup
        label={t("vault.refIntegrations", "Integrations")}
        items={refs.integrations.map((n) => ({
          key: n,
          label: n,
          to: "/resources/integrations",
        }))}
      />
      <RefGroup
        label={t("vault.refAgents", "Agents")}
        items={refs.agents.map((a) => ({
          key: a.id,
          label: a.name,
          to: `/agents/${a.id}`,
        }))}
      />
      <RefGroup
        label={t("vault.refWebhooks", "Webhooks")}
        items={refs.webhooks.map((u) => ({
          key: u,
          label: u,
          to: "/webhooks",
        }))}
      />
      <RefGroup
        label={t("vault.refAlertChannels", "Alert channels")}
        items={refs.alertChannels.map((n) => ({
          key: n,
          label: n,
          to: "/webhooks",
        }))}
      />
      <RefGroup
        label={t("vault.refTenantSettings", "Tenant settings")}
        items={refs.tenantSettings.map((k) => ({
          key: k,
          // biome-ignore lint/plugin/no-dynamic-i18n-key: tenant-setting keys registered via magic comments
          label: t(`vault.tenantSetting.${k}`, k),
          to: "/resources/advanced",
        }))}
      />
      {empty && (
        <p className="text-text-muted">
          {t("vault.noRefs", "Not referenced anywhere.")}
        </p>
      )}
    </div>
  );
}

// Magic comments register the dynamic tenant-setting keys for the i18n extractor.
// t('vault.tenantSetting.embedding', 'Knowledge base embeddings')
// t('vault.tenantSetting.langfuse', 'Observability (Langfuse)')

interface RefItem {
  key: string;
  label: string;
  // Deep link to where the reference lives (agent editor) or the closest panel. Clicking navigates
  // away (and closes the modal) — an acceptable trade for one-click reachability.
  to?: string;
}

function RefGroup({ label, items }: { label: string; items: RefItem[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 font-medium text-text-secondary text-xs uppercase">
        {label}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((i) =>
          i.to ? (
            <Link key={i.key} to={i.to}>
              <Badge
                variant="secondary"
                className="transition-colors hover:bg-bg-hover"
              >
                {i.label}
              </Badge>
            </Link>
          ) : (
            <Badge key={i.key} variant="secondary">
              {i.label}
            </Badge>
          ),
        )}
      </div>
    </div>
  );
}
