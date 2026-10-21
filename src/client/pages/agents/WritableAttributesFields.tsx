import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ComboBox, FormField } from "@/client/components";
import { api } from "@/client/lib/api";
import { SCOPE_MODEL } from "@/modules/chatwoot/attributes";

// Mirrors agent.settings.setCustomAttribute.allowed (readWritableAttributes): the attributes
// set_custom_attribute may write, edited per scope and stored as `{ scope, key }` pairs.
export interface WritableAttributesState {
  conversation: string[];
  contact: string[];
  task: string[];
}
type Scope = keyof WritableAttributesState;
const SCOPES: Scope[] = ["conversation", "contact", "task"];

export const EMPTY_WRITABLE_ATTRIBUTES: WritableAttributesState = {
  conversation: [],
  contact: [],
  task: [],
};

export function readWritableAttributesState(
  raw: unknown,
): WritableAttributesState {
  const out: WritableAttributesState = {
    conversation: [],
    contact: [],
    task: [],
  };
  const block =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).allowed
      : undefined;
  if (!Array.isArray(block)) return out;
  for (const entry of block) {
    if (!entry || typeof entry !== "object") continue;
    const { scope, key } = entry as Record<string, unknown>;
    if (typeof key !== "string" || !key.trim()) continue;
    if (scope !== "conversation" && scope !== "contact" && scope !== "task")
      continue;
    if (!out[scope].includes(key.trim())) out[scope].push(key.trim());
  }
  return out;
}

export function serializeWritableAttributes(
  state: WritableAttributesState,
): Array<{ scope: Scope; key: string }> {
  return SCOPES.flatMap((scope) =>
    [...new Set(state[scope].map((k) => k.trim()).filter(Boolean))].map(
      (key) => ({ scope, key }),
    ),
  );
}

export function hasWritableAttributes(state: WritableAttributesState): boolean {
  return SCOPES.some((s) => state[s].length > 0);
}

// Chatwoot attribute definition (Eden-derived), with the rule fields the tool enforces.
type InboxCustomAttribute = NonNullable<
  Awaited<
    ReturnType<
      ReturnType<(typeof api.api.v1.chatwoot)["custom-attributes"]>["get"]
    >
  >["data"]
>["attributes"][number];

// The rule set_custom_attribute applies to a value of this definition, in the operator's words
// (modules/chatwoot/attribute-rules.ts is the rule itself).
function useRuleText() {
  const { t } = useTranslation();
  return (d: InboxCustomAttribute): string => {
    switch (d.displayType) {
      case "list":
        return d.values.length > 0
          ? t("editor.writableAttributes.ruleList", "One of: {{values}}", {
              values: d.values.join(", "),
            })
          : t("editor.writableAttributes.ruleText", "Any text");
      case "number":
      case "currency":
      case "percent":
        return t("editor.writableAttributes.ruleNumber", "A number");
      case "date":
        return t("editor.writableAttributes.ruleDate", "A date (YYYY-MM-DD)");
      case "checkbox":
        return t("editor.writableAttributes.ruleCheckbox", "true or false");
      case "link":
        return t(
          "editor.writableAttributes.ruleLink",
          "A URL starting with http:// or https://",
        );
      default:
        return t("editor.writableAttributes.ruleText", "Any text");
    }
  };
}

