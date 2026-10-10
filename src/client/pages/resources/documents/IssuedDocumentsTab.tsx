import { FileCheck, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
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
import { mediaFetch } from "@/client/lib/media";

type IssuedData = Awaited<
  ReturnType<(typeof api.api.v1)["documents"]["get"]>
>["data"];
type IssuedDocument = NonNullable<IssuedData>["documents"][number];

const PAGE_SIZE = "20";

// The issued documents: a RECORD, read when somebody asks about a document the customer already
// has, usually by the number printed on it. So the search is the printed number or the title, over
// every document of the tenant and not only the page on screen, and "Load more" reaches the rest.
export function IssuedDocumentsTab({
  templateNames,
}: {
  // Which template each document came from: the panel already has the templates, so the join is
  // there rather than a column on the row. Null while the panel has not read them (loading, or the
  // read failed), when a missing name says nothing about whether the template still exists.
  templateNames: Map<string, string> | null;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const confirm = useModalController<ConfirmPayload>();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [docs, setDocs] = useState<IssuedDocument[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Which search the screen is answering. A page of an older search, or of the list before it, that
  // lands after the operator typed would put rows on screen that do not match what the box says.
  const seq = useRef(0);
  // Revoked from this screen. A page read before the revoke can answer after it, and would hand the
  // row back its PDF and Revoke buttons.
  const revokedHere = useRef(new Set<string>());
  const settle = useCallback(
    (rows: readonly IssuedDocument[]) =>
      rows.map((d) =>
        revokedHere.current.has(d.id) ? { ...d, revoked: true } : d,
      ),
    [],
  );

  useEffect(() => {
    const id = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(false);
    // A Load more still in flight belongs to the list this replaces, and its own cleanup no longer
    // runs once the generation moved.
    setLoadingMore(false);
    try {
      const { data, error: err } = await api.api.v1.documents.get({
        query: { limit: PAGE_SIZE, ...(query ? { q: query } : {}) },
      });
      if (mine !== seq.current) return;
      if (err || !data) {
        setError(true);
        return;
      }
      setDocs(settle(data.documents));
      setNextBefore(data.nextBefore);
    } catch {
      if (mine === seq.current) setError(true);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [query, settle]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore() {
    if (!nextBefore || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const { data, error: err } = await api.api.v1.documents.get({
        query: {
          limit: PAGE_SIZE,
          before: nextBefore,
          ...(query ? { q: query } : {}),
        },
      });
      if (mine !== seq.current) return;
      if (err || !data) {
        showToast(
          apiErrorMessage(err) ||
            t("documents.loadMoreError", "Could not load more documents."),
          "error",
        );
        return;
      }
      setDocs((prev) => {
        const seen = new Set(prev.map((d) => d.id));
        return [
          ...prev,
          ...settle(data.documents.filter((d) => !seen.has(d.id))),
        ];
      });
      setNextBefore(data.nextBefore);
    } catch {
      if (mine === seq.current) {
        showToast(
          t("documents.loadMoreError", "Could not load more documents."),
          "error",
        );
      }
    } finally {
      if (mine === seq.current) setLoadingMore(false);
    }
  }

  // A blob URL rather than a link to the endpoint. The PDF route is tenant-scoped, and for a
  // SUPER_ADMIN the tenant lives ONLY in the X-Tenant-Id header — which a plain navigation cannot
  // send, so the tab would land on "a target tenant is required" instead of the document. Same fix
  // the logo and the preview already use.
  //
  // The tab is opened SYNCHRONOUSLY, inside the click, and pointed at the blob afterwards. Opening
  // it after the await spends the browser's transient user activation on a fetch, and the popup
  // blocker then swallows the call: the button downloads the bytes and appears to do nothing.
  async function openPdf(doc: IssuedDocument) {
    // No `noopener` FEATURE here: by spec it makes window.open return null, which would leave a real
    // blank tab open with no handle to point at the blob — and the fallback would then navigate the
    // console itself away while that tab sat there empty. The handle is kept and `opener` is severed
    // on it instead, which is the same protection without losing the tab.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    // The fetch can REJECT (offline, DNS, a dropped connection), not merely answer non-OK;
    // uncaught, the tab just opened would stay blank with no message to the operator.
    let url: string;
    try {
      const res = await mediaFetch(`/api/v1/documents/${doc.id}/pdf`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      url = URL.createObjectURL(await res.blob());
    } catch {
      tab?.close();
      showToast(
        t("documents.openPdfError", "Could not open the PDF."),
        "error",
      );
      return;
    }
    if (tab) {
      tab.location.href = url;
    } else {
      // The popup blocker refused even the synchronous open. Navigating this tab is better than a
      // button that silently does nothing.
      window.location.href = url;
    }
    // The tab has the bytes by the time it paints; holding the handle any longer leaks it for as
    // long as the console stays open.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // Asked first, because there is no un-revoke. The PDF stops being served, and the agent's
  // idempotency key is derived from the VALUES, so every later send of the same document resolves
  // to this revoked row rather than issuing a fresh one — an accidental click on a row in a list is
  // permanent, and it takes the customer's copy with it.
  function askRevoke(doc: IssuedDocument) {
    confirm.open({
      title: t("documents.revokeTitle", "Revoke document"),
      message: t(
        "documents.revokeMessage",
        'Revoke "{{name}}"? Its PDF stops being served and this cannot be undone.',
        { name: doc.number || doc.title },
      ),
      danger: true,
      confirmLabel: t("documents.revoke", "Revoke"),
      onConfirm: () => revoke(doc),
    });
  }

  async function revoke(doc: IssuedDocument) {
    try {
      const { error: err } = await api.api.v1
        .documents({ id: doc.id })
        .revoke.post();
      if (err) throw err;
    } catch (e) {
      showToast(
        apiErrorMessage(e) || t("documents.revokeError", "Could not revoke."),
        "error",
      );
      // Rethrown so the confirm dialog stays OPEN on failure, per its own contract: a revoke worth
      // asking about is worth retrying without hunting the row down in the list again. Eden
      // RESOLVES an HTTP error as `{ error }` and REJECTS on a transport failure, so both halves
      // land here.
      throw e;
    }
    showToast(t("documents.revoked", "Revoked."), "success");
    revokedHere.current.add(doc.id);
    // Marked in place rather than reloaded, so the pages the operator loaded stay on screen.
    setDocs((prev) =>
      prev.map((d) => (d.id === doc.id ? { ...d, revoked: true } : d)),
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative min-w-0">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-text-muted"
          aria-hidden="true"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t(
            "documents.issuedSearch",
            "Search by number or title…",
          )}
          aria-label={t("documents.issuedSearch", "Search by number or title…")}
          className="h-8 w-full rounded-md border border-border-hover bg-bg-tertiary pr-2.5 pl-8 text-sm text-text-primary placeholder-text-placeholder transition-colors focus:border-border-focus focus:outline-none focus:ring-2 focus:ring-accent-soft"
        />
      </div>

      <DataBoundary
        loading={loading && docs.length === 0}
        error={error}
        isEmpty={docs.length === 0}
        onRetry={load}
        empty={
          query ? (
            <EmptyState
              icon={Search}
              title={t("documents.issuedNoMatch", "No document matches")}
              description={t(
                "documents.issuedNoMatchDesc",
                'Nothing issued has "{{query}}" in its number or title.',
                { query },
              )}
            />
          ) : (
            <EmptyState
              icon={FileCheck}
              title={t("documents.issuedEmptyTitle", "No documents issued yet")}
              description={t(
                "documents.issuedEmptyDesc",
                "Documents your agents issue from a template show up here, with the PDF the customer received.",
              )}
            />
          )
        }
      >
        <div className="flex flex-col gap-2">
          {docs.map((doc) => (
            <Card
              key={doc.id}
              className="flex items-center justify-between gap-4 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-sm text-text-primary">
                    {doc.number ? `${doc.title} ${doc.number}` : doc.title}
                  </span>
                  {doc.revoked && (
                    <Badge variant="secondary">
                      {t("documents.revokedBadge", "Revoked")}
                    </Badge>
                  )}
                  {!doc.revoked && doc.status !== "READY" && (
                    <Badge variant="secondary">
                      {t("documents.pendingBadge", "Not rendered")}
                    </Badge>
                  )}
                </div>
                {/* Which template it came from, and when. Without the first, two documents from
                    different templates that happen to share a title are the same row twice. A
                    document OUTLIVES its template (the FK nulls the id on delete), so the miss is a
                    real state and says so. */}
                <p className="mt-0.5 truncate text-text-muted text-xs">
                  {templateNames && (
                    <>
                      {doc.templateId
                        ? (templateNames.get(doc.templateId) ??
                          t("documents.templateGone", "Template deleted"))
                        : t("documents.templateGone", "Template deleted")}
                      {" · "}
                    </>
                  )}
                  {new Date(doc.createdAt).toLocaleString()}
                  {doc.conversationId && (
                    <>
                      {" · "}
                      <Link
                        to={`/conversations/${doc.conversationId}`}
                        className="text-accent hover:underline"
                      >
                        {t("documents.issuedConversation", "Conversation")}
                      </Link>
                    </>
                  )}
                  {doc.approvalRequestId && (
                    <>
                      {" · "}
                      <Link
                        to={`/document-approvals/${doc.approvalRequestId}`}
                        className="text-accent hover:underline"
                      >
                        {t("documents.issuedApproval", "Approval")}
                      </Link>
                    </>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => openPdf(doc)}
                  // A row exists before its PDF does: the render happens after the insert, and a
                  // failure there leaves a PENDING row with no storage key. Enabled, the button
                  // could only ever fetch a 404 and say nothing about why.
                  disabled={doc.revoked || doc.status !== "READY"}
                >
                  {t("documents.openPdf", "Open PDF")}
                </Button>
                {!doc.revoked && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => askRevoke(doc)}
                  >
                    {t("documents.revoke", "Revoke")}
                  </Button>
                )}
              </div>
            </Card>
          ))}
          {nextBefore && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={loadMore}
                loading={loadingMore}
                // A reload of the first page is in flight: the cursor on screen belongs to the list
                // it is about to replace.
                disabled={loading}
              >
                {t("documents.loadMore", "Load more")}
              </Button>
            </div>
          )}
        </div>
      </DataBoundary>

      <ConfirmDialog modal={confirm} />
    </div>
  );
}
