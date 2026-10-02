import { Loader2, MessageSquare, Send } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Modal,
  ModalCancelButton,
  type ModalController,
  Textarea,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { formatDateTime } from "@/client/lib/utils";
import { Button } from "@/client/merchant/components/ui/button";

// The human-in-the-loop outreach rail on one lead: the gateway drafts
// Vietnamese sales copy, the operator edits/approves here, then copies the
// text to the platform by hand. Marking sent is bookkeeping - nothing posts
// outward. DM_OPENER approve/mark-sent also moves a NEW lead to CONTACTED
// server-side, so the parent refreshes its list via onChanged.

type DraftsData = Awaited<
  ReturnType<
    ReturnType<(typeof api.api.v1.merchant.leads)>["drafts"]["get"]
  >
>["data"];
export type ReplyDraft = NonNullable<DraftsData>["drafts"][number];
type DraftKind = ReplyDraft["kind"];
type DraftStatus = ReplyDraft["status"];

export interface DraftLead {
  id: string;
  authorName: string;
}

const KIND_LABEL: Record<DraftKind, string> = {
  PUBLIC_REPLY: "merchant.funnel.kind.publicReply",
  DM_OPENER: "merchant.funnel.kind.dmOpener",
};

const KIND_VARIANT: Record<DraftKind, "info" | "primary"> = {
  PUBLIC_REPLY: "info",
  DM_OPENER: "primary",
};

const STATUS_LABEL: Record<DraftStatus, string> = {
  DRAFT: "merchant.funnel.draftStatus.draft",
  APPROVED: "merchant.funnel.draftStatus.approved",
  SENT: "merchant.funnel.draftStatus.sent",
  REJECTED: "merchant.funnel.draftStatus.rejected",
};

const STATUS_VARIANT: Record<
  DraftStatus,
  "secondary" | "primary" | "success" | "error"
> = {
  DRAFT: "secondary",
  APPROVED: "primary",
  SENT: "success",
  REJECTED: "error",
};

