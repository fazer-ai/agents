import {
  Check,
  ClipboardCheck,
  Database,
  FlaskConical,
  MessageSquare,
  Pencil,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
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
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { approvalEditPatch } from "@/client/lib/approvalEdit";

// Types derived from the Eden treaty — never hand-declared (see docs/eden-treaty.md).
type ApprovalsData = Awaited<
  ReturnType<typeof api.api.v1.knowledge.approvals.get>
>["data"];
type Approval = NonNullable<ApprovalsData>["approvals"][number];

// The knowledge-suggestion approval queue, rendered as a SECTION inside the Knowledge panel (it used
// to be a top-level page). Reports the pending count up so the Components → Knowledge tab can show a
// badge. Renders nothing once the queue is empty (the badge disappears too), so a clean knowledge
// base has no clutter.
export function KnowledgeApprovals({
  onCountChange,
}: {
  onCountChange?: (count: number) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [approvals, setApprovals] = useState<Approval[]>([]);
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

  useEffect(() => {
    let active = true;
    api.api.v1.knowledge.approvals
      .get()
      .then(({ data, error: err }) => {
        if (!active) return;
        if (err || !data) {
          setError(true);
          return;
        }
        setApprovals(data.approvals);
        onCountChange?.(data.approvals.length);
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

  async function act(id: string, action: "approve" | "reject") {
    setBusyId(id);
    try {
      const endpoint = api.api.v1.knowledge.approvals({ id });
      const { error: err } =
        action === "approve"
          ? await endpoint.approve.post()
          : await endpoint.reject.post();
      if (err) {
        showToast(
          apiErrorMessage(err) || t("approvals.actionError", "Action failed."),
          "error",
        );
        return;
      }
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

  function startEdit(a: Approval) {
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
        showToast(
          apiErrorMessage(err) ||
            t("approvals.editError", "Could not save the edit."),
          "error",
        );
        return;
      }
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
  if (approvals.length === 0) return null;

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
                <FormField label={t("approvals.editTitle", "Title")}>
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
              ) : (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => act(a.id, "reject")}
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
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => act(a.id, "approve")}
                  >
                    <Check className="h-4 w-4" aria-hidden="true" />
                    {t("approvals.approve", "Approve")}
                  </Button>
                </>
              )}
            </div>
          </Card>
        ))}
      </div>
    </section>
  );
}

// t('approvals.status.PENDING', 'Pending')
// t('approvals.status.EDITED', 'Edited')
