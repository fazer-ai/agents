import { AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  HelpPopover,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  Skeleton,
  SwitchField,
  Textarea,
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";
import { SANDBOX_CODE_MAX_CHARS } from "@/graph/tools/code-sandbox-limits";
import { normalizeToolName } from "@/graph/tools/toolName";
import {
  type CodeSyntaxWarning,
  checkCodeToolSyntax,
} from "@/lib/code-tool-syntax";
import {
  type AiFieldRow,
  AiFieldsPanel,
  aiFieldsFromSchema,
  schemaFromAiFields,
  testFieldsFrom,
} from "./AiFieldsPanel";
import {
  CodeToolTestModal,
  type CodeToolTestTarget,
} from "./CodeToolTestModal";

// Create/edit an operator-authored code tool (issue #363): a JavaScript function body the agent
// calls with typed arguments, the sibling of ToolEditModal for the kind whose "wiring" is code
// rather than an HTTP request. The model only ever supplies arguments; the operator owns the label,
// the required description, the typed input schema and the body. The identifier the agent calls is
// derived from the label by `normalizeToolName`, exactly like an HTTP tool, so it is shown live and
// never typed.
//
// Invalid code is SAVED, not refused: the static check (lib/code-tool-syntax.ts) answers alongside
// the row as a WARNING, and a body that does not parse fails at call time as the operator's failure.
// So the syntax warning never disables Save, and a half-typed body can always be saved and reopened.

type CodeToolsData = Awaited<
  ReturnType<(typeof api.api.v1)["code-tools"]["get"]>
>["data"];
// Derived from the treaty; never hand-mirrored (docs/eden-treaty.md).
export type CodeTool = NonNullable<CodeToolsData>["tools"][number];

// A starter body that shows the contract at a glance; the operator replaces it. Empty would do (Save
// gates on non-empty code), but the shape is the thing a first-time author most needs to see.
const STARTER_CODE = `// input holds the typed arguments you declared; context the conversation.
// Answer with a return; console.log output comes back with it.
return { ok: true };
`;

function emptyForm() {
  return {
    label: "",
    description: "",
    aiFields: [] as AiFieldRow[],
    code: STARTER_CODE,
    enabled: true,
  };
}

type CodeToolForm = ReturnType<typeof emptyForm>;

// The stored tool into the form the modal edits. Pure over its argument (tested).
export function formFromCodeTool(tool: CodeTool): CodeToolForm {
  return {
    label: tool.label,
    description: tool.description,
    aiFields: aiFieldsFromSchema(
      (tool.inputSchema ?? {}) as Record<string, unknown>,
    ),
    code: tool.code,
    enabled: tool.enabled,
  };
}

// The body this modal writes, from the form it renders. ONE function, because a refusal is matched
// against it too: `capture` compares what was SENT with what the inputs hold NOW, and two spellings
// of "the payload" would disagree about a field nobody edited. The identifier is always derived from
// the label (single source of truth), exactly as an HTTP tool's name is.
export function payloadOfCodeTool(form: CodeToolForm) {
  return {
    name: normalizeToolName(form.label.trim()),
    label: form.label.trim(),
    description: form.description.trim(),
    inputSchema: schemaFromAiFields(form.aiFields),
    code: form.code,
    enabled: form.enabled,
  };
}

// The server's own names for what this modal renders, which are the keys of the body above. `name`
// is derived from the label rather than typed, so a refusal about it is marked on the label — the
// input the operator can actually change.
const CODE_TOOL_FIELDS = [
  "name",
  "label",
  "description",
  "inputSchema",
  "code",
] as const;

export function CodeToolEditModal({
  modal,
  onSaved,
  sharedNotice,
}: {
  modal: ModalController<{ id?: string }>;
  onSaved?: (saved: { id: string; name: string }, isNew: boolean) => void;
  sharedNotice?: boolean;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [form, setForm] = useState(emptyForm());
  // The CURRENT form, readable from inside a request that started before it: the operator can type
  // during the save, and a refusal about a value they have already replaced belongs in the banner
  // rather than under a box that no longer holds it.
  const formRef = useRef(form);
  formRef.current = form;
  const [saving, setSaving] = useState(false);
  const [loadingForm, setLoadingForm] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // The static syntax warnings for the body: computed on a debounce while the operator types, and
  // replaced by the server's own on save. The two are the SAME check (lib/code-tool-syntax.ts), so
  // they cannot disagree; the warning is advisory and never disables Save.
  const [syntaxWarnings, setSyntaxWarnings] = useState<CodeSyntaxWarning[]>([]);
  const baselineRef = useRef<string | null>(null);
  const testModal = useModalController<CodeToolTestTarget>();

  const editId = modal.payload?.id;

  const refusal = useFieldRefusal(modal.isOpen ? [...CODE_TOOL_FIELDS] : []);
  // What the inputs hold right now, in the server's vocabulary. The marks are keyed by VALUE, so
  // this has to be the same function the save sends.
  const current = payloadOfCodeTool(form);

  useOnModalOpen(modal, () => {
    // The component outlives the dialog, so a mark from the last session is still held here.
    refusal.clear();
    setFormError(null);
    setLoadError(false);
    setSyntaxWarnings([]);
    const payloadId = modal.payload?.id;
    if (payloadId) {
      baselineRef.current = null;
      setLoadingForm(true);
      void (async () => {
        try {
          const { data, error } = await api.api.v1["code-tools"]({
            id: payloadId,
          }).get();
          if (error || !data) {
            setLoadError(true);
            return;
          }
          const initial = formFromCodeTool(data.tool);
          setForm(initial);
          baselineRef.current = JSON.stringify(initial);
        } catch {
          setLoadError(true);
        } finally {
          setLoadingForm(false);
        }
      })();
    } else {
      const initial = emptyForm();
      setForm(initial);
      baselineRef.current = JSON.stringify(initial);
    }
    // The test dialog belongs to the tool session that opened it, so closing the editor takes it with
    // it (docs/modals.md, "parent close invalidates nested state").
    return () => testModal.close();
  });

  // The static check on a debounce: the parse is cheap but re-running it on every keystroke of a
  // 300-line body is not, and the offer only has to be right once the operator pauses. Same module
  // the server runs on save, so the warning the operator sees while typing is the one that will be
  // stored.
  useEffect(() => {
    const code = form.code;
    if (!code.trim()) {
      setSyntaxWarnings([]);
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      void checkCodeToolSyntax(code).then((w) => {
        if (!cancelled) setSyntaxWarnings(w);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [form.code]);

  async function save() {
    setFormError(null);
    const payload = payloadOfCodeTool(form);
    setSaving(true);
    const fallback = t("codeTools.saveError", "Could not save.");
    const held = (e: unknown) =>
      refusal.capture(e, fallback, payload, payloadOfCodeTool(formRef.current));
    try {
      const { data, error: err } = editId
        ? await api.api.v1["code-tools"]({ id: editId }).patch(payload)
        : await api.api.v1["code-tools"].post(payload);
      if (err || !data) {
        setFormError(held(err));
        return;
      }
      refusal.clear();
      // The server's own warnings replace the client's — the same check, so this only makes the
      // agreement explicit.
      setSyntaxWarnings(data.warnings);
      showToast(t("codeTools.saved", "Code tool saved."), "success");
      modal.close();
      onSaved?.({ id: data.tool.id, name: data.tool.name }, !editId);
    } catch (e) {
      setFormError(held(e));
    } finally {
      setSaving(false);
    }
  }

  function openTest() {
    const payload = payloadOfCodeTool(form);
    testModal.open({
      definition: {
        name: payload.name,
        inputSchema: payload.inputSchema,
        code: payload.code,
      },
      aiFields: testFieldsFrom(payload.inputSchema),
    });
  }

  // Unique field names are a real gate (the schema keys collapse otherwise); everything else that is
  // wrong with the body is a WARNING, saved either way. So Save is off only when a required field is
  // blank or two AI fields share a name.
  const trimmedNames = form.aiFields.map((f) => f.name.trim()).filter(Boolean);
  const duplicateNames = new Set(trimmedNames).size !== trimmedNames.length;
  const valid =
    !loadingForm &&
    !loadError &&
    !!form.label.trim() &&
    !!form.description.trim() &&
    !!form.code.trim() &&
    !duplicateNames;

  const isDirty =
    baselineRef.current !== null &&
    JSON.stringify(form) !== baselineRef.current;

  // The one static warning the body produces, if any: a parse error with its line and column, or a
  // body that never returns. Rendered as a SIBLING under the code field, never inside its FormField,
  // whose description shares a slot with its error (docs/ui.md).
  const warning = syntaxWarnings[0];
  const warningText = !warning
    ? null
    : warning.kind === "syntax"
      ? t(
          "codeTools.syntaxWarning",
          "Line {{line}}, column {{column}}: {{message}}",
          {
            line: warning.line,
            column: warning.column,
            message: warning.message,
          },
        )
      : t(
          "codeTools.noReturnWarning",
          "The code never returns a value; the agent would receive undefined.",
        );

  return (
    <>
      <Modal
        modal={modal}
        size="lg"
        unsavedChanges={isDirty}
        title={
          editId
            ? t("codeTools.editTitle", "Edit code tool")
            : t("codeTools.addTitle", "New code tool")
        }
        footer={
          <div className="flex items-center justify-between gap-2">
            <span className="text-error text-xs">{formError}</span>
            <div className="flex gap-2">
              <ModalCancelButton disabled={saving} />
              <Button onClick={save} loading={saving} disabled={!valid}>
                {t("common.save", "Save")}
              </Button>
            </div>
          </div>
        }
      >
        {loadingForm ? (
          <div className="flex flex-col gap-3" role="status">
            <span className="sr-only">{t("common.loading", "Loading…")}</span>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : loadError ? (
          <p className="text-error text-sm">
            {t("codeTools.loadError", "Could not load this code tool.")}
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {sharedNotice && editId && (
              <div className="flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-text-primary text-xs">
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                  aria-hidden="true"
                />
                <span>
                  {t(
                    "codeTools.sharedNotice",
                    "This is a shared code tool. Changes affect every agent that uses it.",
                  )}
                </span>
              </div>
            )}
            <FormField
              label={t("codeTools.name", "Display name")}
              required
              description={t(
                "codeTools.nameHint",
                "How the tool is shown in the console. Spaces and accents are allowed; the identifier the AI calls is derived from it automatically.",
              )}
              error={
                refusal.at("label", current.label) ??
                refusal.at("name", current.name)
              }
            >
              <Input
                value={form.label}
                onChange={(e) =>
                  setForm((f) => ({ ...f, label: e.target.value }))
                }
                placeholder={t("codeTools.namePlaceholder", "Look up CPF")}
              />
              {form.label.trim() && (
                <p className="mt-1 flex flex-wrap items-center gap-1 text-text-muted text-xs">
                  <span>{t("codeTools.identifierPreview", "Identifier:")}</span>
                  <code className="rounded bg-bg-tertiary px-1 py-0.5 font-mono">
                    {normalizeToolName(form.label)}
                  </code>
                </p>
              )}
            </FormField>

            <FormField
              label={t("codeTools.description", "Description")}
              required
              description={t(
                "codeTools.descriptionHint",
                "What the tool answers and when to call it. The agent reads this to decide, so it is required.",
              )}
              error={refusal.at("description", current.description)}
            >
              <Textarea
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                rows={2}
                maxLength={2000}
                placeholder={t(
                  "codeTools.descriptionPlaceholder",
                  "e.g. Check whether a CPF is valid before quoting.",
                )}
              />
            </FormField>

            <FormField
              error={refusal.at("inputSchema", current.inputSchema)}
              label={t("codeTools.inputs", "Arguments")}
              group
              description={t(
                "codeTools.inputsHint",
                "The arguments the agent fills in. The body reads them as `input.<name>`.",
              )}
            >
              <AiFieldsPanel
                value={form.aiFields}
                onChange={(aiFields) => setForm((f) => ({ ...f, aiFields }))}
              />
              {duplicateNames && (
                <p className="text-error text-xs">
                  {t(
                    "codeTools.duplicateNames",
                    "Two arguments share a name. Give each one a distinct name.",
                  )}
                </p>
              )}
            </FormField>

            <FormField
              label={
                <span className="flex items-center gap-1.5">
                  {t("codeTools.code", "Code")}
                  <HelpPopover
                    label={t("codeTools.code", "Code")}
                    content={t(
                      "codeTools.codeHelp",
                      "The body of a JavaScript function the agent calls. `input` holds the arguments you declared above; `context` holds the conversation variables (contact_name, contact_email, conversation_id, and the rest). Answer with `return`.\n\nWhatever you return is rendered as JSON for the agent, and console.log output comes back with it. validateCpf(text) and validateCnpj(text) give { valid }; TIMEZONE, NOW_LOCAL and Date run in the agent's zone.\n\nThere is no network, no imports and no async. A run gets 1000 ms and 32 MB; a throw or a limit is a failure, a returned value is a result. Invalid code is still saved and fails when the agent calls it.",
                    )}
                  />
                </span>
              }
              group
              required
              error={refusal.at("code", current.code)}
            >
              <Textarea
                value={form.code}
                onChange={(e) =>
                  setForm((f) => ({ ...f, code: e.target.value }))
                }
                rows={14}
                spellCheck={false}
                maxLength={SANDBOX_CODE_MAX_CHARS}
                className="font-mono text-xs"
                placeholder={STARTER_CODE}
                aria-label={t("codeTools.code", "Code")}
              />
            </FormField>
            {warningText && (
              <p className="-mt-2 text-warning text-xs">{warningText}</p>
            )}

            <div className="-mt-2 flex flex-col gap-1">
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                disabled={!form.code.trim() || duplicateNames}
                onClick={openTest}
              >
                {t("codeTools.testOpen", "Test")}
              </Button>
              <span className="text-text-secondary text-xs">
                {t(
                  "codeTools.testOpenHint",
                  "Runs the code once in the sandbox with arguments you supply, and shows what the agent would receive.",
                )}
              </span>
            </div>

            <SwitchField
              checked={form.enabled}
              onCheckedChange={(enabled) => setForm((f) => ({ ...f, enabled }))}
              label={t("codeTools.enabled", "Available to agents")}
            />
          </div>
        )}
      </Modal>
      <CodeToolTestModal modal={testModal} />
    </>
  );
}
