import {
  Check,
  ClipboardCheck,
  Database,
  FilePen,
  FlaskConical,
  MessageSquare,
  Pencil,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  Badge,
  Button,
  Card,
  FormField,
  Input,
  Textarea,
  useToast,
} from "@/client/components";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { approvalEditPatch } from "@/client/lib/approvalEdit";
import { cn } from "@/client/lib/utils";

// Types derived from the Eden treaty — never hand-declared (see docs/eden-treaty.md).
type ApprovalsData = Awaited<
  ReturnType<typeof api.api.v1.knowledge.approvals.get>
>["data"];
type Approval = NonNullable<ApprovalsData>["approvals"][number];
type DiscardedData = Awaited<
  ReturnType<typeof api.api.v1.knowledge.approvals.discarded.get>
>["data"];
type Discarded = NonNullable<DiscardedData>["approvals"][number];

// The knowledge-suggestion approval queue, rendered as a SECTION inside the Knowledge panel. Reports the pending count up so the Components → Knowledge tab can show a
// badge. Renders nothing once the queue is empty (the badge disappears too), so a clean knowledge
// base has no clutter.
// The two keys the edit patch carries, spelled the way the route refuses them.
const APPROVAL_FIELDS = ["title", "content"] as const;

export function KnowledgeApprovals({
  onCountChange,
}: {
  onCountChange?: (count: number) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  // What the suggestion reviewer held back as a repeat, on a tab of its own.
  const [discarded, setDiscarded] = useState<Discarded[]>([]);
  const [view, setView] = useState<"pending" | "discarded">("pending");
  // The card whose rejection is being written, with its optional reason.
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Holds the card whose request is open, and there is only ever one: every action that mutates is
  // disabled while ANY card is busy. A per-card `busyId === a.id` guard is not enough, because
  // approving a second card mid-save hands the token over, which unlocks the first card's editor
  // while its PATCH is still in flight — the late response then overwrites what was typed after.
  const [busyId, setBusyId] = useState<string | null>(null);
  const busy = busyId !== null;
  // The card being revised, if any. One at a time: the queue is a review surface, and two open
  // editors invite approving the card the reviewer was not reading.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", content: "" });
  // Gated on the editor being open, because that is what the two inputs are gated on: they are drawn
  // inside `editingId === a.id`, and a list that names them while it is null claims a control that
  // is not there. Not a reachable failure today — Cancel is disabled while the PATCH is out, so the
  // editor cannot close under its own save — but the claim is what the rest of this reads.
  const refusal = useFieldRefusal(editingId ? APPROVAL_FIELDS : []);
  // The CURRENT draft, readable from inside a request that started before it.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    let active = true;
    Promise.all([
      api.api.v1.knowledge.approvals.get(),
      api.api.v1.knowledge.approvals.discarded.get(),
    ])
      .then(([pending, held]) => {
        if (!active) return;
        if (pending.error || !pending.data) {
          setError(true);
          return;
        }
        setApprovals(pending.data.approvals);
        onCountChange?.(pending.data.approvals.length);
        // NOTE: The discarded tab is secondary: failing to read it hides the tab, not the queue.
        setDiscarded(held.data?.approvals ?? []);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onCountChange]);

  async function act(
    id: string,
    action: "approve" | "reject",
    opts: { asNew?: boolean; reason?: string } = {},
  ) {
    setBusyId(id);
    try {
      const endpoint = api.api.v1.knowledge.approvals({ id });
      const { data, error: err } =
        action === "approve"
          ? await endpoint.approve.post(opts.asNew ? { asNew: true } : {})
          : await endpoint.reject.post(
              opts.reason?.trim() ? { reason: opts.reason.trim() } : {},
            );
      if (err) {
        showToast(
          apiErrorMessage(err) || t("approvals.actionError", "Action failed."),
          "error",
        );
        return;
      }
      // NOTE: The document the reviewer named is gone or now synced; nothing was claimed, so the card
      // stays and offers only the approval as a new document.
      if (
        data &&
        typeof data.result === "object" &&
        data.result.outcome === "replace-unavailable"
      ) {
        setApprovals((prev) =>
          prev.map((it) =>
            it.id === id
              ? { ...it, replacesDocument: null, replaceUnavailable: true }
              : it,
          ),
        );
        showToast(
          t(
            "approvals.replaceGone",
            "The document to replace can no longer be replaced. Approve it as a new document instead.",
          ),
          "error",
        );
        return;
      }
      setRejectingId(null);
      setReason("");
      setApprovals((prev) => {
        const next = prev.filter((a) => a.id !== id);
        onCountChange?.(next.length);
        return next;
      });
      showToast(
        action === "approve"
          ? t("approvals.approved", "Suggestion approved and added.")
          : t("approvals.rejected", "Suggestion rejected."),
        "success",
      );
    } catch {
      showToast(t("approvals.actionError", "Action failed."), "error");
    } finally {
      setBusyId(null);
    }
  }

  async function requeue(id: string) {
    setBusyId(id);
    try {
      const { data, error: err } = await api.api.v1.knowledge
        .approvals({ id })
        .requeue.post();
      if (err) {
        showToast(
          apiErrorMessage(err) || t("approvals.actionError", "Action failed."),
          "error",
        );
        return;
      }
      const item = discarded.find((d) => d.id === id);
      setDiscarded((prev) => prev.filter((d) => d.id !== id));
      if (data?.result === "requeued" && item) {
        const next = [...approvals, { ...item, status: "PENDING" as const }];
        setApprovals(next);
        onCountChange?.(next.length);
      }
      if (data?.result === "requeued") {
        showToast(
          t("approvals.requeued", "Suggestion sent to the pending list."),
          "success",
        );
      } else {
        showToast(
          t(
            "approvals.requeueGone",
            "Someone already moved this suggestion; reload to see where it is.",
          ),
          "error",
        );
      }
    } catch {
      showToast(t("approvals.actionError", "Action failed."), "error");
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(a: Approval) {
    // Per editing SESSION, like a dialog's own reset: the mark expires by value, so reopening the
    // same item — or another one whose title happens to match — would show the last request's
    // server sentence before anything has been sent.
    refusal.clear();
    setEditingId(a.id);
    setDraft({
      title: a.proposedTitle ?? "",
      content: a.proposedContent,
    });
  }

  async function saveEdit(a: Approval) {
    const patch = approvalEditPatch(a, draft);
    // Nothing to send: close the editor without touching the item. Calling PATCH anyway would stamp
    // it EDITED, which claims a revision that did not happen (see lib/approvalEdit).
    if (!patch) {
      setEditingId(null);
      return;
    }
    setBusyId(a.id);
    try {
      const { data, error: err } = await api.api.v1.knowledge
        .approvals({ id: a.id })
        .patch(patch);
      if (err) {
        const toast = refusal.capture(
          err,
          t("approvals.editError", "Could not save the edit."),
          { ...patch },
          {
            title: draftRef.current.title.trim(),
            content: draftRef.current.content.trim(),
          },
        );
        if (toast) showToast(toast, "error");
        return;
      }
      refusal.clear();
      // The endpoint reports a lost race INSIDE a 200: another reviewer approved or rejected this
      // item while the editor was open, so the revision was never stored. Checking only `error`
      // would leave the card claiming EDITED over text that no longer exists in the queue.
      if (data?.result === "not-pending") {
        setApprovals((prev) => {
          const next = prev.filter((it) => it.id !== a.id);
          onCountChange?.(next.length);
          return next;
        });
        setEditingId(null);
        showToast(
          t(
            "approvals.editGone",
            "Someone else already reviewed this suggestion.",
          ),
          "error",
        );
        return;
      }
      setApprovals((prev) =>
        prev.map((it) =>
          it.id === a.id
            ? {
                ...it,
                status: "EDITED",
                proposedTitle: patch.title ?? it.proposedTitle,
                proposedContent: patch.content ?? it.proposedContent,
              }
            : it,
        ),
      );
      setEditingId(null);
      showToast(t("approvals.edited", "Suggestion updated."), "success");
    } catch {
      showToast(t("approvals.editError", "Could not save the edit."), "error");
    } finally {
      setBusyId(null);
    }
  }

  // Quiet section: nothing to show while loading the secondary queue, and nothing once it's empty.
  if (loading) return null;
  if (error) {
    return (
      <Card>
        <p className="py-4 text-center text-error text-sm">
          {t("approvals.error", "Could not load the approval queue.")}
        </p>
      </Card>
    );
  }
  if (approvals.length === 0 && discarded.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <ClipboardCheck className="h-4 w-4 text-accent" aria-hidden="true" />
        <h3 className="font-medium text-text-primary">
          {t("knowledge.approvalsTitle", "Pending approvals")}
        </h3>
        <Badge variant="warning">{approvals.length}</Badge>
      </div>
      <p className="text-sm text-text-muted">
        {t(
          "approvals.subtitle",
          "Review suggestions before they enter a knowledge base. Nothing is added without approval.",
        )}
      </p>
      {discarded.length > 0 ? (
        <div
          role="tablist"
          aria-label={t("approvals.views", "Suggestion lists")}
          className="flex gap-2"
        >
          {(["pending", "discarded"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={cn(
                "rounded-md px-2.5 py-1 text-sm",
                view === v
                  ? "bg-accent-soft text-accent"
                  : "text-text-muted hover:bg-bg-hover",
              )}
            >
              {v === "pending"
                ? t("approvals.viewPending", "Pending ({{n}})", {
                    n: approvals.length,
                  })
                : t(
                    "approvals.viewDiscarded",
                    "Discarded by the reviewer ({{n}})",
                    {
                      n: discarded.length,
                    },
                  )}
            </button>
          ))}
        </div>
      ) : null}
      {view === "discarded" && discarded.length > 0 ? (
        <div className="flex flex-col gap-3">
          {discarded.map((d) => (
            <Card key={d.id} className="flex flex-col gap-3">
              <h4 className="font-medium text-text-primary">
                {d.proposedTitle ?? t("approvals.untitled", "Untitled")}
              </h4>
              <p className="whitespace-pre-wrap text-sm text-text-secondary">
                {d.proposedContent}
              </p>
              {d.reviewerComment ? (
                <ReviewerComment text={d.reviewerComment} />
              ) : null}
              {d.match ? (
                <div className="flex flex-col gap-1 rounded-md border border-border p-3">
                  <p className="text-text-muted text-xs">
                    {d.match.kind === "document"
                      ? t(
                          "approvals.matchedDocument",
                          "Matched the document “{{title}}”",
                          {
                            title: d.match.document.title,
                          },
                        )
                      : t(
                          "approvals.matchedSuggestion",
                          "Matched an earlier suggestion ({{status}})",
                          {
                            status: t(
                              // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments
                              `approvals.status.${d.match.status}`,
                              d.match.status,
                            ),
                          },
                        )}
                  </p>
                  <p className="whitespace-pre-wrap text-sm text-text-secondary">
                    {d.match.kind === "document"
                      ? d.match.document.content
                      : d.match.content}
                  </p>
                </div>
              ) : null}
              <div className="flex justify-end">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  loading={busyId === d.id}
                  onClick={() => void requeue(d.id)}
                >
                  <Undo2 className="h-4 w-4" aria-hidden="true" />
                  {t("approvals.requeue", "Send to the pending list")}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {approvals.map((a) => (
            <Card key={a.id} className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <h4 className="font-medium text-text-primary">
                  {a.proposedTitle ?? t("approvals.untitled", "Untitled")}
                </h4>
                <Badge variant={a.status === "EDITED" ? "info" : "warning"}>
                  {/* biome-ignore lint/plugin/no-dynamic-i18n-key: status keys extracted via magic comments below */}
                  {t(`approvals.status.${a.status}`, a.status)}
                </Badge>
              </div>
              {editingId === a.id ? (
                <div className="flex flex-col gap-3">
                  {/* Disabled while the save is in flight: `saveEdit` captured the draft when it was
                    clicked, so anything typed after that would be dropped by the response that
                    closes the editor. */}
                  <FormField
                    label={t("approvals.editTitle", "Title")}
                    error={refusal.at("title", draft.title.trim())}
                  >
                    <Input
                      value={draft.title}
                      disabled={busyId === a.id}
                      onChange={(e) =>
                        setDraft({ ...draft, title: e.target.value })
                      }
                    />
                  </FormField>
                  <FormField
                    label={t("approvals.editContent", "Content")}
                    description={t(
                      "approvals.editContentHint",
                      "This text is stored in the knowledge base exactly as written. Make it a standalone statement, with no caveats about checking it.",
                    )}
                    error={refusal.at("content", draft.content.trim())}
                  >
                    <Textarea
                      rows={6}
                      value={draft.content}
                      disabled={busyId === a.id}
                      onChange={(e) =>
                        setDraft({ ...draft, content: e.target.value })
                      }
                    />
                  </FormField>
                </div>
              ) : (
                <p className="whitespace-pre-wrap text-sm text-text-secondary">
                  {a.proposedContent}
                </p>
              )}
              {a.rationale ? (
                <p className="text-text-muted text-xs italic">
                  {t("approvals.rationale", "Rationale: {{text}}", {
                    text: a.rationale,
                  })}
                </p>
              ) : null}
              {a.reviewerComment ? (
                <ReviewerComment text={a.reviewerComment} />
              ) : null}
              {a.replaceUnavailable ? (
                <p className="inline-flex items-start gap-1 text-text-muted text-xs">
                  <FilePen
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  {t(
                    "approvals.replaceUnavailable",
                    "The reviewer suggested replacing a document that can no longer be replaced (deleted, or kept in sync with its source). Approving adds this as a new document.",
                  )}
                </p>
              ) : a.replacesDocument ? (
                <div className="flex flex-col gap-1 rounded-md border border-border p-3">
                  <p className="inline-flex items-center gap-1 text-text-muted text-xs">
                    <FilePen className="h-3.5 w-3.5" aria-hidden="true" />
                    {t(
                      "approvals.replaces",
                      "Approving replaces the document “{{title}}”, which says today:",
                      { title: a.replacesDocument.title },
                    )}
                  </p>
                  <p className="whitespace-pre-wrap text-sm text-text-secondary">
                    {a.replacesDocument.content}
                  </p>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-text-muted text-xs">
                {a.knowledgeBaseName ? (
                  <span className="inline-flex items-center gap-1">
                    <Database className="h-3.5 w-3.5" aria-hidden="true" />
                    {t("approvals.targetBase", "Knowledge base: {{name}}", {
                      name: a.knowledgeBaseName,
                    })}
                  </span>
                ) : null}
                {a.source?.kind === "conversation" ? (
                  <Link
                    to={`/conversations/${a.source.conversationId}`}
                    className="inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                    {t(
                      "approvals.fromConversation",
                      "From the conversation: {{label}}",
                      { label: a.source.label },
                    )}
                  </Link>
                ) : a.source?.kind === "playground" ? (
                  <Link
                    to={`/agents/${a.source.agentId}/playground`}
                    className="inline-flex items-center gap-1 text-accent hover:underline"
                  >
                    <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
                    {a.source.agentName
                      ? t(
                          "approvals.fromPlayground",
                          "From the playground of {{name}}",
                          { name: a.source.agentName },
                        )
                      : t(
                          "approvals.fromPlaygroundGeneric",
                          "From an agent's playground",
                        )}
                  </Link>
                ) : null}
              </div>
              {/* Approve copies the text verbatim into the base, so it is deliberately absent while
                the editor is open: the reviewer decides on the text in front of them, and an approve
                that fired mid-revision would publish the version they were replacing. */}
              <div className="flex justify-end gap-2">
                {editingId === a.id ? (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busyId === a.id}
                      onClick={() => setEditingId(null)}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                      {t("common.cancel", "Cancel")}
                    </Button>
                    <Button
                      size="sm"
                      loading={busyId === a.id}
                      disabled={busy || !draft.content.trim()}
                      onClick={() => void saveEdit(a)}
                    >
                      <Check className="h-4 w-4" aria-hidden="true" />
                      {t("common.save", "Save")}
                    </Button>
                  </>
                ) : rejectingId === a.id ? (
                  <div className="flex w-full flex-col gap-2">
                    <FormField
                      label={t("approvals.rejectReason", "Reason (optional)")}
                      description={t(
                        "approvals.rejectReasonHint",
                        "The reviewer reads it next time, so a corrected suggestion is not held back by this one.",
                      )}
                    >
                      <Textarea
                        rows={2}
                        maxLength={1000}
                        value={reason}
                        disabled={busyId === a.id}
                        onChange={(e) => setReason(e.target.value)}
                      />
                    </FormField>
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busyId === a.id}
                        onClick={() => {
                          setRejectingId(null);
                          setReason("");
                        }}
                      >
                        {t("common.cancel", "Cancel")}
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        loading={busyId === a.id}
                        disabled={busy}
                        onClick={() => act(a.id, "reject", { reason })}
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                        {t("approvals.confirmReject", "Reject")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || editingId !== null}
                      onClick={() => {
                        setRejectingId(a.id);
                        setReason("");
                      }}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                      {t("approvals.reject", "Reject")}
                    </Button>
                    {/* Disabled while ANOTHER card is being revised: the draft is single, so a
                      second Edit would replace it and the first card's unsaved rewrite would
                      vanish with no warning. */}
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || editingId !== null}
                      onClick={() => startEdit(a)}
                    >
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                      {t("approvals.edit", "Edit")}
                    </Button>
                    {a.replaceUnavailable ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => act(a.id, "approve", { asNew: true })}
                      >
                        <Check className="h-4 w-4" aria-hidden="true" />
                        {t(
                          "approvals.approveAsNew",
                          "Approve as a new document",
                        )}
                      </Button>
                    ) : a.replacesDocument ? (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => act(a.id, "approve", { asNew: true })}
                        >
                          {t(
                            "approvals.approveAsNew",
                            "Approve as a new document",
                          )}
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => act(a.id, "approve")}
                        >
                          <Check className="h-4 w-4" aria-hidden="true" />
                          {t("approvals.approveReplace", "Approve and replace")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => act(a.id, "approve")}
                      >
                        <Check className="h-4 w-4" aria-hidden="true" />
                        {t("approvals.approve", "Approve")}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

// What the suggestion reviewer said about an item, kept apart from the agent's own rationale.
function ReviewerComment({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <p className="inline-flex items-start gap-1 text-text-muted text-xs">
      <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {t("approvals.reviewerComment", "Reviewer: {{text}}", { text })}
    </p>
  );
}

// t('approvals.status.PENDING', 'Pending')
// t('approvals.status.EDITED', 'Edited')
// t('approvals.status.REJECTED', 'Rejected')
// t('approvals.status.APPROVED', 'Approved')
