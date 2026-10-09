import { FileText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  Badge,
  Button,
  Card,
  DataBoundary,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import {
  APPROVAL_STATUS_VARIANT,
  approvalOutcomeLabel,
  approvalStatusLabel,
  SENDING_FOR_MS,
} from "@/client/lib/approval-status";
import { serverNow } from "@/client/lib/serverClock";
import { useSendingClock } from "@/client/lib/useSendingClock";

// How often the history asks again while a decision's outcome is still to land.
const REFRESH_MS = 5000;

// The approvals history (docs/documents.md, Approval): every document request no longer waiting on the
// team, newest first, with who decided and what it came to in the conversation.

type DecidedResp = Awaited<
  ReturnType<(typeof api.api.v1)["document-approvals"]["decided"]["get"]>
>;
type DecidedRequest = NonNullable<DecidedResp["data"]>["requests"][number];

export function ApprovalHistory() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const [requests, setRequests] = useState<DecidedRequest[] | null>(null);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } =
        await api.api.v1["document-approvals"].decided.get();
      if (err || !data) {
        setError(true);
        return;
      }
      setRequests(data.requests);
      setNextBefore(data.nextBefore);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const { data, error: err } = await api.api.v1[
        "document-approvals"
      ].decided.get({ query: { before: nextBefore } });
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
      setNextBefore(data.nextBefore);
    } catch {
      showToast(
        t("approvalQueue.moreFailed", "Could not load more documents."),
        "error",
      );
    } finally {
      setLoadingMore(false);
    }
  };

  useSendingClock(requests ?? []);

  // A decision whose outcome has not landed yet is read again until it does: the first page is asked
  // again and merged by id, so the pages already loaded stay, and a decision taken meanwhile joins the
  // top.
  const unresolved = (requests ?? []).some(
    (r) =>
      (r.status === "APPROVED" || r.status === "REJECTED") &&
      r.outcome === null &&
      !(r.status === "APPROVED" && r.issuedDocumentId === null) &&
      r.decidedAt !== null &&
      serverNow() - new Date(r.decidedAt).getTime() < SENDING_FOR_MS,
  );
  const [refreshes, setRefreshes] = useState(0);
  useEffect(() => {
    void refreshes;
    if (!unresolved) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const { data } = await api.api.v1["document-approvals"].decided.get();
        if (cancelled || !data) return;
        setRequests((prev) => {
          if (!prev) return data.requests;
          const fresh = new Map(data.requests.map((r) => [r.id, r]));
          const known = new Set(prev.map((r) => r.id));
          const newer = data.requests.filter(
            (r) => !known.has(r.id) && Number(r.id) > Number(prev[0]?.id ?? 0),
          );
          return [...newer, ...prev.map((r) => fresh.get(r.id) ?? r)];
        });
      } catch {
        // The rows already shown stay; the next refresh asks again.
      } finally {
        if (!cancelled) setRefreshes((n) => n + 1);
      }
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [unresolved, refreshes]);

  const formatTime = (value: Date | string) =>
    new Date(value).toLocaleString(i18n.language);

  return (
    <DataBoundary
      loading={loading && requests === null}
      error={error}
      onRetry={load}
      errorLabel={t(
        "approvalQueue.historyError",
        "Could not load the approvals history.",
      )}
    >
      {requests && requests.length === 0 && (
        <p className="text-sm text-text-muted">
          {t("approvalQueue.noHistory", "No document has been decided yet.")}
        </p>
      )}
      {requests && requests.length > 0 && (
        <ul className="flex flex-col gap-2">
          {requests.map((r) => {
            const outcome = approvalOutcomeLabel(r, t);
            return (
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
                        {[
                          r.reviewerName
                            ? t("approvalQueue.decidedBy", "by {{name}}", {
                                name: r.reviewerName,
                              })
                            : null,
                          r.decidedAt ? formatTime(r.decidedAt) : null,
                          outcome,
                          r.chatwootConversationId != null
                            ? t(
                                "approvalQueue.conversation",
                                "conversation #{{number}}",
                                { number: r.chatwootConversationId },
                              )
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <Badge
                      variant={APPROVAL_STATUS_VARIANT[r.status] ?? "secondary"}
                    >
                      {approvalStatusLabel(r.status, t)}
                    </Badge>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {nextBefore && (
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
  );
}
