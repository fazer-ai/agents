import type { TFunction } from "i18next";

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

// What happened in the conversation after the decision, or null when there is nothing to add (still
// pending, or an expiry or cancellation, whose status already says nothing was sent).
export function approvalOutcomeLabel(
  r: { status: string; outcome: string | null },
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
      return t(
        "documentApproval.outcome.rejectedNoted",
        "A person already had the conversation",
      );
    }
  }
  return null;
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
