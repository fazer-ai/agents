import { useEffect, useState } from "react";
import { SENDING_FOR_MS } from "@/client/lib/approval-status";
import { serverNow } from "@/client/lib/serverClock";

// Renders once more when the earliest "on its way" label among these requests runs out
// (approvalOutcomeLabel), so a view nobody touches stops claiming it, whatever its own polling does.
export function useSendingClock(
  rows: readonly {
    status: string;
    outcome: string | null;
    decidedAt?: Date | string | null;
  }[],
): void {
  const [, setClock] = useState(0);
  const now = serverNow();
  let next: number | null = null;
  for (const r of rows) {
    if (r.status !== "APPROVED" || r.outcome !== null || !r.decidedAt) continue;
    const until = new Date(r.decidedAt).getTime() + SENDING_FOR_MS;
    if (until > now && (next === null || until < next)) next = until;
  }
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(
      () => setClock((n) => n + 1),
      next - serverNow() + 1000,
    );
    return () => clearTimeout(timer);
  }, [next]);
}
