// The way back from a conversation to the document approval page it was opened from
// (`?from=/document-approvals/:id`). Only that internal path is accepted, so the parameter can never
// become an open redirect.
const APPROVAL_PAGE = /^\/document-approvals\/\d+$/;

export function approvalBreadcrumb(from: string | null): string | null {
  return from && APPROVAL_PAGE.test(from) ? from : null;
}
