import type { TFunction } from "i18next";
import { BarChart3, ShoppingBag, TrendingUp, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  DataBoundary,
  EmptyState,
  PageContainer,
} from "@/client/components";
import { api } from "@/client/lib/api";
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

// Merchant analytics: the read-only funnel rollup. Stat cards up top, then
// breakdown tables with plain div bars - no chart lib, the numbers are the UI.

type SummaryData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.analytics.summary)["get"]>
>["data"];
type Summary = NonNullable<SummaryData>["summary"];

const LEAD_STATUS_VARIANT: Record<
  string,
  "success" | "info" | "secondary" | "warning" | "error"
> = {
  NEW: "info",
  CONTACTED: "warning",
  QUALIFIED: "info",
  CONVERTED: "success",
  DEAD: "secondary",
};

const ORDER_STATUS_VARIANT: Record<
  string,
  "success" | "info" | "secondary" | "warning" | "error"
> = {
  DRAFT: "secondary",
  CONFIRMED: "info",
  PAID: "success",
  CANCELLED: "error",
};

function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat("vi-VN").format(amount)} ₫`;
}

// Status badge labels; the keys already exist under merchant.leads/orders.status.
// t('merchant.leads.status.new', 'New')
// t('merchant.leads.status.contacted', 'Contacted')
// t('merchant.leads.status.qualified', 'Qualified')
// t('merchant.leads.status.converted', 'Converted')
// t('merchant.leads.status.dead', 'Dead')
function leadStatusLabel(t: TFunction, status: string): string {
  // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments above
  return t(`merchant.leads.status.${status.toLowerCase()}`, status);
}

// t('merchant.orders.status.draft', 'Draft')
// t('merchant.orders.status.confirmed', 'Confirmed')
// t('merchant.orders.status.paid', 'Paid')
// t('merchant.orders.status.cancelled', 'Cancelled')
function orderStatusLabel(t: TFunction, status: string): string {
  // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments above
  return t(`merchant.orders.status.${status.toLowerCase()}`, status);
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 pt-6">
        <div className="rounded-md bg-muted p-2 text-muted-foreground">
          {icon}
        </div>
        <div className="flex flex-col">
          <span className="text-muted-foreground text-xs">{label}</span>
          <span className="font-semibold text-2xl">{value}</span>
          <span className="text-muted-foreground text-xs">{sub}</span>
        </div>
      </CardContent>
    </Card>
  );
}

// Proportional bar behind a count cell: count / max of the column.
function BarCell({ count, max }: { count: number; max: number }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 rounded bg-muted">
        <div
          className="h-2 rounded bg-primary"
          style={{ width: `${Math.max(pct, count > 0 ? 4 : 0)}%` }}
        />
      </div>
      <span className="text-sm">{count}</span>
    </div>
  );
}

// 14-day lead-count sparkline as plain bars, oldest on the left.
function LeadsSparkline({ days }: { days: Summary["leadsPerDay"] }) {
  const max = Math.max(1, ...days.map((d) => d.count));
  return (
    <div className="flex h-16 items-end gap-1">
      {days.map((d) => (
        <div
          key={d.day}
          className="flex-1 rounded-sm bg-primary/70"
          style={{ height: `${(d.count / max) * 100}%` }}
          title={`${d.day}: ${d.count}`}
        />
      ))}
    </div>
  );
}

export function AnalyticsPage() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } =
        await api.api.v1.merchant.analytics.summary.get();
      if (err || !data) {
        setError(true);
        return;
      }
      setSummary(data.summary);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const statusMax = Math.max(
    1,
    ...(summary?.leads.byStatus.map((r) => r.count) ?? [0]),
  );
  const platformMax = Math.max(
    1,
    ...(summary?.leads.byPlatform.map((r) => r.count) ?? [0]),
  );
  const sourceMax = Math.max(
    1,
    ...(summary?.leads.bySource.map((r) => r.count) ?? [0]),
  );
  const productMax = Math.max(
    1,
    ...(summary?.topProducts.map((r) => r.matches) ?? [0]),
  );

  return (
    <PageContainer size="wide">
      <div className="flex items-center justify-between gap-4 py-4">
        <div>
          <h1 className="font-semibold text-text-primary text-xl">
            {t("merchant.analytics.title", "Analytics")}
          </h1>
          <p className="text-sm text-text-secondary">
            {t(
              "merchant.analytics.subtitle",
              "The funnel from discovered post to paid order, read-only.",
            )}
          </p>
        </div>
      </div>

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={summary === null}
        onRetry={() => void fetchAll()}
        empty={
          <EmptyState
            icon={BarChart3}
            title={t("merchant.analytics.emptyTitle", "No data yet")}
            description={t(
              "merchant.analytics.emptyDescription",
              "Leads and orders appear here as the pipeline fills.",
            )}
          />
        }
      >
        {summary && (
          <div className="flex flex-col gap-6 pb-8">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
              <StatCard
                icon={<Users className="h-4 w-4" aria-hidden="true" />}
                label={t("merchant.analytics.leadsTotal", "Leads")}
                value={String(summary.leads.total)}
                sub={t("merchant.analytics.leadsTotalSub", "all statuses")}
              />
              <StatCard
                icon={<TrendingUp className="h-4 w-4" aria-hidden="true" />}
                label={t("merchant.analytics.conversion", "Conversion")}
                value={`${summary.conversion.pct}%`}
                sub={t(
                  "merchant.analytics.conversionSub",
                  "{{count}} converted leads",
                  { count: summary.conversion.convertedLeads },
                )}
              />
              <StatCard
                icon={<ShoppingBag className="h-4 w-4" aria-hidden="true" />}
                label={t("merchant.analytics.ordersTotal", "Orders")}
                value={String(summary.orders.total)}
                sub={formatVnd(summary.orders.totalAmount)}
              />
              <StatCard
                icon={<BarChart3 className="h-4 w-4" aria-hidden="true" />}
                label={t("merchant.analytics.fromLeads", "From leads")}
                value={String(summary.orders.fromLeads)}
                sub={t(
                  "merchant.analytics.fromLeadsSub",
                  "orders attributed to a lead",
                )}
              />
            </div>

            <Card>
              <CardHeader>
                <CardTitle>
                  {t("merchant.analytics.dailyTitle", "Leads per day")}
                </CardTitle>
                <CardDescription>
                  {t(
                    "merchant.analytics.dailySubtitle",
                    "New leads over the last 14 days.",
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <LeadsSparkline days={summary.leadsPerDay} />
                <div className="mt-2 flex justify-between text-muted-foreground text-xs">
                  <span>{summary.leadsPerDay[0]?.day ?? ""}</span>
                  <span>
                    {summary.leadsPerDay[summary.leadsPerDay.length - 1]?.day ??
                      ""}
                  </span>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>
                    {t("merchant.analytics.byStatus", "Leads by status")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          {t("merchant.analytics.colStatus", "Status")}
                        </TableHead>
                        <TableHead>
                          {t("merchant.analytics.colCount", "Count")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.leads.byStatus.map((row) => (
                        <TableRow key={row.status}>
                          <TableCell>
                            <Badge
                              variant={
                                LEAD_STATUS_VARIANT[row.status] ?? "secondary"
                              }
                            >
                              {leadStatusLabel(t, row.status)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <BarCell count={row.count} max={statusMax} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>
                    {t("merchant.analytics.byPlatform", "Leads by platform")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          {t("merchant.analytics.colPlatform", "Platform")}
                        </TableHead>
                        <TableHead>
                          {t("merchant.analytics.colCount", "Count")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.leads.byPlatform.map((row) => (
                        <TableRow key={row.platform}>
                          <TableCell className="capitalize">
                            {row.platform}
                          </TableCell>
                          <TableCell>
                            <BarCell count={row.count} max={platformMax} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>
                    {t("merchant.analytics.bySource", "Leads by source")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          {t("merchant.analytics.colSource", "Source")}
                        </TableHead>
                        <TableHead>
                          {t("merchant.analytics.colCount", "Count")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.leads.bySource.map((row, index) => (
                        // A null sourceId has no key of its own; it is unique
                        // in the bucket, so the index keeps the key stable.
                        <TableRow key={row.sourceId ?? `manual-${index}`}>
                          <TableCell>
                            {row.name ??
                              t("merchant.analytics.sourceManual", "Manual")}
                          </TableCell>
                          <TableCell>
                            <BarCell count={row.count} max={sourceMax} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>
                    {t(
                      "merchant.analytics.topProducts",
                      "Top matched products",
                    )}
                  </CardTitle>
                  <CardDescription>
                    {t(
                      "merchant.analytics.topProductsSub",
                      "Catalog products posts matched most.",
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          {t("merchant.analytics.colProduct", "Product")}
                        </TableHead>
                        <TableHead>
                          {t("merchant.analytics.colMatches", "Matches")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.topProducts.map((row) => (
                        <TableRow key={row.productId}>
                          <TableCell className="font-medium">
                            {row.name || row.productId}
                          </TableCell>
                          <TableCell>
                            <BarCell count={row.matches} max={productMax} />
                          </TableCell>
                        </TableRow>
                      ))}
                      {summary.topProducts.length === 0 && (
                        <TableRow>
                          <TableCell
                            colSpan={2}
                            className="text-muted-foreground"
                          >
                            {t(
                              "merchant.analytics.noMatches",
                              "No product matches yet.",
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>
                    {t("merchant.analytics.ordersByStatus", "Orders by status")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>
                          {t("merchant.analytics.colStatus", "Status")}
                        </TableHead>
                        <TableHead>
                          {t("merchant.analytics.colCount", "Count")}
                        </TableHead>
                        <TableHead>
                          {t("merchant.analytics.colTotal", "Total")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.orders.byStatus.map((row) => (
                        <TableRow key={row.status}>
                          <TableCell>
                            <Badge
                              variant={
                                ORDER_STATUS_VARIANT[row.status] ?? "secondary"
                              }
                            >
                              {orderStatusLabel(t, row.status)}
                            </Badge>
                          </TableCell>
                          <TableCell>{row.count}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatVnd(row.totalAmount)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </DataBoundary>
    </PageContainer>
  );
}
