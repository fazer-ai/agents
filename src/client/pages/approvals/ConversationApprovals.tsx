import { FileClock } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Badge, Card } from "@/client/components";
import { api } from "@/client/lib/api";
import {
  APPROVAL_STATUS_VARIANT,
  approvalDecisionLabel,
  approvalOutcomeLabel,
} from "@/client/lib/approval-status";
import { serverNow } from "@/client/lib/serverClock";
import { useSendingClock } from "@/client/lib/useSendingClock";

// The documents of one conversation that went through approval, on the conversation's page
// (docs/documents.md, Approval): every request still waiting on the team, or else the latest one with
// its decision and what it came to, so a person reading the conversation knows a document is waiting,
// or on its way, before the agent says anything about it. Read again whenever the conversation's
// messages change, which is when an outcome lands.

type ListResp = Awaited<
  ReturnType<(typeof api.api.v1)["document-approvals"]["get"]>
>;
type ApprovalRow = NonNullable<ListResp["data"]>["requests"][number];

// The pending requests of one conversation are read on their own, so a run of newer decided ones can
// never push a waiting document out of the strip; the latest is read only when none waits.
const PENDING_SHOWN = 50;
const SETTLE_POLL_MS = 3000;
const SETTLE_WINDOW_MS = 2 * 60_000;

export function shownApprovals(rows: ApprovalRow[]): ApprovalRow[] {
  const pending = rows.filter((r) => r.status === "PENDING");
  if (pending.length > 0) return pending;
  return rows.slice(0, 1);
}

export function ConversationApprovals({
  conversationId,
  refreshKey,
}: {
  conversationId: string;
  refreshKey: unknown;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [tick, setTick] = useState(0);
  // Bumped when a read settles, answered or not: the next poll is armed from there, never on a clock
  // of its own, so a slow read is never cut short by the next one.
  const [reads, setReads] = useState(0);

  useEffect(() => {
    void refreshKey;
    void tick;
    let cancelled = false;
    (async () => {
      try {
        const list = api.api.v1["document-approvals"];
        const waiting = await list.get({
          query: {
            conversationId,
            status: "PENDING",
            limit: String(PENDING_SHOWN),
          },
        });
        if (cancelled || !waiting.data) return;
        if (waiting.data.requests.length > 0) {
          setRows(waiting.data.requests);
          return;
        }
        const latest = await list.get({
          query: { conversationId, limit: "1" },
        });
        if (!cancelled && latest.data) setRows(latest.data.requests);
      } catch {
        // Nothing to show is the safe reading: the conversation itself is what the page is for.
      } finally {
        if (!cancelled) setReads((n) => n + 1);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, refreshKey, tick]);

  const shown = shownApprovals(rows);
  // The outcome is recorded once the agent's turn ends, which can be after the message it sent lands:
  // a decision still on its way is read again until it says what it came to.
  const settling = shown.some(
    (r) =>
      (r.status === "APPROVED" || r.status === "REJECTED") &&
      r.outcome === null &&
      r.decidedAt !== null &&
      serverNow() - new Date(r.decidedAt).getTime() < SETTLE_WINDOW_MS,
  );
  useEffect(() => {
    // Each settled read arms the next one while the decision is still on its way.
    void reads;
    if (!settling) return;
    const timer = setTimeout(() => setTick((n) => n + 1), SETTLE_POLL_MS);
    return () => clearTimeout(timer);
  }, [settling, reads]);
  useSendingClock(shown);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {shown.map((r) => {
        const outcome = approvalOutcomeLabel(r, t);
        return (
          <Card
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-3 py-2"
          >
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <FileClock
                className="h-4 w-4 shrink-0 text-text-muted"
                aria-hidden="true"
              />
              <span className="truncate font-medium text-text-primary">
                {r.title}
              </span>
              <Badge variant={APPROVAL_STATUS_VARIANT[r.status] ?? "secondary"}>
                {approvalDecisionLabel(r, t)}
              </Badge>
              {outcome && (
                <span className="text-text-muted text-xs">{outcome}</span>
              )}
            </div>
            <Link
              to={`/document-approvals/${r.id}`}
              className="text-accent text-sm hover:underline"
            >
              {r.status === "PENDING"
                ? t("conversation.reviewApproval", "Review")
                : t("conversation.viewApproval", "View approval")}
            </Link>
          </Card>
        );
      })}
    </div>
  );
}
