import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import { FormField } from "@/client/components/FormField";
import { Input } from "@/client/components/Input";
import { Select } from "@/client/components/Select";
import { nativeToolMeta } from "@/client/lib/nativeTools";
import { isGuardableToolName } from "@/modules/agents/tool-preconditions";
import type { ToolPreconditionRow } from "./types";

// The enforceable half of the per-tool guidance: guidance tells the model WHEN to use a tool and is
// re-decided every turn; a precondition says when the tool MAY be used and the runtime holds it
// (issue #101). Edited as a LIST rather than as the map it is stored as, because a map keyed by the
// thing being edited loses the row the moment the operator clears the tool name to pick another.
//
// Scoped to NATIVE tools on purpose, and to the SAME set the write boundary accepts —
// `isGuardableToolName` is the one predicate, imported rather than restated, because a console that
// offers a name the API refuses and a console that hides a name the API accepts are both this
// feature failing quietly. The reasoning for where that line sits is on the predicate itself
// (modules/agents/tool-preconditions.ts); docs/graph.md carries the operator-facing half.

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

  // NOTE: A tool already claimed by ANOTHER row is not offered: two rows on one tool collapse into one
  // stored rule, so the second is a guard the operator can see and cannot save. The row's own tool is
  // always included, even if the grant was since removed — a select whose value is not among its
  // options renders BLANK, and a blank row invites the operator to delete a rule they never read.
  const optionsFor = (own: string, index: number) => {
    const claimed = new Set(
      rows.filter((_, idx) => idx !== index).map((r) => r.tool),
    );
    const names = grantedNativeTools.filter((n) => !claimed.has(n));
    return own && !names.includes(own) ? [own, ...names] : names;
  };

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
                {optionsFor(row.tool, i).map((name) => (
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
//
// `stored` is passed so entries this editor could not RENDER are carried through untouched. Without
// it, a condition on a custom tool, or of a kind added later, would be deleted by the first operator
// who saves an unrelated change on this tab — silently, from a console that never showed it.
//
// THE PROPERTY THIS HOLDS, and the one the review found three separate ways to break: saving without
// changing a row must not change what the RUNTIME accepts. Anything the runtime refuses has to come
// back out refused, and anything it accepts has to come back out identical. The matrix in
// tests/client/tool-preconditions-editor.test.ts asserts exactly that, per class of stored value.
export function serializeToolPreconditions(
  rows: ToolPreconditionRow[],
  stored?: unknown,
): Record<string, unknown> {
  // NOTE: NULL-PROTOTYPE, for the same reason the runtime map is: a tool named `__proto__` assigned onto
  // an ordinary object changes its prototype, the key never appears in the JSON, and the guard the
  // operator configured disappears on the next save.
  const out = Object.create(null) as Record<string, unknown>;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const rendered = new Set(
      parseToolPreconditionRows(stored).map((r) => r.tool),
    );
    for (const [name, raw] of Object.entries(
      stored as Record<string, unknown>,
    )) {
      if (!rendered.has(name)) out[name] = raw;
    }
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const tool = row.tool.trim();
    const key = row.key.trim();
    if (!tool || !key) continue;
    // NOTE: FIRST wins, not last. Two rows naming one tool collapse into one map key, and silently keeping
    // the last one discards a guard the operator can still see on screen. The select stops the
    // duplicate from being created; this is what happens to one that got there anyway.
    if (seen.has(tool)) continue;
    seen.add(tool);
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

// Only entries this editor can render EXACTLY, and only for tools it can OFFER. Everything else stays
// in the raw passthrough above.
//
// - An unknown kind, an unknown scope, a missing key or a non-string/blank `equals` is skipped rather
//   than coerced: parsing `scope: "moon"` as `conversation`, or dropping a blank `equals`, would let
//   the next save on this tab turn an entry the runtime IGNORES into a live rule.
// - A tool this editor has no option for (an HTTP/MCP/integration name, configured over REST) is
//   skipped too. Rendered, it would be a row with a blank selector, and the operator's only sensible
//   reaction to a blank row is to delete it — deleting a guard they never asked about.
export function parseToolPreconditionRows(
  stored: unknown,
): ToolPreconditionRow[] {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
  const rows: ToolPreconditionRow[] = [];
  for (const [tool, raw] of Object.entries(stored as Record<string, unknown>)) {
    if (!isGuardableToolName(tool)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const c = raw as Record<string, unknown>;
    if (c.kind !== "attribute") continue;
    if (c.scope !== "conversation" && c.scope !== "contact") continue;
    if (typeof c.key !== "string" || c.key.trim() === "") continue;
    if (c.equals !== undefined && c.equals !== null) {
      if (typeof c.equals !== "string" || c.equals.trim() === "") continue;
    }
    rows.push({
      tool,
      scope: c.scope,
      key: c.key,
      equals: typeof c.equals === "string" ? c.equals : "",
    });
  }
  return rows;
}
