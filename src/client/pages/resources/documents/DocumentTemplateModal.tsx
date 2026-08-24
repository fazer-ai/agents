import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  Select,
  SwitchField,
  Textarea,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import {
  documentToolName,
  slugifyTemplateName,
  slugProblem,
} from "@/modules/documents/slug";
import { DocumentPreview } from "./DocumentPreview";
import { useDocumentPreview } from "./useDocumentPreview";

// Editing a template, deliberately narrow: name, numbering, style, and the TEXT of text blocks.
//
// Adding, removing and reordering blocks is API/MCP only, and the panel says so. That is a real
// scope cut, not an oversight: a block editor that can move a totals row above the items it sums is
// a layout tool, and building one badly is worse than not having one. What the console does own is
// the part an operator changes weekly — the words — and the preview, which is what makes authoring
// through the API bearable.

type TemplatesData = Awaited<
  ReturnType<(typeof api.api.v1)["document-templates"]["get"]>
>["data"];
export type DocumentTemplate = NonNullable<TemplatesData>["templates"][number];
type Style = DocumentTemplate["style"];
type Block = DocumentTemplate["blocks"][number];

export interface TemplateModalPayload {
  template: DocumentTemplate;
}

const FONTS = ["sans", "serif", "mono"] as const;
const MARGINS = ["narrow", "normal", "wide"] as const;
const PAGE_SIZES = ["A4", "LETTER"] as const;

