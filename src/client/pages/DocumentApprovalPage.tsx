import { FileQuestion } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router";
import {
  Badge,
  Button,
  Card,
  DataBoundary,
  EmptyState,
  PageContainer,
  Skeleton,
  Textarea,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { mediaFetch } from "@/client/lib/media";
import { serverNow } from "@/client/lib/serverClock";
import { DocumentPreview } from "@/client/pages/resources/documents/DocumentPreview";
import type { DocumentPreviewState } from "@/client/pages/resources/documents/useDocumentPreview";

// The page an alert links to for one document approval request (docs/documents.md, Approval): who
// the customer is and what was said, the document as approval would issue it, and the decision. Any
// user of the tenant decides; the console session is the only credential the page asks for.

type RequestResp = Awaited<
  ReturnType<ReturnType<(typeof api.api.v1)["document-approvals"]>["get"]>
>;
type ApprovalRequest = NonNullable<RequestResp["data"]>["request"];
type ContextResp = Awaited<
  ReturnType<
    ReturnType<(typeof api.api.v1)["document-approvals"]>["context"]["get"]
  >
>;
type ApprovalContext = NonNullable<ContextResp["data"]>;

type BadgeVariant = "warning" | "success" | "error" | "secondary";
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "error",
  EXPIRED: "secondary",
  CANCELLED: "secondary",
};