export function LeadDraftsModal({
  modal,
  onChanged,
}: {
  modal: ModalController<DraftLead>;
  onChanged: () => void;
}) {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const [drafts, setDrafts] = useState<ReplyDraft[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lead = modal.payload;

  async function refresh(leadId: string) {
    setLoading(true);
    const { data, error: err } = await api.api.v1.merchant
      .leads({ id: leadId })
      .drafts.get();
    setLoading(false);
    if (err || !data) {
      setError(
        apiErrorMessage(err) ??
          t("merchant.funnel.loadFailed", "Could not load drafts"),
      );
      return;
    }
    setDrafts(data.drafts);
  }

  // Fresh session per open: the previous lead's drafts/edits must not bleed
  // through, and the list always reflects the server's state.
  useOnModalOpen(modal, () => {
    setDrafts([]);
    setEdits({});
    setBusy(null);
    setError(null);
    if (modal.payload) void refresh(modal.payload.id);
  });

  async function generate(kind: DraftKind) {
    if (!lead) return;
    setBusy(`generate:${kind}`);
    setError(null);
    const { data, error: err } = await api.api.v1.merchant
      .leads({ id: lead.id })
      .drafts.post({ kind });
    setBusy(null);
    if (err || !data) {
      setError(
        apiErrorMessage(err) ??
          t("merchant.funnel.generateFailed", "Could not draft a reply"),
      );
      return;
    }
    await refresh(lead.id);
  }

  async function save(draft: ReplyDraft) {
    const body = (edits[draft.id] ?? draft.body).trim();
    if (!body) return;
    setBusy(`save:${draft.id}`);
    setError(null);
    const { error: err } = await api.api.v1.merchant
      .drafts({ id: draft.id })
      .patch({ body });
    setBusy(null);
    if (err) {
      setError(
        apiErrorMessage(err) ??
          t("merchant.funnel.saveFailed", "Could not save the draft"),
      );
      return;
    }
    if (lead) await refresh(lead.id);
  }

  async function act(
    draft: ReplyDraft,
    action: "approve" | "reject" | "mark-sent",
  ) {
    setBusy(`${action}:${draft.id}`);
    setError(null);
    const target = api.api.v1.merchant.drafts({ id: draft.id });
    const { error: err } =
      action === "approve"
        ? await target.approve.post({})
        : action === "reject"
          ? await target.reject.post({})
          : await target["mark-sent"].post({});
    setBusy(null);
    if (err) {
      setError(
        apiErrorMessage(err) ??
          t("merchant.funnel.actionFailed", "The action failed"),
      );
      return;
    }
    if (lead) await refresh(lead.id);
    // A DM_OPENER approve/mark-sent moves a NEW lead to CONTACTED.
    if (draft.kind === "DM_OPENER" && action !== "reject") onChanged();
  }

  function copyBody(text: string) {
    void navigator.clipboard
      ?.writeText(text)
      .then(() =>
        showToast(t("merchant.funnel.copied", "Copied to clipboard"), "success"),
      );
  }

  return (
    <Modal
      modal={modal}
      title={t("merchant.funnel.title", "Outreach drafts")}
      description={
        lead
          ? t(
              "merchant.funnel.subtitle",
              "Draft replies for {{name}}. Nothing posts outward - approve, copy, then mark sent.",
              { name: lead.authorName },
            )
          : undefined
      }
      size="xl"
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy !== null || loading || !lead}
              onClick={() => void generate("PUBLIC_REPLY")}
            >
              {busy === "generate:PUBLIC_REPLY" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <MessageSquare className="size-4" />
              )}
              {t("merchant.funnel.newPublicReply", "Public reply")}
            </Button>
            <Button
              variant="outline"
              disabled={busy !== null || loading || !lead}
              onClick={() => void generate("DM_OPENER")}
            >
              {busy === "generate:DM_OPENER" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              {t("merchant.funnel.newDmOpener", "DM opener")}
            </Button>
          </div>
          <ModalCancelButton />
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {loading && (
          <p className="text-sm text-text-secondary">
            {t("merchant.funnel.loading", "Loading…")}
          </p>
        )}
        {error && <p className="text-error text-sm">{error}</p>}
        {!loading && drafts.length === 0 && !error && (
          <p className="text-sm text-text-secondary">
            {t(
              "merchant.funnel.empty",
              "No drafts yet. Generate a public reply or a DM opener.",
            )}
          </p>
        )}
        {drafts.map((draft) => {
          const editable = draft.status === "DRAFT";
          const value = edits[draft.id] ?? draft.body;
          return (
            <div
              key={draft.id}
              className="flex flex-col gap-2 rounded-md border p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant={KIND_VARIANT[draft.kind]}>
                    {
                      // t('merchant.funnel.kind.publicReply', 'Public reply')
                      // t('merchant.funnel.kind.dmOpener', 'DM opener')
                      // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in KIND_LABEL
                      t(KIND_LABEL[draft.kind], draft.kind)
                    }
                  </Badge>
                  <Badge variant={STATUS_VARIANT[draft.status]}>
                    {
                      // t('merchant.funnel.draftStatus.draft', 'Draft')
                      // t('merchant.funnel.draftStatus.approved', 'Approved')
                      // t('merchant.funnel.draftStatus.sent', 'Sent')
                      // t('merchant.funnel.draftStatus.rejected', 'Rejected')
                      // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in STATUS_LABEL
                      t(STATUS_LABEL[draft.status], draft.status)
                    }
                  </Badge>
                  {draft.sentAt && (
                    <span className="text-muted-foreground text-xs">
                      {formatDateTime(draft.sentAt, i18n.language)}
                    </span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copyBody(value)}
                >
                  {t("merchant.funnel.copy", "Copy")}
                </Button>
              </div>
              {editable ? (
                <Textarea
                  value={value}
                  rows={4}
                  maxLength={4000}
                  onChange={(e) =>
                    setEdits((prev) => ({ ...prev, [draft.id]: e.target.value }))
                  }
                />
              ) : (
                <p className="whitespace-pre-line text-sm text-text-primary">
                  {draft.body}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {editable && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null || value.trim() === draft.body}
                      onClick={() => void save(draft)}
                    >
                      {busy === `save:${draft.id}`
                        ? t("merchant.funnel.saving", "Saving…")
                        : t("merchant.funnel.save", "Save edits")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void act(draft, "approve")}
                    >
                      {busy === `approve:${draft.id}`
                        ? t("merchant.funnel.working", "Working…")
                        : t("merchant.funnel.approve", "Approve")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void act(draft, "reject")}
                    >
                      {t("merchant.funnel.reject", "Reject")}
                    </Button>
                  </>
                )}
                {draft.status === "APPROVED" && (
                  <>
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void act(draft, "mark-sent")}
                    >
                      {busy === `mark-sent:${draft.id}`
                        ? t("merchant.funnel.working", "Working…")
                        : t("merchant.funnel.markSent", "Mark sent")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() => void act(draft, "reject")}
                    >
                      {t("merchant.funnel.reject", "Reject")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