export function DocumentTemplateModal({
  modal,
  onSaved,
}: {
  modal: ModalController<TemplateModalPayload>;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const template = modal.payload?.template ?? null;
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [numberPrefix, setNumberPrefix] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [style, setStyle] = useState<Style | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const baselineRef = useRef<string | null>(null);
  // The same open, counted twice on purpose: the ref is what an in-flight save compares itself
  // against (it has to read the CURRENT value when the response lands), and the state is what the
  // render is keyed on, which is how the preview learns the modal was reopened.
  const sessionRef = useRef(0);
  const [session, setSession] = useState(0);

  // On OPEN, not on payload identity. The controller retains its payload after close (Radix needs it
  // for the exit animation), so an operator who cancels and reopens the same template gets an effect
  // that does not re-run and a form still holding the values they discarded — which the next Save
  // would then persist. `useOnModalOpen` fires on every false→true transition, which is the event
  // this reset belongs to (docs/modals.md).
  useOnModalOpen(modal, () => {
    sessionRef.current++;
    setSession(sessionRef.current);
    const tpl = modal.payload?.template;
    if (!tpl) return;
    const initialTexts = Object.fromEntries(
      tpl.blocks
        .filter((b): b is Block & { type: "text"; text: string } =>
          Boolean(b && b.type === "text"),
        )
        .map((b) => [b.id, b.text]),
    );
    setName(tpl.name);
    setSlug(tpl.slug);
    setDescription(tpl.description ?? "");
    setNumberPrefix(tpl.numberPrefix ?? "");
    setEnabled(tpl.enabled);
    setStyle({ ...tpl.style });
    setTexts(initialTexts);
    baselineRef.current = JSON.stringify({
      name: tpl.name,
      slug: tpl.slug,
      description: tpl.description ?? "",
      numberPrefix: tpl.numberPrefix ?? "",
      enabled: tpl.enabled,
      style: { ...tpl.style },
      texts: initialTexts,
    });
  });

  // Null until the first open, so a form nobody has seen is never "dirty".
  const isDirty =
    baselineRef.current !== null &&
    JSON.stringify({
      name,
      slug,
      description,
      numberPrefix,
      enabled,
      style,
      texts,
    }) !== baselineRef.current;

  // The words, by block id — never the whole `blocks` array. Sending the array back would make this
  // modal authoritative over a layout it did not author: an API or MCP client that added or
  // reordered a block while it was open would have that work replaced by the snapshot loaded here.
  // Block ids exist so a console edit survives a reorder from another transport.
  const blockText = useMemo(() => {
    if (!template) return {};
    const out: Record<string, string> = {};
    for (const b of template.blocks) {
      if (b.type !== "text") continue;
      const edited = texts[b.id];
      if (edited !== undefined && edited !== b.text) out[b.id] = edited;
    }
    return out;
  }, [template, texts]);

  // Local only, for the block list below: the preview is rendered server-side from `blockText`.
  const blocks = useMemo(() => {
    if (!template) return [];
    return template.blocks.map((b) =>
      b.type === "text" && texts[b.id] !== undefined
        ? { ...b, text: texts[b.id] }
        : b,
    );
  }, [template, texts]);

  // What this modal would WRITE: the fields whose value here differs from the row it was opened on.
  //
  // The modal holds a snapshot from when the list was loaded, so sending every field back makes a
  // wording-only edit overwrite a name, prefix or style an API or MCP client set in the meantime —
  // the same multi-transport overwrite `blockText` exists to avoid for the blocks. The server's row
  // lock serialises the writes; it cannot know that a field this request restated was never edited
  // here.
  //
  // The PREVIEW is built from this too, and that is the point of it being one value: a preview
  // assembled from the modal's whole state shows the stale style beside the new wording, while the
  // save that follows keeps the concurrent style — the preview describing a document the apply will
  // not produce, which is the one thing it must never do.
  const changes = useMemo(() => {
    if (!template || !style) return null;
    const patch: Record<string, unknown> = {};
    if (name !== template.name) patch.name = name;
    if (slug !== template.slug) patch.slug = slug;
    if (description !== (template.description ?? "")) {
      patch.description = description || null;
    }
    if (numberPrefix !== (template.numberPrefix ?? "")) {
      patch.numberPrefix = numberPrefix || null;
    }
    if (enabled !== template.enabled) patch.enabled = enabled;
    if (Object.keys(blockText).length > 0) patch.blockText = blockText;
    const changedStyle = Object.fromEntries(
      Object.entries(style as unknown as Record<string, unknown>).filter(
        ([k, v]) =>
          v !== (template.style as unknown as Record<string, unknown>)[k],
      ),
    );
    if (Object.keys(changedStyle).length > 0) patch.style = changedStyle;
    return patch;
  }, [
    template,
    style,
    name,
    slug,
    description,
    numberPrefix,
    enabled,
    blockText,
  ]);

  const draft = useMemo(() => {
    if (!template || !changes) return null;
    // Only the properties the preview route takes; the rest of the patch does not render.
    const shown = ["name", "blockText", "style", "numberPrefix"] as const;
    return {
      id: template.id,
      ...Object.fromEntries(
        shown.filter((k) => k in changes).map((k) => [k, changes[k]]),
      ),
    };
  }, [template, changes]);
  const preview = useDocumentPreview(
    draft as Record<string, unknown> | null,
    // This OPEN, not this template: cancelling and reopening the same one has to drop the preview
    // of the edits that were just discarded.
    session,
  );

  async function save() {
    if (!template || !style || !changes) return;
    // The session this save belongs to. An operator can close the modal and reopen it for another
    // template while the request is in flight; when the old one lands, its success would close the
    // NEW modal and report a result about a template that is no longer on screen.
    const session = sessionRef.current;
    setSaving(true);
    try {
      // The same diff the preview was built from, so what is sent is what was shown.
      const patch = changes;
      if (Object.keys(patch).length === 0) {
        showToast(t("common.saved", "Saved."), "success");
        baselineRef.current = null;
        modal.close();
        return;
      }
      const { error } = await api.api.v1["document-templates"]({
        id: template.id,
      }).patch(patch);
      if (session !== sessionRef.current) return;
      if (error) {
        // What the save refuses for is not what the preview checks: a duplicate name and an
        // oversized description are decided by the write, and the preview never sees either. The
        // server words both, so the generic sentence would leave the operator with a form that looks
        // valid and a button that keeps failing.
        showToast(
          apiErrorMessage(error) ||
            t("documents.saveError", "Could not save this template."),
          "error",
        );
        return;
      }
      showToast(t("common.saved", "Saved."), "success");
      // Programmatic close after a successful save: nothing is dirty any more, so it correctly
      // bypasses the guard. The footer's Cancel is the user-driven path and goes through it.
      baselineRef.current = null;
      modal.close();
      onSaved();
    } catch {
      // Eden rejects on a transport failure rather than answering `{ error }`, and only the second
      // was handled — so an offline save closed nothing, said nothing, and left an unhandled
      // rejection behind.
      if (session === sessionRef.current) {
        showToast(
          t("documents.saveError", "Could not save this template."),
          "error",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  // Answered here because the answer is a keystroke away, not because the write stopped checking:
  // this is the SAME `slugProblem` the write runs, imported rather than restated.
  //
  // Guarded on `template`, not on the slug being non-empty. An operator who CLEARS the field has to
  // be told something, and the modal keeps its payload after closing (Radix needs it for the exit
  // animation), so this never flashes a refusal at a form nobody has opened.
  const slugIssue = template ? slugProblem(slug) : null;

  const textBlocks = blocks.filter((b) => b.type === "text");

  return (
    <Modal
      modal={modal}
      size="xl"
      unsavedChanges={isDirty}
      // While the save is in flight the modal stays put: closing it there is what creates the stale
      // callback in the first place, and the request cannot be taken back (docs/modals.md).
      onCloseRequest={saving ? () => undefined : undefined}
      title={t("documents.editTitle", "Edit document template")}
      footer={
        <div className="flex justify-end gap-2">
          {/* Not modal.close(): that is the PROGRAMMATIC path and bypasses the unsaved-changes
              guard by design. A footer Cancel is user-driven, so it funnels through the same guard
              as Esc and the X (docs/modals.md). */}
          <ModalCancelButton disabled={saving} />
          {/* Disabled on a refusal the FIELD is already explaining, in red, one line above the
              button. Sending it anyway would spend a round trip to be told what is on screen. */}
          <Button onClick={save} loading={saving} disabled={Boolean(slugIssue)}>
            {t("common.save", "Save")}
          </Button>
        </div>
      }
    >
      {/* Every control at once, because the diff this save sends was captured when it was clicked:
          an edit typed after that is not in the request, and the success that follows closes the
          modal and takes it away without a word. A fieldset disables its whole subtree, so a control
          added here later is covered without anyone remembering the rule. */}
      <fieldset
        disabled={saving}
        className="grid gap-4 border-0 p-0 lg:grid-cols-2"
      >
        <div className="flex flex-col gap-3">
          <FormField label={t("documents.name", "Name")}>
            <Input
              value={name}
              // The name is the source of the slug, and it stays the source: every keystroke here
              // re-derives it, so a rename renames the agent's tool instead of leaving a template
              // called "Contrato" behind a tool called send_orcamento. A slug the operator typed by
              // hand is overwritten by the next edit to the name, deliberately — a slug that
              // survived it would be a second name to keep in sync by hand.
              onChange={(e) => {
                setName(e.target.value);
                setSlug(slugifyTemplateName(e.target.value));
              }}
            />
          </FormField>
          <FormField label={t("documents.description", "Description")}>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label={t("documents.numberPrefix", "Number prefix")}
              hint={t("documents.numberPrefixHint", 'e.g. "ORC-" → ORC-0001')}
            >
              <Input
                value={numberPrefix}
                onChange={(e) => setNumberPrefix(e.target.value)}
              />
            </FormField>
            {/* The tool name the model will be offered, and the operator's to change. It was
                read-only, which made the rename trap unfixable from the screen that caused it: the
                field kept showing the tool derived from the ORIGINAL name with nothing saying why.
                The refusal shows HERE rather than in a toast, because the only thing that answers
                it is this input. */}
            <FormField
              label={t("documents.toolName", "Agent tool")}
              hint={t("documents.toolNameHint", "The agent calls it {{tool}}", {
                tool: documentToolName(slug),
              })}
              error={slugIssue}
            >
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} />
            </FormField>
          </div>

          {style && (
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={t("documents.style.font", "Font")}>
                <Select
                  value={style.font}
                  onChange={(e) =>
                    setStyle({
                      ...style,
                      font: e.target.value as Style["font"],
                    })
                  }
                >
                  {FONTS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label={t("documents.style.size", "Base font size")}>
                <Input
                  type="number"
                  min={8}
                  max={14}
                  value={style.baseFontSize}
                  onChange={(e) =>
                    setStyle({ ...style, baseFontSize: Number(e.target.value) })
                  }
                />
              </FormField>
              <FormField
                label={t("documents.style.accent", "Accent color")}
                group
              >
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={t("documents.style.accent", "Accent color")}
                    value={style.accentColor}
                    onChange={(e) =>
                      setStyle({ ...style, accentColor: e.target.value })
                    }
                    className="h-9 w-12 rounded border border-border bg-bg-secondary"
                  />
                  <Input
                    value={style.accentColor}
                    onChange={(e) =>
                      setStyle({ ...style, accentColor: e.target.value })
                    }
                  />
                </div>
              </FormField>
              <FormField label={t("documents.style.margin", "Margins")}>
                <Select
                  value={style.margin}
                  onChange={(e) =>
                    setStyle({
                      ...style,
                      margin: e.target.value as Style["margin"],
                    })
                  }
                >
                  {MARGINS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label={t("documents.style.pageSize", "Page size")}>
                <Select
                  value={style.pageSize}
                  onChange={(e) =>
                    setStyle({
                      ...style,
                      pageSize: e.target.value as Style["pageSize"],
                    })
                  }
                >
                  {PAGE_SIZES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField label={t("documents.style.currency", "Currency")}>
                <Input
                  value={style.currency}
                  maxLength={3}
                  onChange={(e) =>
                    setStyle({
                      ...style,
                      currency: e.target.value.toUpperCase(),
                    })
                  }
                />
              </FormField>
            </div>
          )}

          <SwitchField
            label={t("documents.enabled", "Agents may issue this document")}
            checked={enabled}
            onCheckedChange={setEnabled}
          />

          <div className="flex flex-col gap-2">
            <p className="font-medium text-sm text-text-primary">
              {t("documents.textBlocks", "Text")}
            </p>
            <p className="text-text-muted text-xs">
              {t(
                "documents.textBlocksHint",
                "Only the wording is editable here. Adding, removing or reordering blocks is done through the API or MCP.",
              )}
            </p>
            {textBlocks.length === 0 ? (
              <p className="text-sm text-text-muted">
                {t(
                  "documents.noTextBlocks",
                  "This template has no text block.",
                )}
              </p>
            ) : (
              textBlocks.map((b) => (
                <FormField key={b.id} label={b.id}>
                  <Textarea
                    rows={4}
                    value={texts[b.id] ?? ""}
                    onChange={(e) =>
                      setTexts((prev) => ({ ...prev, [b.id]: e.target.value }))
                    }
                  />
                </FormField>
              ))
            )}
          </div>

          <div className="flex flex-col gap-1">
            <p className="font-medium text-sm text-text-primary">
              {t("documents.fields", "Fields the agent fills")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(template?.fields ?? []).map((f) => (
                <span
                  key={f.name}
                  className="rounded border border-border bg-bg-secondary px-2 py-0.5 font-mono text-text-secondary text-xs"
                >
                  {`${f.name}: ${f.type}${f.required ? " *" : ""}`}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* NOTE: `self-start` is what makes the sticky actually stick. A grid item stretches to the
            row height by default, so `sticky` has nothing to travel within and the preview scrolls
            away as soon as the form below it is longer than the viewport — which is exactly when it
            is being used.

            And `h-`, not `max-h-`, for the other half of the same fact: `self-start` also removes
            the stretch that WAS giving this column a height, so a ceiling leaves the box sitting at
            `min-h-96` and the iframe's `h-full` resolving against nothing. The document then
            rendered into 384px of a modal twice that tall. A definite height is what both `sticky`
            and the iframe need. */}
        <DocumentPreview
          state={preview}
          className="min-h-96 lg:sticky lg:top-0 lg:h-[70vh] lg:self-start"
        />
      </fieldset>
    </Modal>
  );
}
