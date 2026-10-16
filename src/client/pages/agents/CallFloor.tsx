import type { TFunction } from "i18next";
import { ChevronDown } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpPopover } from "@/client/components/HelpPopover";
import { nativeToolMeta } from "@/client/lib/nativeTools";
import { toolpackToolMeta } from "@/client/lib/toolpackTools";
import { cn } from "@/client/lib/utils";
import { estimateTokens } from "@/lib/token-estimate";
import type { CallFloor, CallFloorTool } from "@/modules/playground/service";

// What every model call of the agent sends before the history (docs/graph.md, History ceiling),
// shown where the operator sizes that ceiling. The server measures the SAVED tools and what the runtime
// appends; the instructions are counted here, from the draft, so the number moves while they type.

export type { CallFloor, CallFloorTool };

// The floor the editor loaded, for the Tools tab's per-tool numbers. Null until it loads, and when it
// cannot: a tool with no number is the safe reading of "not measured".
export const CallFloorContext = createContext<CallFloor | null>(null);

// "~" on every number: none of them is a count, and the hint says by how much they can miss.
const fmt = (n: number, lang: string) => `~${n.toLocaleString(lang)}`;

// Which tool of the floor a row of the Tools tab is. By the model's name for every kind whose row knows
// it; an MCP or document row knows its grant instead, since that name is derived on the server.
export type ToolRef =
  // A native, HTTP or code row: the name plus the kind of row, since an operator's tool can share a
  // name with a pack's, and only one of the two is offered.
  | { name: string; kind: "native" | "http" | "code" }
  | { mcp: { connectionId: string; tool: string } }
  | { templateId: string }
  | { integration: { instanceId: string; tool: string } };

const KIND_CATEGORIES: Record<
  "native" | "http" | "code",
  readonly CallFloorTool["category"][]
> = {
  native: ["native", "utility"],
  http: ["http"],
  code: ["code"],
};

function findTool(
  floor: CallFloor | null,
  ref: ToolRef,
): CallFloorTool | undefined {
  if (floor?.engine !== "llm") return undefined;
  return floor.tools.find((tl) => {
    if ("name" in ref)
      return (
        tl.name === ref.name && KIND_CATEGORIES[ref.kind].includes(tl.category)
      );
    if ("templateId" in ref) return tl.templateId === ref.templateId;
    if ("integration" in ref)
      return (
        tl.integrationInstanceId === ref.integration.instanceId &&
        tl.name === ref.integration.tool
      );
    return (
      tl.mcp?.connectionId === ref.mcp.connectionId &&
      tl.mcp.tool === ref.mcp.tool
    );
  });
}

// The number one tool adds to every call, next to its row. Nothing when the tool is not in the saved
// floor (not granted yet, or granted and not saved): an absent number never reads as zero.
export function ToolTokens({ tool }: { tool: ToolRef }) {
  const { t, i18n } = useTranslation();
  const floor = useContext(CallFloorContext);
  const found = findTool(floor, tool);
  if (!found) return null;
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-text-muted text-xs">
      {t("editor.callFloor.tokens", "{{n}} tokens per call", {
        n: fmt(found.estimatedTokens, i18n.language),
      })}
    </span>
  );
}

// The name the Tools tab shows for a tool: the operator's own for HTTP, code and documents, the
// console's catalog for natives and packs, the server's for MCP (that row shows it too).
function toolLabel(tl: CallFloorTool, t: TFunction): string {
  if (tl.label) return tl.label;
  if (tl.mcp) return tl.mcp.tool;
  if (tl.category === "native" || tl.category === "utility")
    return nativeToolMeta(tl.name, t).label;
  if (tl.category === "integration") return toolpackToolMeta(tl.name, t).label;
  return tl.name;
}

export function CallFloorLine({
  floor,
  draftPrompt,
}: {
  floor: CallFloor | null;
  draftPrompt: string;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  if (!floor) return null;
  if (floor.engine === "decisions") {
    return (
      <p className="mt-2 text-text-muted text-xs">
        {t(
          "editor.callFloor.decisions",
          "Instructions and tools do not apply: this agent decides with questions and rules, and sends no instructions to a model.",
        )}
      </p>
    );
  }
  const instructions = estimateTokens(draftPrompt);
  const tools = floor.tools.reduce((s, tl) => s + tl.estimatedTokens, 0);
  const total = instructions + floor.instructionsAdded + tools;
  // As the model receives them: what the operator typed plus what the runtime appends, one entry,
  // with a note saying how much of it is the system's.
  const rows: { key: string; label: string; note?: string; n: number }[] = [
    {
      key: "instructions",
      label: t("editor.callFloor.instructions", "Agent instructions"),
      ...(floor.instructionsAdded > 0
        ? {
            note: t(
              "editor.callFloor.added",
              "includes {{n}} the system adds (knowledge rules, MCP servers)",
              { n: fmt(floor.instructionsAdded, i18n.language) },
            ),
          }
        : {}),
      n: instructions + floor.instructionsAdded,
    },
    ...floor.tools.map((tl) => ({
      key: `tool:${tl.name}`,
      label: toolLabel(tl, t),
      n: tl.estimatedTokens,
    })),
  ];
  return (
    <div className="mt-2 flex flex-col gap-2 text-xs">
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 items-start gap-1 text-left text-text-secondary hover:text-text-primary"
        >
          <ChevronDown
            className={cn(
              "mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
          <span>
            {t(
              "editor.callFloor.line",
              "Every call already sends {{n}} tokens before the history",
              { n: fmt(total, i18n.language) },
            )}
          </span>
        </button>
        <HelpPopover
          label={t("editor.callFloor.helpLabel", "About this estimate")}
          content={t(
            "editor.callFloor.help",
            "An estimate: the count your provider bills can be higher, more so with many tools.\n\nIt is the floor of a call. Each conversation adds its history and what belongs to it, none of which is counted here: contact and conversation attributes and contact fields, appointments, the authorization check and context from other inboxes, the label and handoff vocabulary the built-in tools' descriptions gain in a conversation, and the notices of each turn. Tools count as they are saved; instructions count as you type them.",
          )}
        />
      </div>
      {open && (
        <ul className="flex flex-col gap-1 rounded-md border border-border bg-bg-secondary p-2">
          {rows.map((r) => (
            <li key={r.key} className="flex items-baseline gap-2">
              <span className="flex min-w-0 flex-1 flex-col break-words text-text-secondary">
                {r.label}
                {r.note && <span className="text-text-muted">{r.note}</span>}
              </span>
              <span className="shrink-0 font-mono text-text-muted">
                {fmt(r.n, i18n.language)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
