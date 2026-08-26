import { Building2, ImageUp, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, FormField, Input, useToast } from "@/client/components";
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
  // Which OPENING of the editor this is. A save is slow enough for the operator to close the modal
  // and reopen it while the request is out, and `onSaved` closes whatever is open when it lands — so
  // without this an older save closes a modal the operator has just reopened and is typing into.
  // A number, like the preview's, so a template id cannot be passed here by mistake.
  //
  // Handed back on `onSaved` rather than compared here, and that is the whole point of it being a
  // prop: this component is the modal's BODY, so closing the editor unmounts it and reopening mounts
  // a new one. A guard this component owns freezes with the instance — the replaced card compares a
  // stale session against a stale ref of its own, finds them equal, and announces a save into the
  // editor the operator has just reopened. The parent stays mounted, so it is the only one that can
  // answer "is this still the opening on screen?".
  session?: number;
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
  const draft = form.draft;
  // The letterhead is the one form on this tab that is not a modal, so nothing else stands between
  // an unsaved edit and a click on another tab — or a tenant switch, which is a full reload. The
  // same `companyChanges` the save sends is what "unsaved" means here, so the two cannot disagree.
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

  // ONE write to the company block at a time — across all THREE of them, not one flag per control.
  //
  // Every route here answers with the WHOLE block: the profile save echoes it, and both logo routes
  // return it with their new key. So two writes in flight are decided by whichever ANSWERS last,
  // which is not necessarily the one that wrote last. An older response landing after a newer one
  // puts a superseded logoKey on screen — usually one whose file the newer write already deleted, so
  // the letterhead renders broken until somebody reloads — or puts back profile text that was just
  // replaced.
  //
  // Serialised rather than reconciled with a generation counter: each of these is a deliberate act
  // the operator expects to finish, and this is the same shape as creating from a starter. The flag
  // names WHICH one so its own button can show the spinner.
  //
  // The DISABLED CONTROLS are the whole mechanism. A matching `if (busy) return` inside each handler
  // was written first and then removed: a click is a discrete event, so React has already re-rendered
  // with the button disabled before a second one can be dispatched — and in the one case that would
  // beat that, two dispatches inside a single tick, the handler reads the same stale value the
  // render did and lets both through anyway. It guarded nothing that the button was not already
  // guarding, and mutation testing is what showed it.
  const [busy, setBusy] = useState<"profile" | "upload" | "remove" | null>(
    null,
  );
  const logoUrl = useCompanyLogoUrl(company?.logoKey, company?.logoVersion);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!company) return;
    // Every arrival goes through the same rule, including the ones this card caused: a logo write
    // answers with the whole company block, and a save echoes what we sent. Neither needs to be
    // marked as ours, because against the baseline they are already "nothing was typed" and land as
    // no-ops. (An earlier version DID mark them, and that mark is what hid the missing baseline
    // advance below.) The rule lives next door with its decision table.
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
    const sent = companyChanges(form);
    try {
      const { data, error } =
        await api.api.v1["tenant-settings"].company.put(sent);
      if (error || !data) {
        // The server's own words when it sent any: a letterhead field is refused for a character the
        // document fonts cannot print, and the refusal NAMES the field and the character. Six inputs
        // and a generic sentence leave the operator hunting for which one — and a toast that names
        // the field still makes them count down the form to find it.
        //
        // A sentence back means the refusal is about nothing this form renders (or there was no
        // server at all); null means it is already on the control and repeating it would be noise.
        //
        // `sent` against the CURRENT draft, read from the ref: the operator can type during the
        // request, and a refusal about a value they have already replaced belongs in a toast rather
        // than under a box that no longer holds it.
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
      // The text is now stored, so it becomes the baseline — see afterCompanySave. Anything typed
      // while the request was in flight stays, and stays unsaved.
      // Computed from the ref, not from the closed-over `form`: the operator can type during the
      // request, and the closure holds the snapshot from before it. Outside the updater, because a
      // state updater is expected to be pure and React runs it twice in development.
      const next = afterCompanySave(formRef.current, sent);
      const clean = Object.keys(companyChanges(next)).length === 0;
      setForm(next);
      onChanged(data.company);
      showToast(t("common.saved", "Saved."), "success");
      // Reported only when nothing is left unsaved. The line above deliberately KEEPS what was typed
      // during the request, and the parent closes the modal on this callback — so announcing the
      // save unconditionally threw those edits away, which is the one thing the preservation exists
      // to prevent.
      // `session` as captured when the request STARTED: it is the opening this save belongs to, and
      // the parent decides whether that opening is still the one on screen.
      if (clean) onSaved?.(session);
    } catch (e) {
      // Eden RESOLVES an HTTP error as `{ error }` and REJECTS on a transport failure — offline, a
      // reset connection. Only the first half was handled, so the second left the operator with a
      // button that did nothing and an unhandled rejection in the console.
      //
      // Through `capture` as well, so it stays the only writer of the held refusal. Measured: an
      // offline save on this route RESOLVES here (the branch above runs and already clears), so this
      // is not a path a mark was observed surviving — it is a path that could bypass the single
      // writer, and routing it costs one argument.
      const toast = refusal.capture(
        e,
        t("documents.company.saveError", "Could not save."),
        sent,
        formRef.current.draft,
      );
      showToast(
        toast ?? t("documents.company.saveError", "Could not save."),
        "error",
      );
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
    // The fallback names ONE of the three limits, and this route enforces three: the type, the byte
    // size, and the pixel count. That makes the generic sentence actively wrong for the third — a
    // 180 KB PNG at 8000x8000 is refused, and the operator is told to shrink a file that is already
    // well under the size it names. So the server's own refusal wins whenever there is one, and the
    // sentence below survives only for the case with no server behind it.
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

  // Both halves of a failure: Eden RESOLVES an HTTP error as `{ error }`, and the fetch can reject
  // outright. Neither said anything before — the logo simply stayed where it was, which reads as a
  // button that does not work.
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
    <Card className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Building2 className="h-4 w-4 text-accent" aria-hidden="true" />
        <h2 className="font-medium text-sm text-text-primary">
          {t("documents.company.title", "Company profile")}
        </h2>
        <span className="text-text-muted text-xs">
          {t(
            "documents.company.subtitle",
            "Printed on every document you issue.",
          )}
        </span>
      </div>

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
            error={refusal.at(field, draft[field])}
          >
            <Input
              value={draft[field]}
              onChange={(e) =>
                setForm((current) => ({
                  ...current,
                  draft: { ...current.draft, [field]: e.target.value },
                }))
              }
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
    </Card>
  );
}
