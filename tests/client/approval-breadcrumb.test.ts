import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { approvalBreadcrumb } from "@/client/lib/approval-breadcrumb";

// A conversation opened from a document approval's page offers "Back to the approval", the same way
// the agent editor offers the way back to the conversation. The page wiring is checked on the
// source, for the reason `conversation-reengage-rank.test.ts` gives about this file.
const CONVERSATION = readFileSync(
  "src/client/pages/ConversationDetailPage.tsx",
  "utf8",
);
const APPROVAL = readFileSync(
  "src/client/pages/DocumentApprovalPage.tsx",
  "utf8",
);

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

  test("the approval page opens the conversation with itself as the origin", () => {
    // Built from parts: the expected text is source with `${…}` in it, not a template to fill.
    const open = [
      "`/conversations/$",
      "{context.conversation.id}?from=/document-approvals/$",
      "{id}`",
    ];
    expect(APPROVAL).toContain(`to={${open.join("")}}`);
  });

  test("the way back to the approval shares the row of the way back to the conversations", () => {
    const row = CONVERSATION.indexOf(
      '<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">',
    );
    const list = CONVERSATION.indexOf(
      't("conversation.back", "Back to conversations")',
    );
    const approval = CONVERSATION.indexOf('t("conversation.backToApproval"');
    const close = CONVERSATION.indexOf("</div>", approval);
    expect(row).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(row);
    expect(approval).toBeGreaterThan(list);
    // Nothing closes the row between the two links.
    expect(CONVERSATION.slice(row, approval)).not.toContain("</div>");
    expect(close).toBeGreaterThan(approval);
  });

  test("a private note renders its Markdown, so the approval link is a link", () => {
    const note = CONVERSATION.indexOf(
      't("conversation.privateNote", "Private note")',
    );
    const end = CONVERSATION.indexOf("return (", note);
    const body = CONVERSATION.slice(note, end);
    expect(body).toContain("<Markdown");
    expect(body).toContain("{m.content");
  });

  test("the conversation page shows the conversation's approvals", () => {
    expect(CONVERSATION).toContain("<ConversationApprovals");
    expect(CONVERSATION).toContain("conversationId={id}");
  });

  test("the conversation page reads the origin and offers the way back", () => {
    expect(CONVERSATION).toContain(
      'const backToApproval = approvalBreadcrumb(searchParams.get("from"));',
    );
    const at = CONVERSATION.indexOf('t("conversation.backToApproval"');
    expect(at).toBeGreaterThan(-1);
    expect(
      CONVERSATION.lastIndexOf("{backToApproval && (", at),
    ).toBeGreaterThan(-1);
  });
});
