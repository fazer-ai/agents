import { Megaphone, Plus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  DataBoundary,
  EmptyState,
  PageContainer,
  useModalController,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { formatDateTime } from "@/client/lib/utils";
import { BroadcastCreateModal } from "@/client/merchant/components/BroadcastCreateModal";
import { BroadcastDetailModal } from "@/client/merchant/components/BroadcastDetailModal";
import { Button } from "@/client/merchant/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/client/merchant/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/merchant/components/ui/table";

// Merchant-shadcn theme tokens. Importing the CSS here keeps every merchant asset
// inside src/client/merchant/ - App.tsx only needs the page import + one <Route>.
import "@/client/merchant/index.css";

// Derived from the treaty response; never hand-mirrored (see docs/eden-treaty.md).
type BroadcastsData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.broadcasts)["get"]>
>["data"];
type Broadcast = NonNullable<BroadcastsData>["broadcasts"][number];
type BroadcastStatus = Broadcast["status"];

const STATUS_LABEL: Record<BroadcastStatus, string> = {
  DRAFT: "merchant.broadcasts.status.draft",
  READY: "merchant.broadcasts.status.ready",
  SENT: "merchant.broadcasts.status.sent",
};

const STATUS_VARIANT: Record<
  BroadcastStatus,
  "secondary" | "primary" | "success"
> = {
  DRAFT: "secondary",
  READY: "primary",
  SENT: "success",
};

export function BroadcastsPage() {
  const { t, i18n } = useTranslation();
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const createModal = useModalController();
  const detailModal = useModalController<{ id: string }>();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } = await api.api.v1.merchant.broadcasts.get({
        query: { limit: "100" },
      });
      if (err || !data) {
        setError(true);
        return;
      }
      setBroadcasts(data.broadcasts);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  return (
    <PageContainer size="wide">
      <div className="flex items-center justify-between gap-4 py-4">
        <div>
          <h1 className="font-semibold text-text-primary text-xl">
            {t("merchant.broadcasts.title", "Broadcasts")}
          </h1>
          <p className="text-sm text-text-secondary">
            {t(
              "merchant.broadcasts.subtitle",
              "One-to-many outreach composed once, sent by hand - nothing posts outward.",
            )}
          </p>
        </div>
        <Button onClick={() => createModal.open()}>
          <Plus className="size-4" />
          {t("merchant.broadcasts.create", "New broadcast")}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {t("merchant.broadcasts.tableTitle", "Broadcasts")}
          </CardTitle>
          <CardDescription>
            {t(
              "merchant.broadcasts.tableSubtitle",
              "Newest first. The audience resolves once at create; the send rail is manual.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataBoundary
            loading={loading}
            error={error}
            isEmpty={broadcasts.length === 0}
            onRetry={() => void fetchAll()}
            empty={
              <EmptyState
                icon={Megaphone}
                title={t("merchant.broadcasts.emptyTitle", "No broadcasts yet")}
                description={t(
                  "merchant.broadcasts.emptyDescription",
                  "Compose one to draft a message for a filtered audience of leads.",
                )}
              />
            }
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {t("merchant.broadcasts.colName", "Name")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.broadcasts.colAudience", "Audience")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.broadcasts.colStatus", "Status")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.broadcasts.colSent", "Sent")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.broadcasts.colCreated", "Created")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.broadcasts.colActions", "Actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {broadcasts.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell className="font-medium">{b.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{b.recipientCount}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[b.status]}>
                        {
                          // t('merchant.broadcasts.status.draft', 'Draft')
                          // t('merchant.broadcasts.status.ready', 'Ready')
                          // t('merchant.broadcasts.status.sent', 'Sent')
                          // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in STATUS_LABEL
                          t(STATUS_LABEL[b.status] ?? b.status, b.status)
                        }
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {b.sentCount}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(b.createdAt, i18n.language)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => detailModal.open({ id: b.id })}
                      >
                        {t("merchant.broadcasts.open", "Open")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataBoundary>
        </CardContent>
      </Card>
      <BroadcastCreateModal
        modal={createModal}
        onCreated={() => void fetchAll()}
      />
      <BroadcastDetailModal
        modal={detailModal}
        onChanged={() => void fetchAll()}
      />
    </PageContainer>
  );
}