export function WritableAttributesFields({
  agentId,
  value,
  onChange,
}: {
  agentId: string;
  value: WritableAttributesState;
  onChange: (next: WritableAttributesState) => void;
}) {
  const { t } = useTranslation();
  const ruleText = useRuleText();
  const [defs, setDefs] = useState<InboxCustomAttribute[]>([]);
  const [multiAccount, setMultiAccount] = useState(false);
  const [settingsUrl, setSettingsUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setDefs([]);
    setMultiAccount(false);
    setSettingsUrl(null);
    void (async () => {
      try {
        const { data } = await api.api.v1.chatwoot["custom-attributes"]({
          agentId,
        }).get();
        if (!cancelled && data) {
          setDefs(data.attributes);
          setMultiAccount(data.accountCount > 1);
          setSettingsUrl(data.settingsUrl);
        }
      } catch {
        // NOTE: best-effort, the pickers still take a typed key
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  const scopeLabel: Record<Scope, string> = {
    conversation: t("editor.attributeContextConversation", "Conversation"),
    contact: t("editor.attributeContextContact", "Contact"),
    task: t("editor.attributeContextTask", "Kanban card"),
  };
  const defOf = (scope: Scope, key: string) =>
    defs.find((d) => d.model === SCOPE_MODEL[scope] && d.key === key);
  const listed = SCOPES.flatMap((scope) =>
    value[scope].map((key) => ({ scope, key, def: defOf(scope, key) })),
  );

  return (
    <FormField
      group
      label={t("editor.writableAttributes.label", "Attributes it may write")}
      description={t(
        "editor.writableAttributes.hint",
        "Optional. The only attributes this agent may write or clear. Empty: any attribute. Either way, a value that breaks the attribute's definition in Chatwoot (its options, type or pattern) is not saved, and the agent is told to ask again.",
      )}
    >
      <div className="flex flex-col gap-3">
        {SCOPES.map((scope) => (
          <div
            key={scope}
            className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3"
          >
            <span className="text-sm text-text-secondary sm:w-32 sm:shrink-0">
              {scopeLabel[scope]}
            </span>
            <div className="min-w-0 flex-1">
              <ComboBox
                multiple
                values={value[scope]}
                onChange={(values) => onChange({ ...value, [scope]: values })}
                items={defs
                  .filter((d) => d.model === SCOPE_MODEL[scope])
                  .map((d) => ({
                    id: d.key,
                    label: d.displayName || d.key,
                    hint: d.displayName && d.displayName !== d.key ? d.key : "",
                  }))}
                placeholder={t(
                  "editor.attributeContextPlaceholder",
                  "Add an attribute…",
                )}
                searchPlaceholder={t(
                  "editor.attributeContextSearch",
                  "Search attributes…",
                )}
                aria-label={`${t("editor.writableAttributes.label", "Attributes it may write")}: ${scopeLabel[scope]}`}
              />
            </div>
          </div>
        ))}
        {listed.length > 0 && (
          <ul
            className="flex flex-col divide-y divide-border rounded-md border border-border"
            aria-label={t(
              "editor.writableAttributes.rules",
              "What each attribute accepts",
            )}
          >
            {listed.map(({ scope, key, def }) => (
              <li
                key={`${scope}:${key}`}
                className="flex flex-col gap-0.5 px-3 py-2 text-sm"
              >
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-text-primary">
                    {def?.displayName || key}
                  </span>
                  <span className="font-mono text-text-muted text-xs">
                    {scopeLabel[scope]} · {key}
                  </span>
                </span>
                <span className="text-text-secondary text-xs">
                  {def
                    ? ruleText(def)
                    : t(
                        "editor.writableAttributes.ruleUndefined",
                        "No definition in Chatwoot: any text that is not empty",
                      )}
                </span>
                {def?.regexPattern && (
                  <span className="text-text-secondary text-xs">
                    {t(
                      "editor.writableAttributes.rulePattern",
                      "Must match the pattern",
                    )}{" "}
                    <code className="font-mono">{def.regexPattern}</code>
                    {def.regexCue ? ` (${def.regexCue})` : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {settingsUrl && (
          <a
            href={settingsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 self-start text-accent text-xs hover:underline"
          >
            {t(
              "editor.writableAttributes.editInChatwoot",
              "Edit options and patterns in Chatwoot",
            )}
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        )}
        {multiAccount && (
          <span className="text-text-muted text-xs">
            {t(
              "editor.attributeContextMultiAccount",
              "This agent serves more than one Chatwoot account, so the listed attributes mix accounts. Type each key exactly as it appears.",
            )}
          </span>
        )}
      </div>
    </FormField>
  );
}
