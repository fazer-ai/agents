import { AlertTriangle, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import { FormField } from "@/client/components/FormField";
import { Input } from "@/client/components/Input";
import { Select } from "@/client/components/Select";
import { api } from "@/client/lib/api";
import { nativeToolMeta } from "@/client/lib/nativeTools";
import { isGuardableToolName } from "@/modules/agents/tool-preconditions";
import { SCOPE_MODEL } from "@/modules/chatwoot/attributes";
import type { GuardableTool } from "./guardableTools";
import type { ToolPreconditionRow } from "./types";

// The enforceable half of the per-tool guidance: guidance tells the model WHEN to use a tool; a
// precondition says when the tool MAY be used, and the runtime holds it. Edited as a LIST rather than
// the stored map, so a row survives the operator clearing its tool name to pick another. Rows are read
// back through `isGuardableToolName`, the write boundary's own predicate, so the console never shows a
// name the API refuses or hides one it accepts. A row whose tool the agent does not have is shown with
// a warning: it guards nothing, and on screen it would otherwise read as protection.

interface Props {
  agentId: string;
  rows: ToolPreconditionRow[];
  onChange: (rows: ToolPreconditionRow[]) => void;
  // Every tool this agent is granted, from any source. A precondition on a tool the agent was not
  // granted is inert, so it is not offered.
  guardableTools: GuardableTool[];
  // Every name the turn may build, wider than what is offered (assembledToolNames). A saved row
  // outside it is the one flagged, since its rule guards nothing.
  assembledTools: { has(name: string): boolean };
  // Questions and rules: a refused tool is a rule's action that does not run, and no model is told.
  decides?: boolean;
}

const KIND_ORDER: GuardableTool["kind"][] = [
  "native",
  "http",
  "code",
  "mcp",
  "toolpack",
  "rag",
  "document",
];

type AttributeDef = { key: string; displayName: string; model: string };

export const matchOf = (row: ToolPreconditionRow): "any" | "equals" =>
  row.match ?? (row.equals.trim() ? "equals" : "any");

export function ToolPreconditionsEditor({
  agentId,
  rows,
  onChange,
  guardableTools,
  assembledTools,
  decides = false,
}: Props) {
  const { t } = useTranslation();
  const patch = (i: number, next: Partial<ToolPreconditionRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...next } : r)));

  // The account's attribute definitions, offered as suggestions. A typed key is still accepted: the
  // listing is empty when Chatwoot is unreachable, and an attribute created later is not in it.
  const [defs, setDefs] = useState<AttributeDef[]>([]);
  useEffect(() => {
    let cancelled = false;
    setDefs([]);
    void (async () => {
      try {
        const { data } = await api.api.v1.chatwoot["custom-attributes"]({
          agentId,
        }).get();
        if (!cancelled && Array.isArray(data?.attributes))
          setDefs(data.attributes);
      } catch {
        // NOTE: best-effort, the field still takes a typed key
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const kindLabel: Record<GuardableTool["kind"], string> = {
    native: t("editor.toolPreconditions.groupNative", "Native tools"),
    http: t("editor.toolPreconditions.groupHttp", "HTTP tools"),
    code: t("editor.toolPreconditions.groupCode", "Code tools"),
    mcp: t("editor.toolPreconditions.groupMcp", "MCP servers"),
    toolpack: t("editor.toolPreconditions.groupToolpack", "Integrations"),
    rag: t("editor.toolPreconditions.groupRag", "Knowledge base"),
    document: t("editor.toolPreconditions.groupDocument", "Documents"),
  };

  // A tool already claimed by ANOTHER row is not offered: two rows on one tool collapse into one
  // stored rule, so the second is a guard the operator can see and cannot save. The row's own tool is
  // always shown (the row adds it when no group holds it) — a select whose value is not among its
  // options renders BLANK, and a blank row invites the operator to delete a rule they never read.
  const optionsFor = (index: number) => {
    const claimed = new Set(
      rows.filter((_, idx) => idx !== index).map((r) => r.tool),
    );
    return guardableTools.filter((g) => !claimed.has(g.name));
  };
  const byName = new Map(guardableTools.map((g) => [g.name, g]));
  // A custom tool's own label, else the native's (a saved rule on a native the select no longer offers
  // keeps its name readable); `nativeToolMeta` returns any other name as is.
  const labelOf = (name: string) =>
    byName.get(name)?.label ?? nativeToolMeta(name, t).label;

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
        description={
          decides
            ? t(
                "editor.toolPreconditions.descriptionDecisions",
                "Block a tool until a conversation or contact attribute holds a value. The rule's action does not run and the refusal is recorded in the logs; nothing is said to the customer.",
              )
            : t(
                "editor.toolPreconditions.description",
                "Block a tool until a conversation or contact attribute holds a value. The agent is told why and continues the conversation; nothing is said to the customer.",
              )
        }
      >
        <div className="flex flex-col gap-2">
          {rows.length === 0 && (
            <p className="text-sm text-text-muted">
              {t(
                "editor.toolPreconditions.empty",
                "No preconditions. Without one, the agent may use any of its tools whenever it sees fit.",
              )}
            </p>
          )}
          {rows.map((row, i) => {
            const options = optionsFor(i);
            const stale = row.tool && !byName.has(row.tool);
            const match = matchOf(row);
            const listId = `tool-precondition-keys-${i}`;
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and reorderable only by add/remove; no stable id exists until saved.
                key={i}
                className="flex flex-col gap-2 rounded-lg border border-border bg-bg-secondary p-3 text-sm text-text-secondary"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span>{t("editor.toolPreconditions.block", "Block")}</span>
                  <div className="min-w-0 flex-1 sm:w-80 sm:flex-none">
                    <Select
                      aria-label={t("editor.toolPreconditions.tool", "Tool")}
                      value={row.tool}
                      onChange={(e) => patch(i, { tool: e.target.value })}
                    >
                      <option value="">
                        {t("editor.toolPreconditions.pickTool", "Pick a tool…")}
                      </option>
                      {stale && (
                        <option value={row.tool}>{labelOf(row.tool)}</option>
                      )}
                      {KIND_ORDER.map((kind) => {
                        const group = options.filter((g) => g.kind === kind);
                        if (group.length === 0) return null;
                        return (
                          <optgroup key={kind} label={kindLabel[kind]}>
                            {group.map((g) => (
                              <option key={g.name} value={g.name}>
                                {labelOf(g.name)}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </Select>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="ml-auto"
                    aria-label={t("common.remove", "Remove")}
                    onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    {t(
                      "editor.toolPreconditions.untilAttribute",
                      "until the attribute",
                    )}
                  </span>
                  <div className="w-full sm:w-44">
                    <Input
                      aria-label={t(
                        "editor.toolPreconditions.key",
                        "Attribute",
                      )}
                      value={row.key}
                      onChange={(e) => patch(i, { key: e.target.value })}
                      placeholder={t(
                        "editor.toolPreconditions.keyPlaceholder",
                        "attribute key",
                      )}
                      list={listId}
                    />
                    <datalist id={listId}>
                      {defs
                        .filter((d) => d.model === SCOPE_MODEL[row.scope])
                        .map((d) => (
                          <option key={d.key} value={d.key}>
                            {d.displayName || d.key}
                          </option>
                        ))}
                    </datalist>
                  </div>
                  <div className="w-full sm:w-36">
                    <Select
                      aria-label={t("editor.toolPreconditions.scope", "Scope")}
                      value={row.scope}
                      onChange={(e) =>
                        patch(i, {
                          scope:
                            e.target.value === "contact"
                              ? "contact"
                              : "conversation",
                        })
                      }
                    >
                      <option value="conversation">
                        {t(
                          "editor.toolPreconditions.ofConversation",
                          "on the conversation",
                        )}
                      </option>
                      <option value="contact">
                        {t(
                          "editor.toolPreconditions.ofContact",
                          "on the contact",
                        )}
                      </option>
                    </Select>
                  </div>
                  <div className="w-full sm:w-44">
                    <Select
                      aria-label={t(
                        "editor.toolPreconditions.match",
                        "Condition",
                      )}
                      value={match}
                      onChange={(e) =>
                        patch(i, {
                          match: e.target.value === "equals" ? "equals" : "any",
                        })
                      }
                    >
                      <option value="any">
                        {t(
                          "editor.toolPreconditions.matchAny",
                          "has any value",
                        )}
                      </option>
                      <option value="equals">
                        {t("editor.toolPreconditions.matchEquals", "equals")}
                      </option>
                    </Select>
                  </div>
                  {match === "equals" && (
                    <div className="w-full sm:w-44">
                      <Input
                        aria-label={t(
                          "editor.toolPreconditions.equals",
                          "Required value",
                        )}
                        value={row.equals}
                        onChange={(e) =>
                          patch(i, { match: "equals", equals: e.target.value })
                        }
                        placeholder={t(
                          "editor.toolPreconditions.equalsPlaceholder",
                          "required value",
                        )}
                      />
                    </div>
                  )}
                </div>
                {match === "equals" && !row.equals.trim() && (
                  <p className="text-text-muted text-xs">
                    {t(
                      "editor.toolPreconditions.equalsMissing",
                      "While the value is blank, the rule asks only that the attribute has some value.",
                    )}
                  </p>
                )}
                {row.tool && !assembledTools.has(row.tool) && (
                  <p className="flex items-center gap-1.5 text-warning text-xs">
                    <AlertTriangle
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden
                    />
                    {t("editor.toolPreconditions.toolGone", {
                      defaultValue:
                        "{{tool}} is not among the agent's tools: it was renamed, removed or turned off. This rule guards nothing.",
                      tool: labelOf(row.tool),
                    })}
                  </p>
                )}
              </div>
            );
          })}
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
// rather than saved half-written, since the write boundary would refuse the whole save for them.
// `stored` carries the entries this editor cannot render through untouched, so an unrelated save
// never deletes them. Saving without changing a row must not change what the runtime accepts
// (asserted per class of stored value in tests/client/tool-preconditions-editor.test.ts).
export function serializeToolPreconditions(
  rows: ToolPreconditionRow[],
  stored?: unknown,
): Record<string, unknown> {
  // NULL-PROTOTYPE, for the same reason the runtime map is: a tool named `__proto__` assigned onto
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
    const equals = matchOf(row) === "equals" ? row.equals.trim() : "";
    out[tool] = {
      kind: "attribute",
      scope: row.scope,
      key,
      ...(equals ? { equals } : {}),
    };
  }
  return out;
}

// Only entries this editor can render EXACTLY, and only for tools it can OFFER; everything else stays
// in the raw passthrough. An unknown kind or scope, a missing key or a non-string/blank `equals` is
// skipped rather than coerced, or a save could turn an entry the runtime IGNORES into a live rule. A
// tool with no option here (HTTP/MCP/integration, set over REST) is skipped too: a blank-selector
// row invites deleting a guard the operator never asked about.
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
