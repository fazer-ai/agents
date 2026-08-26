import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import { FormField } from "@/client/components/FormField";
import { Input } from "@/client/components/Input";
import { Select } from "@/client/components/Select";
import { nativeToolMeta } from "@/client/lib/nativeTools";
import type { ToolPreconditionRow } from "./types";

// The enforceable half of the per-tool guidance: guidance tells the model WHEN to use a tool and is
// re-decided every turn; a precondition says when the tool MAY be used and the runtime holds it
// (issue #101). Edited as a LIST rather than as the map it is stored as, because a map keyed by the
// thing being edited loses the row the moment the operator clears the tool name to pick another.
//
// Scoped to NATIVE tools on purpose. The runtime applies a precondition to any tool by name, but the
// names of HTTP/MCP/integration tools are defined elsewhere and namespaced at assembly, so a picker
// here would be offering names that may not be the ones the turn uses — and a precondition whose
// name does not match is silently no protection at all, which is the one failure this feature must
// not have. Those are configurable over REST, whose settings bag is open-ended; docs/graph.md
// carries the boundary and why it is where it is.
interface Props {
  rows: ToolPreconditionRow[];
  onChange: (rows: ToolPreconditionRow[]) => void;
  // Native tools this agent actually has. A precondition on a tool the agent was not granted is
  // inert, so it is not offered.
  grantedNativeTools: string[];
}

export function ToolPreconditionsEditor({
  rows,
  onChange,
  grantedNativeTools,
}: Props) {
  const { t } = useTranslation();
  const patch = (i: number, next: Partial<ToolPreconditionRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...next } : r)));

  return (
    <div className="flex flex-col gap-3" id="tools-preconditions">
      <FormField
        group
        label={
          <span className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-text-muted" aria-hidden />
            {t("editor.toolPreconditions.title", "Tool preconditions")}
          </span>
        }
        description={t(
          "editor.toolPreconditions.description",
          "Block a tool until a conversation or contact attribute holds a value. The agent is told why and continues the conversation; nothing is said to the customer.",
        )}
      >
        <div className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and reorderable only by add/remove; no stable id exists until saved.
              key={i}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-secondary p-2"
            >
              <Select
                aria-label={t("editor.toolPreconditions.tool", "Tool")}
                value={row.tool}
                onChange={(e) => patch(i, { tool: e.target.value })}
                wrapperClassName="min-w-48 flex-1"
              >
                <option value="">
                  {t("editor.toolPreconditions.pickTool", "Pick a tool…")}
                </option>
                {grantedNativeTools.map((name) => (
                  <option key={name} value={name}>
                    {nativeToolMeta(name, t).label}
                  </option>
                ))}
              </Select>
              <Select
                aria-label={t("editor.toolPreconditions.scope", "Scope")}
                value={row.scope}
                onChange={(e) =>
                  patch(i, {
                    scope:
                      e.target.value === "contact" ? "contact" : "conversation",
                  })
                }
                wrapperClassName="min-w-40"
              >
                <option value="conversation">
                  {t("editor.toolPreconditions.conversation", "Conversation")}
                </option>
                <option value="contact">
                  {t("editor.toolPreconditions.contact", "Contact")}
                </option>
              </Select>
              <Input
                aria-label={t("editor.toolPreconditions.key", "Attribute")}
                value={row.key}
                onChange={(e) => patch(i, { key: e.target.value })}
                placeholder={t(
                  "editor.toolPreconditions.keyPlaceholder",
                  "attribute key",
                )}
                className="min-w-40 flex-1"
              />
              <Input
                aria-label={t(
                  "editor.toolPreconditions.equals",
                  "Required value",
                )}
                value={row.equals}
                onChange={(e) => patch(i, { equals: e.target.value })}
                placeholder={t(
                  "editor.toolPreconditions.equalsPlaceholder",
                  "any value",
                )}
                className="min-w-32 flex-1"
              />
              <Button
                variant="secondary"
                size="sm"
                aria-label={t("common.remove", "Remove")}
                onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                onChange([
                  ...rows,
                  { tool: "", scope: "conversation", key: "", equals: "" },
                ])
              }
            >
              <Plus className="h-4 w-4" aria-hidden />
              {t("editor.toolPreconditions.add", "Add a precondition")}
            </Button>
          </div>
        </div>
      </FormField>
    </div>
  );
}

// The stored shape: a map keyed by tool name. Rows with no tool or no attribute key are DROPPED
// rather than saved half-written — an incomplete rule would be refused by the write boundary, and
// refusing the whole save because a row was left blank punishes the wrong edit.
export function serializeToolPreconditions(
  rows: ToolPreconditionRow[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const tool = row.tool.trim();
    const key = row.key.trim();
    if (!tool || !key) continue;
    const equals = row.equals.trim();
    out[tool] = {
      kind: "attribute",
      scope: row.scope,
      key,
      ...(equals ? { equals } : {}),
    };
  }
  return out;
}

export function parseToolPreconditionRows(
  stored: unknown,
): ToolPreconditionRow[] {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
  const rows: ToolPreconditionRow[] = [];
  for (const [tool, raw] of Object.entries(stored as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const c = raw as Record<string, unknown>;
    if (c.kind !== "attribute") continue;
    rows.push({
      tool,
      scope: c.scope === "contact" ? "contact" : "conversation",
      key: typeof c.key === "string" ? c.key : "",
      equals: typeof c.equals === "string" ? c.equals : "",
    });
  }
  return rows;
}
