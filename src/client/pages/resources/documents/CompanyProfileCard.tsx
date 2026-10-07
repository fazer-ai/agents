import { ImageUp, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, FormField, Input, useToast } from "@/client/components";
import { useNavGuard } from "@/client/contexts/NavGuardContext";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import {
  afterCompanySave,
  companyChanges,
  emptyCompanyForm,
  COMPANY_FIELDS as FIELDS,
  nextCompanyDraft,
} from "./companyDraft";
import { useCompanyLogoUrl } from "./useCompanyLogoUrl";

// The letterhead every issued document carries: name, tax id, address, contacts and a logo. It lives
// on this tab rather than in Settings because it exists only to feed documents, and an operator
// setting up their first template should not have to go find it.

type SettingsData = Awaited<
  ReturnType<(typeof api.api.v1)["tenant-settings"]["get"]>
>["data"];
export type CompanyProfile = NonNullable<SettingsData>["company"];

export function CompanyProfileCard({
  company,
  onChanged,
  onSaved,
  onDirtyChange,
  session,
  suggestedName,
}: {
  company: CompanyProfile | null;
  onChanged: (next: CompanyProfile) => void;
  // Fired only by a PROFILE save, which is what the modal closes on. Deliberately not `onChanged`:
  // that one also fires for a logo upload, and closing the letterhead editor because a picture
  // finished uploading takes the form away mid-edit.
  // Carries the OPENING it belongs to, because only the parent can judge that (see `session`).
  onSaved?: (session?: number) => void;
  // Reported out so the modal can guard its own close with the same answer the nav guard uses. One
  // definition of "unsaved", or the dialog warns about edits the save would not send.
  onDirtyChange?: (dirty: boolean) => void;
  // Which OPENING of the editor this is, so a slow save does not close a modal the operator has
  // since reopened. Handed back on `onSaved` rather than compared here: this component is the
  // modal's BODY and remounts per opening, so a guard it owned would compare stale against stale;
  // only the parent, which stays mounted, can tell. A number, so a template id cannot be passed.
  session?: number;
  // The company name the account was set up with, offered while the profile has none. Typed into the
  // form rather than saved, so the letterhead still says only what the operator confirmed.
  suggestedName?: string | null;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  // Carries the copy it was seeded from, which is what separates "typed in" from "changed
  // elsewhere". See nextCompanyDraft.
  const [form, setForm] = useState(emptyCompanyForm);
  // The CURRENT form, readable from inside a request that started before it. Kept in step on every
  // render rather than only where it is read, so it can never be one keystroke behind.
  const formRef = useRef(form);
  formRef.current = form;
  // The account's name, SHOWN in an empty name box until the operator types there or the stored
  // profile gets a name. Kept out of the draft, so the form still reads as untouched and adopts a
  // profile another client saves meanwhile; it joins what Save sends while it is on screen.
  const [nameTouched, setNameTouched] = useState(false);
  const suggestion = suggestedName?.trim() ?? "";
  // Checked against the LATEST stored profile too: a draft kept for an edit in another field still
  // carries the old empty name after another client saves one.
  const suggesting = (f: typeof form) =>
    !nameTouched &&
    suggestion !== "" &&
    !company?.name?.trim() &&
    f.draft.name === "" &&
    f.seededFrom.name === "";
  const shown = (f: typeof form) =>
    suggesting(f) ? { ...f, draft: { ...f.draft, name: suggestion } } : f;
  // What the operator typed is what "unsaved" means for the nav guard (a click on another tab, a
  // tenant switch) and for the modal's close. A suggestion nobody typed is not an edit to lose, so
  // opening the letterhead and closing it again asks nothing.
  const dirty = Object.keys(companyChanges(form)).length > 0;
  // The six patch keys ARE the six names the server refuses by: `updateCompanySettings` names the key
  // of the patch it rejected, and that key was chosen to be this form's input name. Declared from the
  // same constant the inputs are rendered from, so a seventh field cannot be added to one and not the
  // other.
  const refusal = useFieldRefusal(FIELDS);
  useNavGuard(dirty);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // ONE write to the company block at a time, across all three routes: each answers with the
  // WHOLE block, so with two in flight the last to ANSWER wins, which can put back a superseded
  // logoKey (whose file is already deleted) or replaced text. Serialised rather than reconciled
  // with a generation counter, since each is a deliberate act; the flag names WHICH one for the
  // spinner. The DISABLED CONTROLS are the mechanism: an `if (busy)` in the handler would read the
  // same stale value the render did and guard nothing more.
  const [busy, setBusy] = useState<"profile" | "upload" | "remove" | null>(
    null,
  );
  const logoUrl = useCompanyLogoUrl(company?.logoKey, company?.logoVersion);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!company) return;
    // NOTE: every arrival goes through the same rule, including the ones this card caused (a logo
    // write's block, a save's echo): against the baseline they are "nothing was typed" and land as
    // no-ops, so none needs marking as ours. The rule lives in `companyDraft.ts`.
    setForm((current) => nextCompanyDraft(current, company));
  }, [company]);

  const label: Record<(typeof FIELDS)[number], string> = {
    name: t("documents.company.name", "Company name"),
    document: t("documents.company.document", "Tax id"),
    address: t("documents.company.address", "Address"),
    phone: t("documents.company.phone", "Phone"),
    email: t("documents.company.email", "Email"),
    website: t("documents.company.website", "Website"),
  };

  async function save() {
    setBusy("profile");
    // Only what this form changed, captured before the await: the operator can type during it, and
    // a field they never touched is not this request's to write.
    // A suggestion on screen is saved as if typed, so it becomes the operator's from here on.
    if (suggesting(formRef.current)) {
      formRef.current = shown(formRef.current);
      setForm(formRef.current);
      setNameTouched(true);
    }
    const sent = companyChanges(formRef.current);
    try {
      const { data, error } =
        await api.api.v1["tenant-settings"].company.put(sent);
      if (error || !data) {
        // The server's refusal NAMES the field and the character the document fonts cannot
        // print, so it goes on that control. A sentence back means nothing this form renders (or no
        // server at all); null means it is already on the control. `sent` is compared with the
        // CURRENT draft (the ref), so a refusal about a value already replaced goes to a toast.
        const toast = refusal.capture(
          error,
          t("documents.company.saveError", "Could not save."),
          sent,
          formRef.current.draft,
        );
        if (toast) showToast(toast, "error");
        return;
      }
      refusal.clear();
      // The stored text becomes the baseline (`afterCompanySave`); text typed during the
      // request stays unsaved. From the ref, not the closed-over `form`, and outside the updater,
      // which React expects to be pure and runs twice in development.
      const next = afterCompanySave(formRef.current, sent);
      const clean = Object.keys(companyChanges(next)).length === 0;
      setForm(next);
      onChanged(data.company);
      showToast(t("common.saved", "Saved."), "success");
      // NOTE: reported only when nothing is left unsaved: the parent closes the modal on this
      // callback, which would discard what was typed during the request.
      // `session` as captured when the request STARTED: it is the opening this save belongs to, and
      // the parent decides whether that opening is still the one on screen.
      if (clean) onSaved?.(session);
    } catch (e) {
      // Eden RESOLVES an HTTP error as `{ error }` and REJECTS on a transport failure. This
      // goes through `capture` too, so it stays the only writer of the held refusal.
      const toast = refusal.capture(
        e,
        t("documents.company.saveError", "Could not save."),
        sent,
        formRef.current.draft,
      );
      // `if (toast)`, never `toast ?? fallback`: null is the hook saying the operator has already
      // been told — the sentence is on the control, or, for a form that has left the screen, in the
      // global toast it raised itself. Substituting a fallback there fires the second channel on top
      // of the first, which is the noise that teaches people to stop reading toasts.
      if (toast) showToast(toast, "error");
    } finally {
      setBusy(null);
    }
  }

  // The logo routes answer with the WHOLE company block. Handing it to `onChanged` replaces the
  // `company` prop, and the draft rule decides what happens to the text on its own: unsaved text
  // survives, an untouched form takes the block as it came. Nothing here has to say "this one was
  // mine".
  function applyLogoOnly(next: CompanyProfile) {
    onChanged(next);
  }

  async function upload(file: File) {
    // The server's refusal wins whenever there is one: this route enforces type, byte size
    // AND pixel count, and the fallback names only the size (wrong for an 8000x8000 180 KB PNG).
    const failed = (e?: unknown) =>
      showToast(
        apiErrorMessage(e) ||
          t(
            "documents.company.logoError",
            "Could not upload. The logo must be a PNG or JPEG under 512 KB.",
          ),
        "error",
      );
    setBusy("upload");
    try {
      const { data, error } = await api.api.v1[
        "tenant-settings"
      ].company.logo.post({ file });
      if (error || !data) return failed(error);
      applyLogoOnly(data.company);
    } catch (e) {
      failed(e);
    } finally {
      setBusy(null);
    }
  }

  // Both halves of a failure are reported: Eden RESOLVES an HTTP error as `{ error }`, and the
  // fetch can reject outright. Silent, the logo stays put and the button reads as broken.
  async function removeLogo() {
    setBusy("remove");
    try {
      const { data, error } =
        await api.api.v1["tenant-settings"].company.logo.delete();
      if (error || !data) {
        showToast(
          apiErrorMessage(error) ||
            t(
              "documents.company.logoRemoveError",
              "Could not remove the logo.",
            ),
          "error",
        );
        return;
      }
      applyLogoOnly(data.company);
    } catch {
      showToast(
        t("documents.company.logoRemoveError", "Could not remove the logo."),
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    // The modal around it carries the title, so the body opens on what the profile is for.
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        {t(
          "documents.company.subtitle",
          "Printed on every document you issue.",
        )}
      </p>

      {/* ONE PER LINE, deliberately. This card lives in a `md` modal (max-w-md), so a second
          column leaves each input under 200px — and the six fields are not the same length:
          an address and a website need the room that a phone and a tax id do not. Paired,
          they all get the short one's width. */}
      <div className="grid gap-3">
        {FIELDS.map((field) => (
          <FormField
            key={field}
            label={label[field]}
            // The value the mark is keyed on: the message shows while this box still holds what the
            // server refused, and stops the keystroke it changes. No `onChange` line to forget.
            error={refusal.at(field, shown(form).draft[field])}
          >
            <Input
              value={shown(form).draft[field]}
              onChange={(e) => {
                if (field === "name") setNameTouched(true);
                setForm((current) => ({
                  ...current,
                  draft: { ...current.draft, [field]: e.target.value },
                }));
              }}
            />
          </FormField>
        ))}
      </div>

      <FormField label={t("documents.company.logo", "Logo")} group>
        <div className="flex items-center gap-3">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={t("documents.company.logo", "Logo")}
              className="h-10 max-w-32 object-contain"
            />
          ) : (
            <span className="text-sm text-text-muted">
              {t("documents.company.noLogo", "No logo")}
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
              e.target.value = "";
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={busy !== null}
            loading={busy === "upload"}
            onClick={() => fileRef.current?.click()}
          >
            <ImageUp className="h-4 w-4" aria-hidden="true" />
            {t("documents.company.uploadLogo", "Upload")}
          </Button>
          {company?.logoKey && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              loading={busy === "remove"}
              onClick={removeLogo}
              aria-label={t("common.delete", "Delete")}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
      </FormField>

      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={save}
          disabled={busy !== null}
          loading={busy === "profile"}
        >
          {t("common.save", "Save")}
        </Button>
      </div>
    </div>
  );
}
