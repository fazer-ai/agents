import { describe, expect, test } from "bun:test";
import { approvalBreadcrumb } from "@/client/lib/approval-breadcrumb";

// A conversation opened from a document approval's page offers "Back to the approval", the same way
// the agent editor offers the way back to the conversation. Only an approval page of this console is
// a way back; the page wiring is rendered in tests/client/pages/ConversationDetailApproval.test.tsx
// and tests/client/pages/DocumentApprovalPage.test.tsx.
describe("the way back from a conversation to its approval", () => {
  test("only an approval page is a way back", () => {
    expect(approvalBreadcrumb("/document-approvals/42")).toBe(
      "/document-approvals/42",
    );
    expect(approvalBreadcrumb(null)).toBeNull();
    expect(
      approvalBreadcrumb("https://evil.example/document-approvals/42"),
    ).toBeNull();
    expect(approvalBreadcrumb("//evil.example")).toBeNull();
    expect(approvalBreadcrumb("/document-approvals/42/../../admin")).toBeNull();
    expect(approvalBreadcrumb("/agents/1")).toBeNull();
  });
});
