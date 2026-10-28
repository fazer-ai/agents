import { useTranslation } from "react-i18next";
import { ToolArgPills } from "@/client/components";
import type { api } from "@/client/lib/api";

// Derived from the discover treaty response; never hand-mirrored (see docs/eden-treaty.md).
export type DiscoveredMcpTool = NonNullable<
  Awaited<
    ReturnType<
      ReturnType<(typeof api.api.v1)["mcp-connections"]>["discover"]["post"]
    >
  >["data"]
>["tools"][number];

// The server's own MCP `instructions` (initialize result) — its scope/usage hint. Rendered for the
// operator wherever a server's tools are shown (Components discover modal + the agent's Tools tab) so
// they understand what the server operates on. Renders nothing when the server advertises none.
export function McpServerInstructions({
  instructions,
}: {
  instructions: string | null | undefined;
}) {
  const { t } = useTranslation();
  if (!instructions) return null;
  return (
    <div className="border-border bg-bg-tertiary flex flex-col gap-1 rounded-lg border p-3">
      <span className="text-text-secondary text-xs font-medium">
        {t("mcp.serverContext", "Server context (provided by the server)")}
      </span>
      <p className="text-text-muted text-xs whitespace-pre-wrap">
        {instructions}
      </p>
    </div>
  );
}

// The arguments an MCP tool accepts, rendered as discrete pill tokens with the per-arg description on
// hover (delegated to the shared ToolArgPills, also used by the integration toolpack UI).
export function McpToolArgs({ args }: { args: DiscoveredMcpTool["args"] }) {
  return <ToolArgPills args={args} />;
}
