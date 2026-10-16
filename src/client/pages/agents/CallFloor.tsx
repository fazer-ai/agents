import type { TFunction } from "i18next";
import {
  BookOpen,
  ChevronDown,
  Code2,
  FileText,
  type LucideIcon,
  Plug,
  ScrollText,
  Webhook,
  Wrench,
} from "lucide-react";
import { createContext, useContext, useState } from "react";
import { useTranslation } from "react-i18next";
import { HelpPopover } from "@/client/components/HelpPopover";
import { nativeToolMeta } from "@/client/lib/nativeTools";
import { toolpackToolMeta } from "@/client/lib/toolpackTools";
import { cn } from "@/client/lib/utils";
import { normalizeToolName } from "@/graph/tools/toolName";
import { estimateTokens } from "@/lib/token-estimate";
import type { CallFloor, CallFloorTool } from "@/modules/playground/service";

// What every model call of the agent sends before the history (docs/graph.md, History ceiling),
// shown where the operator sizes that ceiling. The server measures the tools as they stand on screen
// and what the runtime appends; the instructions are counted here, so the number moves while they type.

export type { CallFloor, CallFloorTool };

// The floor the editor loaded, for the numbers on the General, Tools and Knowledge tabs. Null until it loads, and when it
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
        // By the exposed name: an operator's row may carry a legacy spelling the build normalizes.
        tl.name === normalizeToolName(ref.name) &&
        KIND_CATEGORIES[ref.kind].includes(tl.category)
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

// The number one tool adds to every call, next to its row. Nothing when the tool is not in the floor
// (not turned on, or not reachable, like an MCP server that does not answer): an absent number never
// reads as zero.
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

