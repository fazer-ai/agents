import { FileUp, Package, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  DataBoundary,
  EmptyState,
  PageContainer,
  useModalController,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { CatalogImportModal } from "@/client/merchant/components/CatalogImportModal";
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

import "@/client/merchant/index.css";

type ProductsData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.products)["get"]>
>["data"];
type Product = NonNullable<ProductsData>["products"][number];

function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat("vi-VN").format(amount)} ₫`;
}

// The LLM's facets as a one-line "size: M · color: đen" summary; values are
// capped scalar by the write schema so joining them is safe.
function attributesSummary(attributes: Product["attributes"]): string | null {
  if (!attributes || typeof attributes !== "object") return null;
  const parts = Object.entries(attributes)
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .map(([k, v]) => `${k}: ${String(v)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function CatalogPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retaggingId, setRetaggingId] = useState<string | null>(null);
  const importModal = useModalController();

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

  async function retag(p: Product) {
    setRetaggingId(p.id);
    try {
      const { data, error: err } = await api.api.v1.merchant
        .products({ id: p.id })
        .retag.post({});
      if (err || !data) {
        showToast(
          apiErrorMessage(err) ??
            t("merchant.catalog.retagFailed", "Re-tagging failed."),
          "error",
        );
        return;
      }
      setProducts((prev) =>
        prev.map((row) => (row.id === p.id ? data.product : row)),
      );
    } catch {
      showToast(
        t("merchant.catalog.retagFailed", "Re-tagging failed."),
        "error",
      );
    } finally {
      setRetaggingId(null);
    }
  }

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
        <Button variant="outline" onClick={() => importModal.open()}>
          <FileUp className="size-4" />
          {t("merchant.catalog.import.button", "Import CSV")}
        </Button>
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
                  "Create one via POST /api/v1/merchant/products, import a CSV, or run the merchant seed.",
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
                  <TableHead>
                    {t("merchant.catalog.colCategory", "Category")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.catalog.colAttributes", "Attributes")}
                  </TableHead>
                  <TableHead>{t("merchant.catalog.colTags", "Tags")}</TableHead>
                  <TableHead>
                    {t("merchant.catalog.colStatus", "Status")}
                  </TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p) => {
                  const summary = attributesSummary(p.attributes);
                  const aiTagged = p.tagSource === "llm";
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatVnd(p.price)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {p.stock}
                      </TableCell>
                      <TableCell>
                        {p.category ? (
                          <Badge variant="info">{p.category}</Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            {t("merchant.catalog.untagged", "—")}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-48">
                        <span className="text-muted-foreground text-xs">
                          {summary ?? t("merchant.catalog.noAttributes", "—")}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-xs">
                        <div className="flex flex-wrap items-center gap-1">
                          {aiTagged && (
                            <Sparkles
                              className="size-3.5 text-accent"
                              aria-label={t(
                                "merchant.catalog.aiTagged",
                                "Tagged by AI",
                              )}
                            />
                          )}
                          {p.tags.map((tag) => (
                            <Badge
                              key={tag}
                              variant={aiTagged ? "primary" : "secondary"}
                            >
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
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="xs"
                          disabled={retaggingId === p.id}
                          onClick={() => void retag(p)}
                        >
                          <Sparkles className="size-3.5" />
                          {retaggingId === p.id
                            ? t("merchant.catalog.retagging", "Tagging…")
                            : t("merchant.catalog.retag", "Re-tag")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </DataBoundary>
        </CardContent>
      </Card>

      <CatalogImportModal
        modal={importModal}
        onImported={() => void fetchAll()}
      />
    </PageContainer>
  );
}
