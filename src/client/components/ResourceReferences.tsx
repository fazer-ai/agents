import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Badge } from "./Badge";

export interface AgentRef {
  id: string;
  name: string;
}

// Shared "which agents use this resource" list, rendered in both the Usage modal and the delete
// dialog for tools and MCP connections. `null` = still loading. Each agent deep-links to its editor's
// Tools tab (where the grant lives). Mirrors the vault RefList/RefGroup, narrowed to agents-only since
// tools/MCPs are only ever referenced from AgentToolSelection.
export function AgentReferences({ agents }: { agents: AgentRef[] | null }) {
  const { t } = useTranslation();
  if (!agents) {
    return (
      <p className="text-text-muted text-sm">
        {t("common.loading", "Loading…")}
      </p>
    );
  }
  if (agents.length === 0) {
    return (
      <p className="text-text-muted text-sm">
        {t("resources.refsEmpty", "No agents use this yet.")}
      </p>
    );
  }
  return (
    <div className="text-sm">
      <p className="text-text-secondary mb-1 text-xs font-medium uppercase">
        {t("resources.refAgents", "Agents")}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {agents.map((a) => (
          <Link key={a.id} to={`/agents/${a.id}/tools`}>
            <Badge
              variant="secondary"
              className="hover:bg-bg-hover transition-colors"
            >
              {a.name}
            </Badge>
          </Link>
        ))}
      </div>
    </div>
  );
}
