import { useTranslation } from "react-i18next";
import { Tooltip } from "@/client/components";

// A tool argument projected for display: name + whether it's required, plus an optional type and
// description. Shared by MCP tools (which carry a JSON-schema type) and toolpack tools (zod-derived,
// no type). Keeping one shape lets the same pill renderer serve both.
export interface DisplayToolArg {
  name: string;
  required: boolean;
  // null (MCP, Eden-serialized) and undefined (toolpack, zod-derived) both mean "absent".
  type?: string | null;
  description?: string | null;
}

// One argument as a discrete pill (border + tint + mono), so a row of args reads as separated tokens
// rather than a run-on string. With a description, the pill becomes a Tooltip trigger.
function ArgPill({ arg }: { arg: DisplayToolArg }) {
  const pill = (
    <span className="border-border bg-bg-tertiary text-text-secondary inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-xs">
      {arg.name}
      {arg.required && <span className="text-warning">*</span>}
      {arg.type && <span className="text-text-muted">{`: ${arg.type}`}</span>}
    </span>
  );
  return arg.description ? (
    <Tooltip content={arg.description}>{pill}</Tooltip>
  ) : (
    pill
  );
}

// A tool's arguments as discrete pill tokens with the per-arg description on hover. Used by the MCP
// tool cards, the Components → Discover modal, and the integration (toolpack) modal + Tools tab.
export function ToolArgPills({ args }: { args: DisplayToolArg[] }) {
  const { t } = useTranslation();
  if (args.length === 0) {
    return (
      <span className="text-text-muted text-xs">
        {t("mcp.toolNoArgs", "No arguments")}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      {args.map((a) => (
        <ArgPill key={a.name} arg={a} />
      ))}
    </span>
  );
}
