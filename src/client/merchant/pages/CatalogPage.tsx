import { Package } from "lucide-react";
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

type ProductsData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.products)["get"]>
>["data"];
type Product = NonNullable<ProductsData>["products"][number];

function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat("vi-VN").format(amount)} ₫`;
}

export function CatalogPage() {
  const { t } = useTranslation();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } = await api.api.v1.merchant.products.get();
      if (err || !data) {
        setError(true);
        return;
      }
      setProducts(data.products);
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
            {t("merchant.catalog.title", "Catalog")}
          </h1>
          <p className="text-sm text-text-secondary">
            {t(
              "merchant.catalog.subtitle",
              "Products the lead scorer matches incoming posts against.",
            )}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("merchant.catalog.tableTitle", "Products")}</CardTitle>
          <CardDescription>
            {t(
              "merchant.catalog.tableSubtitle",
              "Names and tags are what the scorer matches on - keep them in the words customers use.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataBoundary
            loading={loading}
            error={error}
            isEmpty={products.length === 0}
            onRetry={() => void fetchAll()}
            empty={
              <EmptyState
                icon={Package}
                title={t("merchant.catalog.emptyTitle", "No products yet")}
                description={t(
                  "merchant.catalog.emptyDescription",
                  "Create one via POST /api/v1/merchant/products or run the merchant seed.",
                )}
              />
            }
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("merchant.catalog.colName", "Name")}</TableHead>
                  <TableHead>
                    {t("merchant.catalog.colPrice", "Price")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.catalog.colStock", "Stock")}
                  </TableHead>
                  <TableHead>{t("merchant.catalog.colTags", "Tags")}</TableHead>
                  <TableHead>
                    {t("merchant.catalog.colStatus", "Status")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatVnd(p.price)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.stock}
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <div className="flex flex-wrap gap-1">
                        {p.tags.map((tag) => (
                          <Badge key={tag} variant="secondary">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      {p.active ? (
                        <Badge variant="success">
                          {t("merchant.catalog.active", "Active")}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          {t("merchant.catalog.inactive", "Inactive")}
                        </Badge>
                      )}
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
