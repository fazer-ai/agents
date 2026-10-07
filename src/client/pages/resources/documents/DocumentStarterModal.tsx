import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Card,
  FormField,
  Input,
  Modal,
  type ModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";
import type { DocumentTemplate } from "./DocumentTemplateModal";

// Creating a document template from a starter: pick one, name it, create. One flow for every place
// that offers it (Components → Documents and the agent's Tools tab), so the two cannot drift apart.
// The caller owns the starter list (it decides when to load it and in which language) and what
// happens after a create; this owns the two steps and the request.

type StartersData = Awaited<
  ReturnType<(typeof api.api.v1)["document-templates"]["starters"]["get"]>
>["data"];
export type Starter = NonNullable<StartersData>["starters"][number];

// The keys of the create body. `name` is the one an operator can act on here — a duplicate answers
// with which template already holds it — and the rest come from the starter, not from an input.
const STARTER_FIELDS = ["name"] as const;

/** The language the starters are asked for, normalised to the two the starter table has. */
export function starterLocaleOf(language: string): "pt-BR" | "en-US" {
  return language.startsWith("pt") ? "pt-BR" : "en-US";
}

export function DocumentStarterModal({
  modal,
  starters,
  startersError,
  onCreated,
}: {
  modal: ModalController;
  starters: Starter[];
  startersError: boolean;
  onCreated: (template: DocumentTemplate) => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [creating, setCreating] = useState<string | null>(null);
  // Which starter is being named, and what the server said about the last attempt. Both belong to
  // the dialog, and both are cleared when it reopens.
  const [naming, setNaming] = useState<Starter | null>(null);
  const [draftName, setDraftName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const draftRef = useRef(draftName);
  draftRef.current = draftName;
  // The dialog has two steps and only the second draws a name box: the first is the starter list.
  const refusal = useFieldRefusal(modal.isOpen && naming ? STARTER_FIELDS : []);

  // The dialog has two steps, so reopening it has to land on the first one. `useOnModalOpen` fires
  // on every false→true transition, which is the event this belongs to: the controller keeps its
  // payload after close (Radix needs it for the exit animation), so an operator who cancels on the
  // naming step and reopens would otherwise be handed that step again, prefilled with the name they
  // just abandoned (docs/modals.md).
  useOnModalOpen(modal, () => {
    // The component outlives the dialog, so a mark from the last session is still held here.
    refusal.clear();
    setNaming(null);
    setDraftName("");
    setCreateError(null);
  });

  // A starter carries its language and currency, so one picked before the list was replaced (the
  // operator switched language) is no longer on offer: the dialog goes back to the list.
  useEffect(() => {
    if (
      naming &&
      !starters.some(
        (s) => s.key === naming.key && s.style.locale === naming.style.locale,
      )
    )
      setNaming(null);
  }, [naming, starters]);

  // Names are unique per account and the name is what the agent's tool is called, so it is asked for
  // HERE rather than defaulted and repaired later. The starter's own name is the suggestion; a second
  // quote is "Orçamento de instalação", not a numbered copy of the first.
  async function createFromStarter(starter: Starter, name: string) {
    setCreating(starter.key);
    setCreateError(null);
    try {
      const sent = {
        name,
        // The template's own, which the blank starter leaves empty: the menu's summary describes the
        // starter, and a template's description is appended to the agent's tool description.
        description: starter.description,
        blocks: starter.blocks as Record<string, unknown>[],
        fields: starter.fields as Record<string, unknown>[],
        style: starter.style as unknown as Record<string, unknown>,
        numberPrefix: starter.numberPrefix,
      };
      const { data, error: err } =
        await api.api.v1["document-templates"].post(sent);
      if (err) {
        // The server's own words, and the input they are about. It says which template already has
        // the name, which a generic "could not create" cannot — and the operator is three characters
        // away from fixing it. `capture` decides where it goes: the name box when the refusal is
        // about the name, this line when it is about the starter's own blocks or style, which no
        // control here edits.
        setCreateError(
          refusal.capture(
            err,
            t("documents.createError", "Could not create this template."),
            sent,
            { ...sent, name: draftRef.current.trim() },
          ),
        );
        return;
      }
      refusal.clear();
      modal.close();
      showToast(t("documents.created", "Template created."), "success");
      if (data?.template) onCreated(data.template);
    } catch (e) {
      // NOTE: Eden REJECTS on a transport failure instead of answering `{ error }`, so an offline
      // create lands here.
      setCreateError(
        refusal.capture(
          e,
          t("documents.createError", "Could not create this template."),
          { name },
          { name: draftRef.current.trim() },
        ),
      );
    } finally {
      setCreating(null);
    }
  }

  return (
    <Modal
      modal={modal}
      title={
        naming
          ? t("documents.nameTitle", "Name this template")
          : t("documents.starterPickTitle", "Choose a starting point")
      }
      // Dismissing mid-create would leave a request in flight whose result the operator can no
      // longer see, and the template it creates would then appear with no explanation. It is also
      // what keeps this dialog from being REOPENED while a request from the previous opening is
      // still out — the case that would otherwise need a session token, and does not, because it
      // cannot happen.
      onCloseRequest={creating ? () => undefined : undefined}
    >
      {naming ? (
        <div className="flex flex-col gap-3">
          {/* The name is asked for, not defaulted: it is what the agent's tool is called and what
              the model reads to choose between documents, so two templates cannot share one. The
              starter's name is the suggestion. */}
          <p className="text-sm text-text-muted">
            {t(
              "documents.nameHint",
              "This is what the agent's tool is called, so each template needs its own name.",
            )}
          </p>
          <FormField
            label={t("documents.name", "Name")}
            error={refusal.at("name", draftName.trim())}
          >
            <Input
              autoFocus
              value={draftName}
              placeholder={t(
                "documents.namePlaceholder",
                "e.g. Service agreement",
              )}
              onChange={(e) => {
                setDraftName(e.target.value);
                setCreateError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draftName.trim() && !creating) {
                  void createFromStarter(naming, draftName.trim());
                }
              }}
            />
          </FormField>
          {createError && <p className="text-sm text-warning">{createError}</p>}
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              disabled={creating !== null}
              onClick={() => {
                setNaming(null);
                setCreateError(null);
              }}
            >
              {t("common.back", "Back")}
            </Button>
            <Button
              loading={creating !== null}
              disabled={!draftName.trim() || creating !== null}
              onClick={() => void createFromStarter(naming, draftName.trim())}
            >
              {t("documents.create", "Create")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-muted">
            {t(
              "documents.starterBuildHint",
              "Pick one to copy into your account, then edit its wording here. New fields and blocks are added by asking your AI assistant connected over MCP.",
            )}
          </p>
          {startersError && (
            <p className="text-sm text-warning">
              {t(
                "documents.startersError",
                "Could not load the ready-made templates.",
              )}
            </p>
          )}
          {starters.map((s) => (
            <Card
              key={s.key}
              className="flex items-center justify-between gap-4"
            >
              <div className="min-w-0">
                <p className="font-medium text-sm text-text-primary">
                  {s.name}
                </p>
                <p className="text-text-muted text-xs">{s.summary}</p>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setNaming(s);
                  setDraftName(s.suggestedName);
                  setCreateError(null);
                }}
              >
                {t("documents.use", "Use")}
              </Button>
            </Card>
          ))}
        </div>
      )}
    </Modal>
  );
}