function usePreview(id: string, status: string | null): DocumentPreviewState {
  const { t } = useTranslation();
  const [state, setState] = useState<DocumentPreviewState>({
    url: null,
    loading: true,
    error: null,
  });
  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    // NOTE: read so the preview is fetched again when the request moves; the bytes do not change,
    // but an approved request is then shown beside its outcome without a stale loading state.
    void status;
    let cancelled = false;
    (async () => {
      try {
        const res = await mediaFetch(
          `/api/v1/document-approvals/${id}/preview`,
        );
        if (cancelled) return;
        if (!res.ok) {
          setState({
            url: null,
            loading: false,
            error: t(
              "documentApproval.previewError",
              "The preview could not be rendered.",
            ),
          });
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = next;
        setState({ url: next, loading: false, error: null });
      } catch (e) {
        if (!cancelled) {
          setState({ url: null, loading: false, error: (e as Error).message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, status, t]);
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );
  return state;
}

// One page instance per request: moving to another id (request again, the browser's back) starts
// from nothing, so neither a preview nor a load of the previous request can show beside the next one's
// buttons.
export function DocumentApprovalPage() {
  const { id = "" } = useParams();
  return (
    <PageContainer size="wide" className="space-y-6">
      <DocumentApprovalRequestPage key={id} id={id} />
    </PageContainer>
  );
}

// How often a request past its time is read again until the expiry closes it.
const OVERDUE_POLL_MS = 3000;

function DocumentApprovalRequestPage({ id }: { id: string }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { showToast } = useToast();
  // Whether this request's page is still the one on screen: an action that answers after the
  // reviewer moved on must not navigate them away from where they went.
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [context, setContext] = useState<ApprovalContext | null>(null);
  // The context is read apart from the request: it waits on Chatwoot, page by page, and the document
  // and the decision do not.
  const [contextState, setContextState] = useState<
    "loading" | "ready" | "failed"
  >("loading");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<"approve" | "reject" | "again" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const preview = usePreview(id, request?.status ?? null);

  const loadContext = useCallback(async () => {
    setContextState("loading");
    try {
      const { data } = await api.api.v1["document-approvals"]({
        id,
      }).context.get();
      setContext(data ?? null);
      setContextState(data ? "ready" : "failed");
    } catch {
      setContextState("failed");
    }
  }, [id]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    setMissing(false);
    try {
      const req = await api.api.v1["document-approvals"]({ id }).get();
      if (req.error?.status === 404 || req.error?.status === 400) {
        setMissing(true);
        return;
      }
      if (req.error || !req.data) {
        setError(true);
        return;
      }
      setRequest(req.data.request);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
    void loadContext();
  }, [load, loadContext]);

  // A pending request is read again when its time runs out, and every few seconds after that until
  // the expiry closes it, so the page moves from the decision to "request again" without a reload.
  const status = request?.status;
  const expiresAtMs = request ? new Date(request.expiresAt).getTime() : null;
  // Bumped after every read, so a read that comes back unchanged (the expiry has not run yet) still
  // schedules the next one.
  const [reads, setReads] = useState(0);
  useEffect(() => {
    void reads;
    if (status !== "PENDING" || expiresAtMs === null) return;
    const left = expiresAtMs - serverNow();
    const timer = setTimeout(
      () => void load().then(() => setReads((n) => n + 1)),
      left > 0 ? left + 1000 : OVERDUE_POLL_MS,
    );
    return () => clearTimeout(timer);
  }, [status, expiresAtMs, load, reads]);

  const endpoint = api.api.v1["document-approvals"]({ id });

  const approve = async () => {
    setBusy("approve");
    try {
      const { data, error: err } = await endpoint.approve.post();
      if (err || !data) {
        showToast(
          apiErrorMessage(err) ??
            t("documentApproval.approveFailed", "Could not approve."),
          "error",
        );
        await load();
        return;
      }
      showToast(
        t(
          "documentApproval.approved",
          "Approved: {{number}} is on its way to the customer.",
          { number: data.document.number ?? "" },
        ),
        "success",
      );
      await load();
    } catch {
      // The body could not be read (a cut connection, a malformed answer): the server may have
      // acted anyway, so the request is read again rather than guessed.
      showToast(
        t("documentApproval.approveFailed", "Could not approve."),
        "error",
      );
      await load();
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    setBusy("reject");
    try {
      const trimmed = note.trim();
      const { error: err } = await endpoint.reject.post(
        trimmed ? { note: trimmed } : {},
      );
      if (err) {
        showToast(
          apiErrorMessage(err) ??
            t("documentApproval.rejectFailed", "Could not reject."),
          "error",
        );
        await load();
        return;
      }
      showToast(
        t(
          "documentApproval.rejected",
          "Rejected. The conversation goes to a person.",
        ),
        "success",
      );
      setRejecting(false);
      setNote("");
      await load();
    } catch {
      // The body could not be read (a cut connection, a malformed answer): the server may have
      // acted anyway, so the request is read again rather than guessed.
      showToast(
        t("documentApproval.rejectFailed", "Could not reject."),
        "error",
      );
      await load();
    } finally {
      setBusy(null);
    }
  };

  const requestAgain = async () => {
    setBusy("again");
    try {
      const { data, error: err } = await endpoint["request-again"].post();
      if (err || !data) {
        showToast(
          apiErrorMessage(err) ??
            t("documentApproval.againFailed", "Could not request it again."),
          "error",
        );
        await load();
        return;
      }
      showToast(
        t(
          "documentApproval.again",
          "Requested again, dated today. This is the new request.",
        ),
        "success",
      );
      if (onScreen.current) navigate(`/document-approvals/${data.request.id}`);
    } catch {
      // The body could not be read (a cut connection, a malformed answer): the server may have
      // acted anyway, so the request is read again rather than guessed.
      showToast(
        t("documentApproval.againFailed", "Could not request it again."),
        "error",
      );
      await load();
    } finally {
      setBusy(null);
    }
  };

  const formatTime = (value: Date | string | number | null | undefined) =>
    value == null
      ? ""
      : new Date(
          typeof value === "number" && value < 1e12 ? value * 1000 : value,
        ).toLocaleString(i18n.language);

  const statusLabel = (status: string) =>
    ({
      PENDING: t("documentApproval.status.pending", "Waiting for approval"),
      APPROVED: t("documentApproval.status.approved", "Approved"),
      REJECTED: t("documentApproval.status.rejected", "Rejected"),
      EXPIRED: t("documentApproval.status.expired", "Expired"),
      CANCELLED: t("documentApproval.status.cancelled", "Cancelled"),
    })[status] ?? status;

  const pending =
    request?.status === "PENDING" &&
    new Date(request.expiresAt).getTime() > serverNow();

  return (
    <DataBoundary
      loading={loading && !request}
      error={error}
      onRetry={load}
      errorLabel={t(
        "documentApproval.loadError",
        "Could not load this approval request.",
      )}
      skeleton={
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      }
    >
      {missing && (
        <EmptyState
          icon={FileQuestion}
          title={t(
            "documentApproval.notFoundTitle",
            "This approval request is not here",
          )}
          description={t(
            "documentApproval.notFound",
            "It does not exist in this organization, or it belongs to another one.",
          )}
        />
      )}
      {request && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-semibold text-lg text-text-primary">
              {request.title}
            </h1>
            <Badge variant={STATUS_VARIANT[request.status] ?? "secondary"}>
              {statusLabel(request.status)}
            </Badge>
            <span className="text-sm text-text-muted">
              {request.status === "PENDING"
                ? t("documentApproval.expiresAt", "Expires {{at}}", {
                    at: formatTime(request.expiresAt),
                  })
                : request.decidedAt
                  ? t("documentApproval.decidedAt", "Decided {{at}}", {
                      at: formatTime(request.decidedAt),
                    })
                  : null}
            </span>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-4">
              <Card className="space-y-2 p-4">
                <h2 className="font-medium text-sm text-text-primary">
                  {t("documentApproval.customer", "Customer")}
                </h2>
                {contextState === "loading" ? (
                  <Skeleton className="h-16 w-full" />
                ) : contextState === "failed" ? (
                  <p className="text-sm text-text-muted">
                    {t(
                      "documentApproval.contextError",
                      "The customer and the messages could not be loaded.",
                    )}
                  </p>
                ) : context?.contact ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-text-muted">
                      {t("documentApproval.name", "Name")}
                    </dt>
                    <dd className="text-text-primary">
                      {context.contact.name ?? "—"}
                    </dd>
                    {context.contact.phone && (
                      <>
                        <dt className="text-text-muted">
                          {t("documentApproval.phone", "Phone")}
                        </dt>
                        <dd className="text-text-primary">
                          {context.contact.phone}
                        </dd>
                      </>
                    )}
                    {context.contact.email && (
                      <>
                        <dt className="text-text-muted">
                          {t("documentApproval.email", "Email")}
                        </dt>
                        <dd className="text-text-primary">
                          {context.contact.email}
                        </dd>
                      </>
                    )}
                  </dl>
                ) : (
                  <p className="text-sm text-text-muted">
                    {t(
                      "documentApproval.noContact",
                      "No customer is recorded for this request.",
                    )}
                  </p>
                )}
                {context?.conversation && (
                  <Link
                    to={`/conversations/${context.conversation.id}`}
                    className="text-accent text-sm"
                  >
                    {t(
                      "documentApproval.openConversation",
                      "Open conversation #{{number}}",
                      {
                        number: context.conversation.chatwootConversationId,
                      },
                    )}
                  </Link>
                )}
              </Card>

              <Card className="space-y-3 p-4">
                <h2 className="font-medium text-sm text-text-primary">
                  {t("documentApproval.recent", "Recent messages")}
                </h2>
                {contextState === "loading" && (
                  <Skeleton className="h-24 w-full" />
                )}
                {context?.messagesUnavailable && (
                  <p className="text-sm text-text-muted">
                    {t(
                      "documentApproval.messagesUnavailable",
                      "Chatwoot did not answer, so the messages are not shown.",
                    )}
                  </p>
                )}
                {context &&
                  !context.messagesUnavailable &&
                  context.messages.length === 0 && (
                    <p className="text-sm text-text-muted">
                      {t("documentApproval.noMessages", "No messages.")}
                    </p>
                  )}
                <ul className="flex flex-col gap-2">
                  {context?.messages.map((m, i) => (
                    <li
                      key={m.id ?? `m-${i}`}
                      className={
                        m.fromCustomer
                          ? "mr-8 rounded-md bg-bg-tertiary p-2 text-sm"
                          : "ml-8 rounded-md bg-accent-soft p-2 text-sm"
                      }
                    >
                      <div className="text-text-muted text-xs">
                        {m.fromCustomer
                          ? (context.contact?.name ??
                            t("documentApproval.customer", "Customer"))
                          : (m.senderName ?? t("documentApproval.us", "Agent"))}
                        {m.createdAt ? ` · ${formatTime(m.createdAt)}` : ""}
                      </div>
                      <p className="whitespace-pre-wrap text-text-primary">
                        {m.content ?? ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card className="space-y-3 p-4">
                {pending && !rejecting && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={approve}
                      loading={busy === "approve"}
                      disabled={busy !== null}
                    >
                      {t("documentApproval.approve", "Approve and send")}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => setRejecting(true)}
                      disabled={busy !== null}
                    >
                      {t("documentApproval.reject", "Reject")}
                    </Button>
                  </div>
                )}
                {pending && rejecting && (
                  <div className="space-y-2">
                    <label
                      htmlFor="approval-note"
                      className="font-medium text-sm text-text-primary"
                    >
                      {t(
                        "documentApproval.noteLabel",
                        "Note for the team (optional)",
                      )}
                    </label>
                    <Textarea
                      id="approval-note"
                      value={note}
                      maxLength={2000}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder={t(
                        "documentApproval.notePlaceholder",
                        "What is wrong with it",
                      )}
                    />
                    <p className="text-text-muted text-xs">
                      {t(
                        "documentApproval.rejectHint",
                        "Nothing is sent to the customer. The note goes to the conversation as a private note, and the conversation goes to a person.",
                      )}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="danger"
                        onClick={reject}
                        loading={busy === "reject"}
                        disabled={busy !== null}
                      >
                        {t("documentApproval.confirmReject", "Reject")}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setRejecting(false)}
                        disabled={busy !== null}
                      >
                        {t("common.cancel", "Cancel")}
                      </Button>
                    </div>
                  </div>
                )}
                {request.status === "EXPIRED" && (
                  <div className="space-y-2">
                    <p className="text-sm text-text-secondary">
                      {t(
                        "documentApproval.expiredHint",
                        "Nobody answered in time, so nothing was sent. Requesting it again renders it with today's date as a new request.",
                      )}
                    </p>
                    <Button
                      onClick={requestAgain}
                      loading={busy === "again"}
                      disabled={busy !== null}
                    >
                      {t("documentApproval.requestAgain", "Request again")}
                    </Button>
                  </div>
                )}
                {request.status === "PENDING" && !pending && (
                  <p className="text-sm text-text-secondary">
                    {t(
                      "documentApproval.expiring",
                      "This request ran out of time and is being closed.",
                    )}
                  </p>
                )}
                {request.status === "APPROVED" &&
                  request.issuedDocumentId !== null && (
                    <p className="text-sm text-text-secondary">
                      {t(
                        "documentApproval.approvedHint",
                        "Approved. The agent sends the document in the conversation, or leaves a note when it cannot.",
                      )}
                    </p>
                  )}
                {/* Approved, but the document was never issued (the template went away after the
                      claim): approving again completes it, and nothing has reached the customer. */}
                {request.status === "APPROVED" &&
                  request.issuedDocumentId === null && (
                    <div className="space-y-2">
                      <p className="text-sm text-text-secondary">
                        {t(
                          "documentApproval.incomplete",
                          "Approved, but the document could not be issued, so nothing was sent. Try approving again.",
                        )}
                      </p>
                      <Button
                        onClick={approve}
                        loading={busy === "approve"}
                        disabled={busy !== null}
                      >
                        {t("documentApproval.approveAgain", "Approve again")}
                      </Button>
                    </div>
                  )}
                {request.status === "REJECTED" && (
                  <p className="text-sm text-text-secondary">
                    {request.note
                      ? t(
                          "documentApproval.rejectedWithNote",
                          "Rejected with the note: {{note}}",
                          { note: request.note },
                        )
                      : t(
                          "documentApproval.rejectedHint",
                          "Rejected. Nothing was sent to the customer.",
                        )}
                  </p>
                )}
              </Card>
            </div>

            <DocumentPreview state={preview} className="h-[70vh]" />
          </div>
        </>
      )}
    </DataBoundary>
  );
}
