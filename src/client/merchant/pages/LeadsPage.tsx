import { MessageSquare, Target } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  DataBoundary,
  EmptyState,
  PageContainer,
  Select,
  useModalController,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { formatDateTime } from "@/client/lib/utils";
import {
  type DraftLead,
  LeadDraftsModal,
} from "@/client/merchant/components/LeadDraftsModal";
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
type LeadsData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.leads)["get"]>
>["data"];
type Lead = NonNullable<LeadsData>["leads"][number];
type LeadStatus = Lead["status"];

const STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: "merchant.leads.status.new",
  CONTACTED: "merchant.leads.status.contacted",
  QUALIFIED: "merchant.leads.status.qualified",
  CONVERTED: "merchant.leads.status.converted",
  DEAD: "merchant.leads.status.dead",
};

function scoreVariant(score: number): "success" | "warning" | "secondary" {
  if (score >= 70) return "success";
  if (score >= 40) return "warning";
  return "secondary";
}

export function LeadsPage() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [statusBusy, setStatusBusy] = useState<string | null>(null);
  const draftsModal = useModalController<DraftLead>();

  const setStatus = async (lead: Lead, status: LeadStatus) => {
    if (status === lead.status) return;
    setStatusBusy(lead.id);
    try {
      const { data, error: err } = await api.api.v1.merchant
        .leads({ id: lead.id })
        .patch({ status });
      if (err || !data) {
        showToast(
          apiErrorMessage(err) ??
            t("merchant.leads.statusFailed", "Could not update the status"),
          "error",
        );
        return;
      }
      setLeads((cur) => cur.map((l) => (l.id === lead.id ? data.lead : l)));
    } catch {
      showToast(
        t("merchant.leads.statusFailed", "Could not update the status"),
        "error",
      );
    } finally {
      setStatusBusy(null);
    }
  };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } = await api.api.v1.merchant.leads.get({
        query: { limit: "100" },
      });
      if (err || !data) {
        setError(true);
        return;
      }
      setLeads(data.leads);
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
          <h1 className="font-semibold text-text-primary text-xl">{"Leads"}</h1>
          <p className="text-sm text-text-secondary">
            {t(
              "merchant.leads.subtitle",
              "Social posts scored for buying intent against the catalog.",
            )}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {t("merchant.leads.tableTitle", "Scored leads")}
          </CardTitle>
          <CardDescription>
            {t(
              "merchant.leads.tableSubtitle",
              "Newest first. The score and matched products come from the rule-based ingest scorer.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataBoundary
            loading={loading}
            error={error}
            isEmpty={leads.length === 0}
            onRetry={() => void fetchAll()}
            empty={
              <EmptyState
                icon={Target}
                title={t("merchant.leads.emptyTitle", "No leads yet")}
                description={t(
                  "merchant.leads.emptyDescription",
                  "Ingest a social post via POST /api/v1/merchant/leads/ingest or the seed script.",
                )}
              />
            }
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {t("merchant.leads.colAuthor", "Author")}
                  </TableHead>
                  <TableHead>{t("merchant.leads.colText", "Post")}</TableHead>
                  <TableHead>
                    {t("merchant.leads.colSource", "Source")}
                  </TableHead>
                  <TableHead>{t("merchant.leads.colScore", "Score")}</TableHead>
                  <TableHead>
                    {t("merchant.leads.colMatches", "Matched products")}
                  </TableHead>
                  <TableHead>{"Status"}</TableHead>
                  <TableHead>
                    {t("merchant.leads.colCreated", "Found")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.leads.colActions", "Actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.map((lead) => (
                  <TableRow key={lead.id}>
                    <TableCell className="font-medium">
                      <div className="flex flex-col">
                        <span>{lead.authorName}</span>
                        {lead.authorHandle && (
                          <span className="text-muted-foreground text-xs">
                            {lead.authorHandle}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-md">
                      <span className="line-clamp-2 whitespace-normal text-muted-foreground">
                        {lead.text}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <div className="flex flex-col gap-1">
                        <span className="capitalize">{lead.platform}</span>
                        {lead.groupName && (
                          <span className="text-xs">{lead.groupName}</span>
                        )}
                        {lead.sourceId && (
                          <Badge variant="secondary" className="w-fit text-xs">
                            {lead.sourceName ??
                              t(
                                "merchant.leads.sourceDeleted",
                                "source deleted",
                              )}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={scoreVariant(lead.score)}>
                        {lead.score}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <div className="flex flex-wrap gap-1">
                        {lead.matches.length === 0 ? (
                          <span className="text-muted-foreground text-xs">
                            {"-"}
                          </span>
                        ) : (
                          lead.matches.map((m) => (
                            <Badge key={m.productId} variant="secondary">
                              {m.productName}
                            </Badge>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={lead.status}
                        disabled={statusBusy === lead.id}
                        aria-label={t("merchant.leads.colStatus", "Status")}
                        className="h-8 w-36"
                        onChange={(e) =>
                          void setStatus(lead, e.target.value as LeadStatus)
                        }
                      >
                        {(Object.keys(STATUS_LABEL) as LeadStatus[]).map(
                          (s) => (
                            <option key={s} value={s}>
                              {
                                // t('merchant.leads.status.new', 'New')
                                // t('merchant.leads.status.contacted', 'Contacted')
                                // t('merchant.leads.status.qualified', 'Qualified')
                                // t('merchant.leads.status.converted', 'Converted')
                                // t('merchant.leads.status.dead', 'Dead')
                                // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in STATUS_LABEL
                                t(STATUS_LABEL[s], s)
                              }
                            </option>
                          ),
                        )}
                      </Select>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(lead.createdAt, i18n.language)}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => draftsModal.open(lead)}
                      >
                        <MessageSquare className="size-4" />
                        {t("merchant.leads.createDraft", "Draft reply")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataBoundary>
        </CardContent>
      </Card>
      <LeadDraftsModal modal={draftsModal} onChanged={() => void fetchAll()} />
    </PageContainer>
  );
}
