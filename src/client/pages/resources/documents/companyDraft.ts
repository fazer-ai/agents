import type { CompanyProfile } from "./CompanyProfileCard";

// Which of the letterhead's fields this form edits, and in which order they are shown.
export const COMPANY_FIELDS = [
  "name",
  "document",
  "address",
  "phone",
  "email",
  "website",
] as const;

export type CompanyDraft = Record<(typeof COMPANY_FIELDS)[number], string>;

// The form's whole state: the text in the inputs, and the copy that text was seeded FROM.
//
// The baseline separates "the operator typed" from "the server changed": the panel hands down a
// fresh `company` on every reload, so "the prop changed" says nothing, and comparing against the
// INCOMING copy keeps the draft in both cases and silently overwrites the other writer on Save. A
// blank form with a blank baseline is untouched by the same rule and adopts the first copy that
// arrives (all-blank cannot mean never-filled-in, since an operator may clear every field).
export interface CompanyDraftState {
  draft: CompanyDraft;
  seededFrom: CompanyDraft;
}

export function blankCompanyDraft(): CompanyDraft {
  return Object.fromEntries(COMPANY_FIELDS.map((f) => [f, ""])) as CompanyDraft;
}

// The stored profile as this form would hold it: every field present, a missing one as blank.
export function companyToDraft(company: CompanyProfile): CompanyDraft {
  return Object.fromEntries(
    COMPANY_FIELDS.map((f) => [f, company[f] ?? ""]),
  ) as CompanyDraft;
}

export function seedCompanyDraft(company: CompanyProfile): CompanyDraftState {
  const draft = companyToDraft(company);
  return { draft, seededFrom: draft };
}

// What the form holds before anything has arrived from the server.
export function emptyCompanyForm(): CompanyDraftState {
  return { draft: blankCompanyDraft(), seededFrom: blankCompanyDraft() };
}

// What a save should SEND: the fields this form actually changed, and no others.
//
// The whole draft would carry back everything it was loaded with, including a field another writer
// updated after this form was opened — a PUT that overwrites their value with a copy of the one it
// replaced, while the operator was editing something else entirely. Every field on the endpoint is
// optional and the service merges, so sending only what changed is what makes two people editing
// different halves of the profile a non-event.
export function companyChanges(form: CompanyDraftState): Partial<CompanyDraft> {
  return Object.fromEntries(
    COMPANY_FIELDS.filter((f) => form.draft[f] !== form.seededFrom[f]).map(
      (f) => [f, form.draft[f]],
    ),
  );
}

// What the form holds once a save succeeds: the same text, now baselined on what was SENT.
//
// Otherwise the form stays "typed in" after its first save and stops adopting anything, so a later
// Save overwrites another writer. The draft is deliberately NOT replaced by the echo: keystrokes
// made during the request stay, and stay marked as unsaved.
export function afterCompanySave(
  current: CompanyDraftState,
  sent: Partial<CompanyDraft>,
): CompanyDraftState {
  // MERGED over the previous baseline, not taken from the server's echo. The echo carries fields
  // another writer changed in the meantime, and adopting those as the baseline would mark them as
  // this operator's unsaved edits — freezing their stale copy in the form and sending it back on
  // the next save. What this request knows is what it changed; the rest stays where it was, so the
  // next arrival is free to land.
  return { ...current, seededFrom: { ...current.seededFrom, ...sent } };
}

// What the form becomes when a `company` arrives: the operator's unsaved text if there is any,
// otherwise the server's copy — which is how a change made elsewhere (another tab, REST, MCP)
// reaches a form nobody is editing.
export function nextCompanyDraft(
  current: CompanyDraftState,
  company: CompanyProfile,
): CompanyDraftState {
  const typedIn = COMPANY_FIELDS.some(
    (f) => current.draft[f] !== current.seededFrom[f],
  );
  return typedIn ? current : seedCompanyDraft(company);
}
