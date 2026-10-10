import type { TFunction } from "i18next";
import { serverNow } from "@/client/lib/serverClock";

// How a document approval request reads in the console (docs/documents.md, Approval): its status, and
// what the decision came to in the conversation. Shared by the request's page, the approvals history
// and the conversation view, so the three say the same thing about the same request.

export type ApprovalBadgeVariant =
  | "warning"
  | "success"
  | "error"
  | "secondary";

export const APPROVAL_STATUS_VARIANT: Record<string, ApprovalBadgeVariant> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "error",
  EXPIRED: "secondary",
  CANCELLED: "secondary",
};

export function approvalStatusLabel(status: string, t: TFunction): string {
  return (
    {
      PENDING: t("documentApproval.status.pending", "Waiting for approval"),
      APPROVED: t("documentApproval.status.approved", "Approved"),
      REJECTED: t("documentApproval.status.rejected", "Rejected"),
      EXPIRED: t("documentApproval.status.expired", "Expired"),
      CANCELLED: t("documentApproval.status.cancelled", "Cancelled"),
    }[status] ?? status
  );
}

// How long an approval may go without a recorded outcome before "on its way" stops being true: the
// outcome lands seconds after the decision, and a run still failing past this is not on its way.
export const SENDING_FOR_MS = 10 * 60_000;
// An approval commits APPROVED before its document is rendered and linked, so for a moment another
// reader sees it with no document while the approver's request is still issuing it. Past this, a
// missing document is the failure after the claim, and approving again is the way out.
export const ISSUING_FOR_MS = 2 * 60_000;

export function isIssuing(r: {
  status: string;
  outcome: string | null;
  issuedDocumentId?: string | null;
  decidedAt?: Date | string | null;
}): boolean {
  return (
    r.status === "APPROVED" &&
    r.outcome === null &&
    r.issuedDocumentId === null &&
    r.decidedAt != null &&
    serverNow() - new Date(r.decidedAt).getTime() < ISSUING_FOR_MS
  );
}

// What happened in the conversation after the decision, or null when there is nothing to add (still
// pending, or an expiry or cancellation, whose status already says nothing was sent).
export function approvalOutcomeLabel(
  r: {
    status: string;
    outcome: string | null;
    decidedAt?: Date | string | null;
    issuedDocumentId?: string | null;
  },
  t: TFunction,
): string | null {
  if (r.outcome === "NO_AGENT") {
    return t(
      "documentApproval.outcome.noAgent",
      "No agent left in the conversation to tell",
    );
  }
  if (r.status === "APPROVED") {
    if (r.outcome === "DELIVERED") {
      return t("documentApproval.outcome.delivered", "Sent to the customer");
    }
    if (r.outcome === "NOTED") {
      return t(
        "documentApproval.outcome.notSent",
        "Not sent: a private note in the conversation says why",
      );
    }
    if (r.outcome === "NOT_SENT") {
      return t(
        "documentApproval.outcome.notSentUnexplained",
        "Not sent to the customer",
      );
    }
    // The failure after the claim: nothing was issued, so nothing is on its way. Right after the
    // decision the document may still be issuing, and that reads as on its way.
    if (r.outcome === null && r.issuedDocumentId === null && !isIssuing(r)) {
      return t(
        "documentApproval.outcome.notIssued",
        "Not issued: approve it again",
      );
    }
    const decided = r.decidedAt ? new Date(r.decidedAt).getTime() : null;
    if (decided !== null && serverNow() - decided > SENDING_FOR_MS) {
      return t(
        "documentApproval.outcome.unconfirmed",
        "No confirmation that it was sent",
      );
    }
    return t("documentApproval.outcome.sending", "On its way to the customer");
  }
  if (r.status === "REJECTED") {
    if (r.outcome === "HANDED") {
      return t(
        "documentApproval.outcome.handed",
        "Conversation handed to a person",
      );
    }
    if (r.outcome === "NOTED") {
      // The bot did not own the conversation, which says nothing about who did: a person, another
      // bot, or nobody after it was resolved.
      return t(
        "documentApproval.outcome.rejectedNotHanded",
        "Nothing sent, and the conversation was not handed over",
      );
    }
  }
  return null;
}

// The document by the name it goes by: once issued, its own number joins the title ("Orçamento
// ORC-0003"), the same heading the PDF prints and the note in Chatwoot cites.
export function approvalDocumentTitle(r: {
  title: string;
  issuedNumber?: string | null;
}): string {
  return r.issuedNumber ? `${r.title} ${r.issuedNumber}` : r.title;
}

// "Approved by Ana", "Rejected by Ana", or the bare status when nobody is named (an expiry, a
// decision made through the API with no person behind it).
export function approvalDecisionLabel(
  r: { status: string; reviewerName: string | null },
  t: TFunction,
): string {
  if (r.reviewerName && r.status === "APPROVED") {
    return t("documentApproval.approvedBy", "Approved by {{name}}", {
      name: r.reviewerName,
    });
  }
  if (r.reviewerName && r.status === "REJECTED") {
    return t("documentApproval.rejectedBy", "Rejected by {{name}}", {
      name: r.reviewerName,
    });
  }
  return approvalStatusLabel(r.status, t);
}
