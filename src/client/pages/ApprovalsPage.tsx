import { ClipboardCheck, FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router";
import {
  Button,
  Card,
  DataBoundary,
  PageContainer,
  Tabs,
  useToast,
} from "@/client/components";
import { usePendingApprovals } from "@/client/contexts/ApprovalsContext";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { isAdminRole } from "@/client/lib/roles";
import { ApprovalHistory } from "@/client/pages/approvals/ApprovalHistory";
import { KnowledgeApprovals } from "@/client/pages/resources/KnowledgeApprovals";

// The one approvals queue (docs/documents.md, Approval): the documents waiting on the team, which any
// role decides, and for an admin the knowledge-base suggestions, through the same queue component the
// Knowledge tab shows. A document opens the page the alert links to. The history tab lists the
// documents already decided; the tab sits in the URL, so a request's page leads back to it.

type PendingResp = Awaited<
  ReturnType<(typeof api.api.v1)["document-approvals"]["pending"]["get"]>
>;
type PendingRequest = NonNullable<PendingResp["data"]>["requests"][number];

export function ApprovalsPage() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const isAdmin = isAdminRole(user?.role);
  const { count, setKnowledgeCount, refresh } = usePendingApprovals();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") === "history" ? "history" : "pending";
  const { showToast } = useToast();
  // The count the knowledge queue on this page reported, null until it answers: the badge's own
  // count is read separately and can land later from another snapshot, and a failed or loading
  // queue is not "nothing waiting".
  const [shownKnowledge, setShownKnowledge] = useState<number | null>(null);
  const onKnowledgeCount = useCallback(
    (count: number) => {
      setKnowledgeCount(count);
      setShownKnowledge(count);
    },
    [setKnowledgeCount],
  );
  const [requests, setRequests] = useState<PendingRequest[] | null>(null);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Bumped by every first-page read: a "Show more" asked before it answers into a list that no
  // longer exists, so its page is dropped instead of appended after the fresh first page.
  const generation = useRef(0);
  const load = useCallback(async () => {
    generation.current += 1;
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } =
        await api.api.v1["document-approvals"].pending.get();
      if (err || !data) {
        setError(true);
        return;
      }
      setRequests(data.requests);
      setNextAfter(data.nextAfter);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Read on arrival and again on every return to the waiting tab: requests arrive and are decided while
  // the history is open, and the queue must not show the snapshot from before.
  useEffect(() => {
    if (tab !== "pending") return;
    void load();
    refresh();
  }, [tab, load, refresh]);

  const loadMore = async () => {
    if (!nextAfter) return;
    const asked = generation.current;
    setLoadingMore(true);
    try {
      const { data, error: err } = await api.api.v1[
        "document-approvals"
      ].pending.get({
        query: { after: nextAfter },
      });
      if (asked !== generation.current) return;
      if (err || !data) {
        // The rows and the cursor stay, so the button retries the same page.
        showToast(
          apiErrorMessage(err) ??
            t("approvalQueue.moreFailed", "Could not load more documents."),
          "error",
        );
        return;
      }
      setRequests((prev) => [...(prev ?? []), ...data.requests]);
      setNextAfter(data.nextAfter);
    } catch {
      showToast(
        t("approvalQueue.moreFailed", "Could not load more documents."),
        "error",
      );
    } finally {
      setLoadingMore(false);
    }
  };

  const formatTime = (value: Date | string) =>
    new Date(value).toLocaleString(i18n.language);

  return (
    <PageContainer className="flex flex-col gap-6">
      <header className="flex items-center gap-3">
        <ClipboardCheck className="h-6 w-6 text-accent" aria-hidden="true" />
        <div>
          <h1 className="font-semibold text-text-primary text-xl">
            {t("approvalQueue.title", "Approvals")}
          </h1>
          <p className="text-sm text-text-muted">
            {isAdmin
              ? t(
                  "approvalQueue.subtitleAdmin",
                  "Documents waiting for the team, and knowledge suggestions the agents made.",
                )
              : t("approvalQueue.subtitle", "Documents waiting for the team.")}
          </p>
        </div>
      </header>

      <Tabs
        aria-label={t("approvalQueue.tabs", "Approvals")}
        value={tab}
        onChange={(key) =>
          setSearchParams(key === "history" ? { tab: "history" } : {}, {
            replace: true,
          })
        }
        items={[
          {
            key: "pending",
            label: t("approvalQueue.tabPending", "Waiting"),
            badge: count,
          },
          { key: "history", label: t("approvalQueue.tabHistory", "History") },
        ]}
      />

      {tab === "history" && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-sm text-text-primary">
            {t("approvalQueue.documents", "Documents")}
          </h2>
          <ApprovalHistory />
        </section>
      )}

      {tab === "pending" && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-sm text-text-primary">
            {t("approvalQueue.documents", "Documents")}
          </h2>
          <DataBoundary
            loading={loading && requests === null}
            error={error}
            onRetry={load}
            errorLabel={t(
              "approvalQueue.loadError",
              "Could not load the documents waiting for approval.",
            )}
          >
            {requests && requests.length === 0 && (
              <p className="text-sm text-text-muted">
                {t(
                  "approvalQueue.noDocuments",
                  "No document is waiting for approval.",
                )}
              </p>
            )}
            {requests && requests.length > 0 && (
              <ul className="flex flex-col gap-2">
                {requests.map((r) => (
                  <li key={r.id}>
                    <Link
                      to={`/document-approvals/${r.id}`}
                      className="block rounded-lg hover:bg-bg-hover"
                    >
                      <Card className="flex items-center gap-3 p-3">
                        <FileText
                          className="h-4 w-4 shrink-0 text-text-muted"
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium text-sm text-text-primary">
                            {r.contactName
                              ? t(
                                  "approvalQueue.documentFor",
                                  "{{title}} for {{customer}}",
                                  { title: r.title, customer: r.contactName },
                                )
                              : r.title}
                          </p>
                          <p className="text-text-muted text-xs">
                            {t(
                              "approvalQueue.documentMeta",
                              "Requested {{at}} · expires {{expires}}",
                              {
                                at: formatTime(r.createdAt),
                                expires: formatTime(r.expiresAt),
                              },
                            )}
                            {r.chatwootConversationId != null
                              ? ` · ${t(
                                  "approvalQueue.conversation",
                                  "conversation #{{number}}",
                                  { number: r.chatwootConversationId },
                                )}`
                              : ""}
                          </p>
                        </div>
                        <span className="text-accent text-sm">
                          {t("approvalQueue.review", "Review")}
                        </span>
                      </Card>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {nextAfter && (
              <Button
                variant="secondary"
                onClick={loadMore}
                loading={loadingMore}
                className="self-start"
              >
                {t("approvalQueue.more", "Show more")}
              </Button>
            )}
          </DataBoundary>
        </section>
      )}

      {tab === "pending" && isAdmin && (
        <section className="flex flex-col gap-3">
          <h2 className="font-medium text-sm text-text-primary">
            {t("approvalQueue.knowledge", "Knowledge suggestions")}
          </h2>
          <KnowledgeApprovals onCountChange={onKnowledgeCount} />
          {shownKnowledge === 0 && (
            <p className="text-sm text-text-muted">
              {t(
                "approvalQueue.noKnowledge",
                "No knowledge suggestion is waiting for review.",
              )}
            </p>
          )}
        </section>
      )}
    </PageContainer>
  );
}