// On an MCP server's or an integration's own row: what all of its turned-on tools add to every call,
// so the operator sees the source's weight without opening it. Nothing while none of them is in the
// floor, for the same reason a tool's number is absent then.
export function SourceTokens({
  source,
}: {
  source: { mcp: string } | { integration: string };
}) {
  const { t, i18n } = useTranslation();
  const floor = useContext(CallFloorContext);
  if (floor?.engine !== "llm") return null;
  const tools = floor.tools.filter((tl) =>
    "mcp" in source
      ? tl.mcp?.connectionId === source.mcp
      : tl.integrationInstanceId === source.integration,
  );
  if (tools.length === 0) return null;
  const n = tools.reduce((sum, tl) => sum + tl.estimatedTokens, 0);
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-text-muted text-xs">
      {t("editor.callFloor.sourceTotal", "{{n}} tokens per call in total", {
        n: fmt(n, i18n.language),
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
  // The Knowledge tab grants these by switch, with no row of their own; named after what they do.
  if (tl.name === "search_knowledge")
    return t("editor.callFloor.knowledgeSearch", "Knowledge search");
  if (tl.name === "suggest_kb_entry")
    return t(
      "editor.callFloor.knowledgeSuggest",
      "Knowledge entry suggestions",
    );
  return tl.name;
}

// Under the instructions as they are typed: what they cost on every call, and what the system appends
// to them. Nothing for a decisions engine (it sends no instructions) or before the floor loads.
export function InstructionsTokens({ draftPrompt }: { draftPrompt: string }) {
  const { t, i18n } = useTranslation();
  const floor = useContext(CallFloorContext);
  if (floor?.engine !== "llm") return null;
  const n = fmt(estimateTokens(draftPrompt), i18n.language);
  return (
    <p className="mt-1 text-text-muted text-xs">
      {floor.instructionsAdded > 0
        ? t(
            "editor.callFloor.instructionsLineAdded",
            "These instructions add {{n}} tokens to every call, and the system appends {{added}} more (knowledge rules, MCP servers).",
            { n, added: fmt(floor.instructionsAdded, i18n.language) },
          )
        : t(
            "editor.callFloor.instructionsLine",
            "These instructions add {{n}} tokens to every call.",
            { n },
          )}
    </p>
  );
}

// Next to a Knowledge tab switch: what turning it on costs every call, saved or not. The search switch
// brings the search tool and the grounding rules the runtime appends; the suggest switch its tool.
export function KnowledgeTokens({ part }: { part: "search" | "suggest" }) {
  const { t, i18n } = useTranslation();
  const floor = useContext(CallFloorContext);
  if (floor?.engine !== "llm") return null;
  const tool = floor.tools.find(
    (tl) =>
      tl.name === (part === "search" ? "search_knowledge" : "suggest_kb_entry"),
  );
  if (!tool) return null;
  const n =
    tool.estimatedTokens +
    (part === "search" ? floor.instructionsAddedBy.grounding : 0);
  return (
    <span className="font-mono text-text-muted text-xs">
      {part === "search"
        ? t(
            "editor.callFloor.searchTokens",
            "{{n}} tokens per call, the search and the rules it adds to the instructions",
            { n: fmt(n, i18n.language) },
          )
        : t("editor.callFloor.tokens", "{{n}} tokens per call", {
            n: fmt(n, i18n.language),
          })}
    </span>
  );
}

// The icon the tool's row carries on the Tools tab (or the Knowledge tab, for the two it grants), so a
// line of the breakdown and its row are recognisably the same thing.
function toolIcon(tl: CallFloorTool, t: TFunction): LucideIcon {
  if (tl.category === "native" || tl.category === "utility")
    return nativeToolMeta(tl.name, t).icon;
  if (tl.category === "integration") return toolpackToolMeta(tl.name, t).icon;
  if (tl.category === "http") return Webhook;
  if (tl.category === "code") return Code2;
  if (tl.category === "mcp") return Plug;
  if (tl.category === "knowledge") return BookOpen;
  if (tl.templateId) return FileText;
  return Wrench;
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
  const rows: {
    key: string;
    icon: LucideIcon;
    label: string;
    note?: string;
    n: number;
  }[] = [
    {
      key: "instructions",
      icon: ScrollText,
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
      icon: toolIcon(tl, t),
      label: toolLabel(tl, t),
      n: tl.estimatedTokens,
    })),
  ];
  // Each line as its share of the whole call: the bar's full width is the call, and the percent says
  // so, where a bar scaled to the largest line had no unit a reader could name.
  const share = (n: number) => Math.round((n / Math.max(1, total)) * 100);
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
            "An estimate: the count your provider bills can be higher, more so with many tools.\n\nIt is the floor of a call. Each conversation adds its history and what belongs to it, none of which is counted here: contact and conversation attributes and contact fields, appointments, the authorization check and context from other inboxes, the label and handoff vocabulary the built-in tools' descriptions gain in a conversation, and the notices of each turn. Tools and instructions count as they are on screen, before you save.",
          )}
        />
      </div>
      {open && (
        // Number first, in a column of its own, so the eye reads value and name together; a bar per
        // line shows its share of the call and uses the width a wide screen has.
        <ul className="flex flex-col gap-1.5 rounded-md border border-border bg-bg-secondary p-2">
          {rows.map((r) => (
            <li
              key={r.key}
              className="grid grid-cols-[3.25rem_minmax(0,1fr)_2.5rem] items-start gap-x-2 sm:grid-cols-[3.25rem_minmax(0,16rem)_minmax(0,1fr)_2.5rem]"
            >
              <span className="text-right font-mono text-text-muted">
                {fmt(r.n, i18n.language)}
              </span>
              <span className="flex min-w-0 items-start gap-1.5">
                <r.icon
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted"
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-col break-words text-text-secondary">
                  {r.label}
                  {r.note && <span className="text-text-muted">{r.note}</span>}
                </span>
              </span>
              <span
                className="hidden h-4 items-center sm:flex"
                aria-hidden="true"
              >
                <span className="h-1.5 w-full overflow-hidden rounded bg-bg-tertiary">
                  <span
                    className="block h-full bg-text-muted"
                    style={{ width: `${share(r.n)}%` }}
                  />
                </span>
              </span>
              <span className="text-right font-mono text-text-muted">
                {`${share(r.n)}%`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
