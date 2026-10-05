import { MessageSquareOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { DataBoundary, EmptyState, PageContainer } from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { SWITCH_TENANT_PARAM } from "@/lib/console-params";

type Match = { id: string; tenantId: string };

// The page a Chatwoot conversation links to (`/chatwoot/accounts/:accountId/conversations/:conversationId`,
// `?inbox=` optional): finds the conversation among the tenants the person can open and goes to it.
// The destination always names its tenant through `switchTenant`, and `TenantDeepLink` decides
// whether that is a switch: it compares against the selector the requests actually carry and waits
// for the membership list a fresh login has not brought yet, which this page cannot know.
export function conversationHref(match: Match) {
  return `/conversations/${match.id}?${SWITCH_TENANT_PARAM}=${match.tenantId}`;
}

export function ChatwootConversationLinkPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { accountId = "", conversationId = "" } = useParams();
  const [searchParams] = useSearchParams();
  const inboxId = searchParams.get("inbox") ?? undefined;
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } = await api.api.v1.conversations[
        "chatwoot-link"
      ].get({
        query: {
          accountId,
          conversationId,
          ...(inboxId !== undefined ? { inboxId } : {}),
        },
      });
      // A link nobody could have produced (a non-numeric id) is the same answer as one that names no
      // conversation: there is nothing to open.
      if (err?.status === 400) {
        setMatches([]);
        return;
      }
      if (err || !data) {
        setError(true);
        return;
      }
      setMatches(data.matches);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [accountId, conversationId, inboxId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (matches?.length === 1) {
    return <Navigate to={conversationHref(matches[0] as Match)} replace />;
  }

  const tenantName = (id: string) =>
    user?.tenants?.find((m) => m.id === id)?.name ?? id;

  return (
    <PageContainer>
      <DataBoundary
        loading={loading}
        error={error}
        onRetry={load}
        errorLabel={t(
          "chatwootLink.error",
          "Could not look up this Chatwoot conversation.",
        )}
      >
        {matches && matches.length === 0 && (
          <EmptyState
            icon={MessageSquareOff}
            title={t(
              "chatwootLink.notFoundTitle",
              "This conversation is not here",
            )}
            description={t(
              "chatwootLink.notFound",
              "fazer.ai agents has no record of conversation {{conversationId}} of Chatwoot account {{accountId}} in the organizations you can open. A conversation is recorded the first time Chatwoot tells the inbox's agent bot about it (a message, a status change), so conversations from before the inbox was connected are not here.",
              { conversationId, accountId },
            )}
            action={
              <Link to="/conversations" className="text-accent text-sm">
                {t("chatwootLink.toList", "Go to conversations")}
              </Link>
            }
          />
        )}
        {matches && matches.length > 1 && (
          <div className="flex flex-col gap-3">
            <h1 className="font-semibold text-lg text-text-primary">
              {t(
                "chatwootLink.chooseTitle",
                "More than one conversation matches",
              )}
            </h1>
            <p className="text-sm text-text-secondary">
              {t(
                "chatwootLink.choose",
                "Two connected Chatwoot servers use account {{accountId}}. Open the one you meant:",
                { accountId },
              )}
            </p>
            <ul className="flex flex-col gap-2">
              {matches.map((m) => (
                <li key={`${m.tenantId}-${m.id}`}>
                  <Link
                    to={conversationHref(m)}
                    className="text-accent text-sm"
                  >
                    {t(
                      "chatwootLink.option",
                      "Conversation {{id}} in {{tenant}}",
                      { id: m.id, tenant: tenantName(m.tenantId) },
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DataBoundary>
    </PageContainer>
  );
}
