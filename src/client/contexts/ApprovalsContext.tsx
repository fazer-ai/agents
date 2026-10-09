import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useLocation } from "react-router";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { isAdminRole } from "@/client/lib/roles";

interface ApprovalsContextValue {
  // Everything waiting on this person: the document approvals (any role) plus, for an admin, the
  // pending knowledge-base suggestions. What the sidebar badge shows.
  count: number;
  // Pending knowledge-base suggestions (0 when none, or not an admin). The Knowledge tab's badge.
  knowledgeCount: number;
  // Document approval requests waiting on the team (pending and not past their validity).
  documentCount: number;
  // Lets the knowledge queue, which already knows its fresh count after an approve or a reject,
  // update the shared badge without a refetch.
  setKnowledgeCount: (count: number) => void;
  // Re-fetch both counts on demand.
  refresh: () => void;
}

const ApprovalsContext = createContext<ApprovalsContextValue>({
  count: 0,
  knowledgeCount: 0,
  documentCount: 0,
  setKnowledgeCount: () => {},
  refresh: () => {},
});

// Shared source for the approvals badge, mounted high enough to survive route changes so the sidebar
// badge persists across navigation (each route element wraps in its own ProtectedRoute, so a provider
// nested there would remount and flicker on every navigation). Knowledge suggestions are fetched only
// for admins (the only role that can review them); document approvals for every role, since any user
// of the tenant decides one. Refreshed on each navigation, since both arrive server-side from agent
// turns with no realtime event.
export function ApprovalsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const isAdmin = isAdminRole(user?.role);
  const signedIn = !!user;
  const [knowledgeCount, setKnowledgeCount] = useState(0);
  const [documentCount, setDocumentCount] = useState(0);
  const location = useLocation();

  const refresh = useCallback(() => {
    if (!signedIn) {
      setKnowledgeCount(0);
      setDocumentCount(0);
      return;
    }
    api.api.v1["document-approvals"].pending
      .get()
      .then(({ data }) => {
        if (data) setDocumentCount(data.requests.length);
      })
      .catch(() => {});
    if (!isAdmin) {
      setKnowledgeCount(0);
      return;
    }
    api.api.v1.knowledge.approvals
      .get()
      .then(({ data }) => {
        if (data) setKnowledgeCount(data.approvals.length);
      })
      .catch(() => {});
  }, [isAdmin, signedIn]);

  // Refetch on mount, when the principal changes, and on each navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.pathname is an intentional trigger — re-fetch the counts whenever the user navigates (approvals arrive server-side with no realtime event).
  useEffect(() => {
    refresh();
  }, [refresh, location.pathname]);

  return (
    <ApprovalsContext.Provider
      value={{
        count: knowledgeCount + documentCount,
        knowledgeCount,
        documentCount,
        setKnowledgeCount,
        refresh,
      }}
    >
      {children}
    </ApprovalsContext.Provider>
  );
}

export function usePendingApprovals() {
  return useContext(ApprovalsContext);
}
