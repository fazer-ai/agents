import { Blocks, Plus, Trash2 } from "lucide-react";
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
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { IntegrationEditModal } from "./IntegrationEditModal";

type CatalogData = Awaited<
  ReturnType<typeof api.api.v1.integrations.catalog.get>
>["data"];
type CatalogEntry = NonNullable<CatalogData>["catalog"][number];
type InstancesData = Awaited<
  ReturnType<typeof api.api.v1.integrations.instances.get>
>["data"];
type Instance = NonNullable<InstancesData>["instances"][number];

const AUTH_STRATEGIES = ["NONE", "STATIC_HEADER", "HMAC_SHA256"] as const;

export function IntegrationsPanel() {
  const { t } = useTranslation();
  const catalogLabel = (c: CatalogEntry | undefined) => {
    switch (c?.catalogType) {
      case "GENERIC":
        return t("integrations.catalog.GENERIC.label", "Generic webhook");
      case "ASAAS":
        return t("integrations.catalog.ASAAS.label", "Asaas");
      case "GOOGLE_CALENDAR":
        return t(
          "integrations.catalog.GOOGLE_CALENDAR.label",
          "Google Calendar",
        );
      default:
        return c?.label ?? "";
    }
  };
  const kindLabel = (kind: string | undefined) => {
    switch (kind) {
      case "NATIVE":
        return t("integrations.kind.NATIVE", "Native");
      case "MCP":
        return t("integrations.kind.MCP", "MCP");
      case "TOOLPACK":
        return t("integrations.kind.TOOLPACK", "Tools");
      default:
        return kind ?? "";
    }
  };
  const authStrategyLabel = (s: (typeof AUTH_STRATEGIES)[number]) => {
    switch (s) {
      case "STATIC_HEADER":
        return t(
          "integrations.inboundAuthStrategy.STATIC_HEADER",
          "Static header",
        );
      case "HMAC_SHA256":
        return t(
          "integrations.inboundAuthStrategy.HMAC_SHA256",
          "HMAC SHA-256",
        );
      default:
        return t("integrations.inboundAuthStrategy.NONE", "None");
    }
  };
  const { showToast } = useToast();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const editModal = useModalController<{ id?: string }>();
  const confirm = useModalController<ConfirmPayload>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [cat, inst] = await Promise.all([
        api.api.v1.integrations.catalog.get(),
        api.api.v1.integrations.instances.get(),
      ]);
      if (cat.error || !cat.data || inst.error || !inst.data) {
        setError(true);
        return;
      }
      setCatalog([...cat.data.catalog]);
      setInstances([...inst.data.instances]);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function askDelete(inst: Instance) {
    confirm.open({
      title: t("integrations.deleteTitle", "Delete integration"),
      message: t("integrations.deleteMessage", 'Delete "{{name}}"?', {
        name: inst.name,
      }),
      danger: true,
      confirmLabel: t("common.delete", "Delete"),
      onConfirm: async () => {
        const { error: err } = await api.api.v1.integrations
          .instances({ id: inst.id })
          .delete();
        if (err) {
          showToast(
            apiErrorMessage(err) ||
              t("integrations.deleteError", "Could not delete."),
            "error",
          );
          throw err;
        }
        showToast(t("integrations.deleted", "Deleted."), "success");
        load();
      },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          {t(
            "integrations.subtitle",
            "Activate ready-made integrations your agents can use.",
          )}
        </p>
        <Button
          size="sm"
          onClick={() => editModal.open({})}
          disabled={catalog.length === 0}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("integrations.add", "New integration")}
        </Button>
      </div>

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={instances.length === 0}
        onRetry={load}
        empty={
          <EmptyState
            icon={Blocks}
            title={t("integrations.emptyTitle", "No integrations yet")}
            description={t(
              "integrations.emptyDesc",
              "Activate one from the catalog (e.g. Asaas, Google Calendar).",
            )}
            action={
              catalog.length > 0 ? (
                <Button size="sm" onClick={() => editModal.open({})}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t("integrations.add", "New integration")}
                </Button>
              ) : undefined
            }
          />
        }
      >
        <div className="flex flex-col gap-3">
          {instances.map((inst) => {
            const cat = catalog.find((c) => c.catalogType === inst.catalogType);
            return (
              <Card
                key={inst.id}
                className="flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-text-primary">
                      {inst.name}
                    </span>
                    <Badge variant="info">
                      {kindLabel(cat?.kind ?? inst.catalogType)}
                    </Badge>
                    {!inst.enabled && (
                      <Badge variant="secondary">
                        {t("common.disabled", "Disabled")}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-text-muted text-xs">
                    {catalogLabel(cat) || inst.catalogType}
                    {inst.inboundAuthStrategy !== "NONE"
                      ? ` · ${authStrategyLabel(inst.inboundAuthStrategy as (typeof AUTH_STRATEGIES)[number])}`
                      : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => editModal.open({ id: inst.id })}
                  >
                    {t("common.edit", "Edit")}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => askDelete(inst)}
                    aria-label={t("common.delete", "Delete")}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      </DataBoundary>

      <IntegrationEditModal modal={editModal} onSaved={() => load()} />

      <ConfirmDialog modal={confirm} />
    </div>
  );
}
