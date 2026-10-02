import { ShoppingBag } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  DataBoundary,
  EmptyState,
  PageContainer,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { formatDateTime } from "@/client/lib/utils";
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

import "@/client/merchant/index.css";

type OrdersData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.orders)["get"]>
>["data"];
type Order = NonNullable<OrdersData>["orders"][number];
type OrderStatus = Order["status"];

const STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT: "merchant.orders.status.draft",
  CONFIRMED: "merchant.orders.status.confirmed",
  PAID: "merchant.orders.status.paid",
  CANCELLED: "merchant.orders.status.cancelled",
};

const STATUS_VARIANT: Record<
  OrderStatus,
  "info" | "success" | "warning" | "error" | "secondary"
> = {
  DRAFT: "secondary",
  CONFIRMED: "info",
  PAID: "success",
  CANCELLED: "error",
};

function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat("vi-VN").format(amount)} ₫`;
}

export function OrdersPage() {
  const { t, i18n } = useTranslation();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } = await api.api.v1.merchant.orders.get({
        query: { limit: "100" },
      });
      if (err || !data) {
        setError(true);
        return;
      }
      setOrders(data.orders);
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
            {t("merchant.orders.title", "Orders")}
          </h1>
          <p className="text-sm text-text-secondary">
            {t(
              "merchant.orders.subtitle",
              "Orders attributed back to the lead that produced them.",
            )}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("merchant.orders.tableTitle", "Orders")}</CardTitle>
          <CardDescription>
            {t("merchant.orders.tableSubtitle", "Newest first.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataBoundary
            loading={loading}
            error={error}
            isEmpty={orders.length === 0}
            onRetry={() => void fetchAll()}
            empty={
              <EmptyState
                icon={ShoppingBag}
                title={t("merchant.orders.emptyTitle", "No orders yet")}
                description={t(
                  "merchant.orders.emptyDescription",
                  "Orders appear here once a lead converts.",
                )}
              />
            }
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("merchant.orders.colId", "Order")}</TableHead>
                  <TableHead>
                    {t("merchant.orders.colContact", "Contact")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.orders.colItems", "Items")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.orders.colTotal", "Total")}
                  </TableHead>
                  <TableHead>{t("merchant.orders.colLead", "Lead")}</TableHead>
                  <TableHead>
                    {t("merchant.orders.colStatus", "Status")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.orders.colCreated", "Created")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((order) => (
                  <TableRow key={order.id}>
                    <TableCell className="font-medium">{`#${order.id}`}</TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span>{order.contactName ?? "-"}</span>
                        {order.contactPhone && (
                          <span className="text-muted-foreground text-xs">
                            {order.contactPhone}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <div className="flex flex-wrap gap-1">
                        {order.items.map((i) => (
                          <Badge key={i.id} variant="secondary">
                            {`${i.qty}× ${i.productName ?? "?"}`}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatVnd(order.totalAmount)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {order.leadAuthorName ?? "-"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[order.status]}>
                        {
                          // t('merchant.orders.status.draft', 'Draft')
                          // t('merchant.orders.status.confirmed', 'Confirmed')
                          // t('merchant.orders.status.paid', 'Paid')
                          // t('merchant.orders.status.cancelled', 'Cancelled')
                          // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in STATUS_LABEL
                          t(STATUS_LABEL[order.status], order.status)
                        }
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(order.createdAt, i18n.language)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataBoundary>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
