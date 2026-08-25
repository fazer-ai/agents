import {
  Building2,
  FileCheck,
  FileText,
  Link2,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AgentRef,
  AgentReferences,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  EmptyState,
  FormField,
  Input,
  Modal,
  Tabs,
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { mediaFetch } from "@/client/lib/media";
import { type CompanyProfile, CompanyProfileCard } from "./CompanyProfileCard";
import {
  type DocumentTemplate,
  DocumentTemplateModal,
} from "./DocumentTemplateModal";

type StartersData = Awaited<
  ReturnType<(typeof api.api.v1)["document-templates"]["starters"]["get"]>
>["data"];
type Starter = NonNullable<StartersData>["starters"][number];

type IssuedData = Awaited<
  ReturnType<(typeof api.api.v1)["documents"]["get"]>
>["data"];
type IssuedDocument = NonNullable<IssuedData>["documents"][number];

// The line under the company name in the summary row: what is filled in, in the order it prints on
// the page. Empty when nothing is, which is what makes the row read as an invitation rather than as
// a broken value.
function companySummary(
  company: CompanyProfile | null,
  t: (key: string, fallback: string) => string,
): string {
  if (!company) return "";
  const parts = [company.document, company.address, company.phone].filter(
    (v): v is string => !!v?.trim(),
  );
  if (company.logoKey) parts.push(t("documents.company.hasLogo", "with logo"));
  return parts.join(" · ");
}

// The message the API actually sent, when there is one. Eden hands an HTTP failure back as
// `{ error }` whose `value` is the parsed body, and a refusal here is written for the operator (which
// template has the name, which rule the name breaks) — throwing it away for a generic string is how
// a fixable mistake becomes a dead end.
export function DocumentsPanel() {
  const { t, i18n } = useTranslation();
  // The route defaults an absent locale to pt-BR, so an English console would create Portuguese
  // starters — names, wording and currency — without ever offering a choice. Normalised because the
  // route takes the two the starter table has, and the browser can hand us "en", "en-GB", "pt".
  const starterLocale = i18n.language.startsWith("pt") ? "pt-BR" : "en-US";
  const { showToast } = useToast();
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [starters, setStarters] = useState<Starter[]>([]);
  const [issued, setIssued] = useState<IssuedDocument[]>([]);
  const [company, setCompany] = useState<CompanyProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // The two secondary lists get their own flags rather than taking the whole page down: an operator
  // can still edit templates when the starter list or the recent-documents list failed — they just
  // must not be told those are empty.
  const [startersError, setStartersError] = useState(false);
  const [issuedError, setIssuedError] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  // Which starter is being named, and what the server said about the last attempt. Both belong to
  // the dialog, and both are cleared when it reopens.
  const [naming, setNaming] = useState<Starter | null>(null);
  const [draftName, setDraftName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // null = still loading, "error" = the lookup failed. Two states, because collapsing them leaves a
  // dialog claiming to be checking something it has already given up on.
  const [refs, setRefs] = useState<AgentRef[] | "error" | null>(null);
  const [deleteRefs, setDeleteRefs] = useState<AgentRef[] | "error" | null>(
    null,
  );

  // Which half of the screen is showing. Local, not routed: the two are one resource seen two ways,
  // and a URL for "the issued list" is a promise to keep it addressable that nothing else here makes.
  const [tab, setTab] = useState<"templates" | "issued">("templates");
  // Reported by the letterhead form so its modal can guard its own close with the same answer the
  // nav guard uses.
  const [companyDirty, setCompanyDirty] = useState(false);
  // One per opening of the letterhead editor, so a save that lands after the operator closed and
  // reopened it does not close the modal they are typing into now.
  const [companySession, setCompanySession] = useState(0);
  // The same number, in a ref, and the ref is the half that works. The card is the modal's body, so
  // it unmounts on close and a new one mounts on reopen — and the stale card also holds a stale copy
  // of the callback below, closed over the OLD `companySession`. Reading the generation off a ref
  // instead means the stale closure still reaches the current value, because the ref OBJECT is what
  // it captured.
  const companySessionRef = useRef(0);

  const editModal = useModalController<{ template: DocumentTemplate }>();
  const companyModal = useModalController();
  const starterModal = useModalController();
  const refsModal = useModalController<{ name: string }>();
  const deleteModal = useModalController<{ id: string; name: string }>();
  const confirm = useModalController<ConfirmPayload>();

  // `loading` and `error` are both the FIRST load only, and for one reason: this panel reloads
  // itself constantly — after a template is saved or deleted, after a starter is used, whenever the
  // operator switches language — while the company profile below is an open form somebody may be
  // typing into. The card sits inside a boundary keyed on these flags, so either one taking the
  // screen away discards the edit and the guard that would have warned about leaving it, over an
  // action that had nothing to do with it. A refresh replaces the data underneath; it does not take
  // the screen away, and a refresh that FAILS says so without taking it away either.
  //
  // It means "a load has SUCCEEDED", not "a load has finished": set after the setters below, not in
  // `finally`. A failed first load leaves nothing on screen, and there the retry card IS the answer
  // — including for its own retry, which must show a skeleton rather than an empty account.
  const loadedOnce = useRef(false);
  // Which load is the CURRENT one. `load` is re-created when the operator switches language, and the
  // starters are the one thing here whose content is locale-specific — so two loads can be in flight
  // with different answers to the same question, and the one that resolves LAST wins the screen. An
  // older list landing after a newer one leaves the operator creating a template in the language
  // they just switched away from, permanently and with no sign anything went wrong.
  const loadSeq = useRef(0);
  // How many times the company block has been WRITTEN from this screen. A load reads four endpoints
  // at once and applies them together, so its settings response can be a snapshot taken before a
  // save or a logo upload that has since answered — and applying it then puts the operator's own
  // change back to what it replaced, on screen, with nothing saying so. The load generation does not
  // cover this: no newer load started, a different request answered.
  const companyWrites = useRef(0);
  const applyCompany = useCallback((next: CompanyProfile) => {
    companyWrites.current++;
    setCompany(next);
  }, []);
  // Where a failed load is reported, which depends entirely on whether there is anything on screen
  // to lose. With nothing loaded, the retry card is the only thing that can say the panel is empty
  // because a request failed rather than because the account is.
  //
  // `reason` is the response that failed, and it is passed rather than read here because the caller
  // is the only one that knows WHICH of the four requests refused. Absent from the `catch` on
  // purpose: Eden resolves a transport failure, so that one holds a fault of ours, with no sentence
  // of the server's in it.
  const failed = useCallback(
    (reason?: unknown) => {
      if (loadedOnce.current) {
        showToast(
          apiErrorMessage(reason) ||
            t("documents.refreshError", "Could not refresh this page."),
          "error",
        );
        return;
      }
      setError(true);
    },
    [showToast, t],
  );
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const writes = companyWrites.current;
    const current = () => seq === loadSeq.current;
    if (!loadedOnce.current) setLoading(true);
    setError(false);
    try {
      const [list, startersRes, settings, issuedRes] = await Promise.all([
        api.api.v1["document-templates"].get(),
        api.api.v1["document-templates"].starters.get({
          query: { locale: starterLocale },
        }),
        api.api.v1["tenant-settings"].get(),
        api.api.v1.documents.get({ query: { limit: "20" } }),
      ]);
      // Every request's error, not just the list's. Eden RESOLVES an HTTP failure as `{ error }`
      // rather than rejecting, so an unchecked call reads as empty data: a settings failure rendered
      // a blank editable profile over settings that may well have values, and a starters or
      // documents failure showed "none" for a list that failed to load.
      // Superseded: a newer load started while this one was in flight, so every setter below would
      // be writing an answer to a question nobody is asking any more.
      if (!current()) return;
      if (list.error || !list.data || settings.error) {
        failed(list.error ?? settings.error);
        return;
      }
      setTemplates([...list.data.templates]);
      setStarters(startersRes.data ? [...startersRes.data.starters] : []);
      setStartersError(!!startersRes.error);
      // …unless this screen wrote the block while the load was out, in which case what it holds is
      // newer than what just arrived.
      if (companyWrites.current === writes) {
        setCompany(settings.data?.company ?? null);
      }
      setIssued(issuedRes.data ? [...issuedRes.data.documents] : []);
      setIssuedError(!!issuedRes.error);
      loadedOnce.current = true;
    } catch {
      if (current()) failed();
    } finally {
      if (current()) setLoading(false);
    }
    // Reloads when the operator switches language: the starters are the one thing on this panel
    // whose CONTENT is locale-specific.
  }, [starterLocale, failed]);

  useEffect(() => {
    void load();
  }, [load]);

  // The dialog has two steps, so reopening it has to land on the first one. `useOnModalOpen` fires
  // on every false→true transition, which is the event this belongs to: the controller keeps its
  // payload after close (Radix needs it for the exit animation), so an operator who cancels on the
  // naming step and reopens would otherwise be handed that step again, prefilled with the name they
  // just abandoned (docs/modals.md).
  useOnModalOpen(starterModal, () => {
    setNaming(null);
    setDraftName("");
    setCreateError(null);
  });

  // Names are unique per account and the name is what the agent's tool is called, so it is asked for
  // HERE rather than defaulted and repaired later. The starter's own name is the suggestion; a second
  // quote is "Orçamento de instalação", not a numbered copy of the first.
  async function createFromStarter(starter: Starter, name: string) {
    setCreating(starter.key);
    setCreateError(null);
    try {
      const { error: err } = await api.api.v1["document-templates"].post({
        name,
        description: starter.description,
        blocks: starter.blocks as Record<string, unknown>[],
        fields: starter.fields as Record<string, unknown>[],
        style: starter.style as unknown as Record<string, unknown>,
        numberPrefix: starter.numberPrefix,
      });
      if (err) {
        // The server's own words, shown next to the field that caused them. It says which template
        // already has the name, which a generic "could not create" cannot — and the operator is
        // three characters away from fixing it.
        setCreateError(apiErrorMessage(err));
        return;
      }
      starterModal.close();
      showToast(t("documents.created", "Template created."), "success");
      void load();
    } catch {
      // Eden REJECTS on a transport failure instead of answering `{ error }`, and only the second
      // was handled: offline, the button spun and then said nothing at all.
      setCreateError(
        t("documents.createError", "Could not create this template."),
      );
    } finally {
      setCreating(null);
    }
  }

  // `null` is the LOADING state for both dialogs, so a failure must not answer with it: the delete
  // dialog would sit on "Checking…" with Confirm disabled forever, explaining nothing and offering
  // no way out. An empty list is a real answer ("nothing uses it"); a failure is its own.
  async function loadRefs(id: string): Promise<AgentRef[] | "error"> {
    try {
      const { data, error: err } = await api.api.v1["document-templates"]({
        id,
      }).references.get();
      if (err || !data) return "error";
      return [...data.references.agents];
    } catch {
      return "error";
    }
  }

  // A session token per modal open. The lookup is slow enough for an operator to close one template
  // and open another before it returns, and an unconditional assignment then shows template A's
  // agents under template B's name — in the DELETE dialog that is a wrong warning about what the
  // deletion breaks, which is the one place the operator is relying on it (docs/modals.md).
  const refsSession = useRef(0);
  const deleteSession = useRef(0);

  async function openRefs(tpl: DocumentTemplate) {
    const session = ++refsSession.current;
    setRefs(null);
    refsModal.open({ name: tpl.name });
    const loaded = await loadRefs(tpl.id);
    if (session === refsSession.current) setRefs(loaded);
  }

  async function askDelete(tpl: DocumentTemplate) {
    const session = ++deleteSession.current;
    setDeleteRefs(null);
    deleteModal.open({ id: tpl.id, name: tpl.name });
    const loaded = await loadRefs(tpl.id);
    if (session === deleteSession.current) setDeleteRefs(loaded);
  }

  async function confirmDelete() {
    const id = deleteModal.payload?.id;
    if (!id) return;
    setDeleting(true);
    try {
      const { error: err } = await api.api.v1["document-templates"]({
        id,
      }).delete();
      if (err) {
        showToast(
          apiErrorMessage(err) ||
            t("documents.deleteError", "Could not delete."),
          "error",
        );
        return;
      }
      showToast(t("documents.deleted", "Deleted."), "success");
      deleteModal.close();
      void load();
    } catch {
      showToast(t("documents.deleteError", "Could not delete."), "error");
    } finally {
      setDeleting(false);
    }
  }

  // A blob URL rather than a link to the endpoint. The PDF route is tenant-scoped, and for a
  // SUPER_ADMIN the tenant lives ONLY in the X-Tenant-Id header — which a plain navigation cannot
  // send, so the tab would land on "a target tenant is required" instead of the document. Same fix
  // the logo and the preview already use.
  //
  // The tab is opened SYNCHRONOUSLY, inside the click, and pointed at the blob afterwards. Opening
  // it after the await spends the browser's transient user activation on a fetch, and the popup
  // blocker then swallows the call: the button downloads the bytes and appears to do nothing.
  async function openPdf(doc: IssuedDocument) {
    // No `noopener` FEATURE here: by spec it makes window.open return null, which would leave a real
    // blank tab open with no handle to point at the blob — and the fallback would then navigate the
    // console itself away while that tab sat there empty. The handle is kept and `opener` is severed
    // on it instead, which is the same protection without losing the tab.
    const tab = window.open("", "_blank");
    if (tab) tab.opener = null;
    // The fetch can REJECT — offline, DNS, a dropped connection — and not merely answer non-OK. That
    // path skipped the branch below entirely, leaving the tab we just opened blank forever and the
    // operator with no message at all: a button that visibly does nothing.
    let url: string;
    try {
      const res = await mediaFetch(`/api/v1/documents/${doc.id}/pdf`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      url = URL.createObjectURL(await res.blob());
    } catch {
      tab?.close();
      showToast(
        t("documents.openPdfError", "Could not open the PDF."),
        "error",
      );
      return;
    }
    if (tab) {
      tab.location.href = url;
    } else {
      // The popup blocker refused even the synchronous open. Navigating this tab is better than a
      // button that silently does nothing.
      window.location.href = url;
    }
    // The tab has the bytes by the time it paints; holding the handle any longer leaks it for as
    // long as the console stays open.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  // Asked first, because there is no un-revoke. The PDF stops being served, and the agent's
  // idempotency key is derived from the VALUES, so every later send of the same document resolves
  // to this revoked row rather than issuing a fresh one — an accidental click on a row in a list is
  // permanent, and it takes the customer's copy with it.
  function askRevoke(doc: IssuedDocument) {
    confirm.open({
      title: t("documents.revokeTitle", "Revoke document"),
      message: t(
        "documents.revokeMessage",
        'Revoke "{{name}}"? Its PDF stops being served and this cannot be undone.',
        { name: doc.number ?? doc.title },
      ),
      danger: true,
      confirmLabel: t("documents.revoke", "Revoke"),
      onConfirm: () => revoke(doc),
    });
  }

  async function revoke(doc: IssuedDocument) {
    try {
      const { error: err } = await api.api.v1
        .documents({ id: doc.id })
        .revoke.post();
      if (err) throw err;
    } catch (e) {
      showToast(
        apiErrorMessage(e) || t("documents.revokeError", "Could not revoke."),
        "error",
      );
      // Rethrown so the confirm dialog stays OPEN on failure, per its own contract: a revoke worth
      // asking about is worth retrying without hunting the row down in the list again. Eden
      // RESOLVES an HTTP error as `{ error }` and REJECTS on a transport failure, so both halves
      // land here.
      throw e;
    }
    showToast(t("documents.revoked", "Revoked."), "success");
    void load();
  }

  // Which template each issued document came from. The issued list carries `templateId`, not the
  // name, and the panel already has the templates — so the join is here rather than a column on the
  // row. A document OUTLIVES its template (the FK nulls the id on delete), so the miss is a real
  // state, not a loading one, and it says so instead of showing a blank.
  const templateNames = new Map(templates.map((tpl) => [tpl.id, tpl.name]));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-muted">
          {t(
            "documents.subtitle",
            "Quotes, proposals and receipts your agents can issue and attach to a reply.",
          )}
        </p>
        {tab === "templates" && (
          <Button size="sm" onClick={() => starterModal.open()}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("documents.add", "New template")}
          </Button>
        )}
      </div>

      {/* Two things live on this screen and only one of them is configuration. A template is authored
          once and granted; an issued document is a RECORD, read when somebody asks about a document
          the customer already has. Stacking the second under the first made the page read as one
          long list, and it is the reason the letterhead — edited once and forgotten — sat above the
          thing the page is named after. */}
      <Tabs
        items={[
          {
            key: "templates",
            label: t("documents.tabs.templates", "Templates"),
            icon: FileText,
          },
          {
            key: "issued",
            label: t("documents.tabs.issued", "Issued"),
            icon: FileCheck,
          },
        ]}
        value={tab}
        onChange={(k) => setTab(k as typeof tab)}
        aria-label={t("resources.tabs.documents", "Document templates")}
      />

      {tab === "templates" ? (
        <>
          {/* A summary, not the form. The letterhead is filled once and then forgotten, so an open
              editable form at the top of the page spent the first screenful on the thing that
              changes least — and being open is also what made a background refresh able to discard
              what somebody was typing into it. In a modal it cannot. */}
          <DataBoundary loading={loading} error={error} onRetry={load}>
            <Card className="flex items-center justify-between gap-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <Building2
                  className="h-4 w-4 shrink-0 text-accent"
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="truncate font-medium text-sm text-text-primary">
                    {company?.name?.trim() ||
                      t("documents.company.unset", "No letterhead yet")}
                  </p>
                  <p className="truncate text-text-muted text-xs">
                    {companySummary(company, t)}
                  </p>
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  companySessionRef.current += 1;
                  setCompanySession(companySessionRef.current);
                  companyModal.open();
                }}
              >
                {company?.name?.trim()
                  ? t("common.edit", "Edit")
                  : t("documents.company.fill", "Fill in")}
              </Button>
            </Card>
          </DataBoundary>

          <DataBoundary
            loading={loading}
            error={error}
            isEmpty={templates.length === 0}
            onRetry={load}
            empty={
              <EmptyState
                icon={FileText}
                title={t("documents.emptyTitle", "No document templates yet")}
                description={t(
                  "documents.emptyDesc",
                  "Start from a ready-made quote, proposal or receipt, then edit the wording.",
                )}
                action={
                  <Button size="sm" onClick={() => starterModal.open()}>
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    {t("documents.add", "New template")}
                  </Button>
                }
              />
            }
          >
            <div className="flex flex-col gap-3">
              {templates.map((tpl) => (
                <Card
                  key={tpl.id}
                  className="flex items-center justify-between gap-4"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-text-primary">
                        {tpl.name}
                      </span>
                      <Badge variant="secondary">{tpl.toolName}</Badge>
                      {!tpl.enabled && (
                        <Badge variant="secondary">
                          {t("common.disabled", "Disabled")}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-text-muted text-xs">
                      {tpl.description ??
                        t("documents.blockCount", "{{count}} blocks", {
                          count: tpl.blocks.length,
                        })}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => openRefs(tpl)}
                    >
                      <Link2 className="h-4 w-4" aria-hidden="true" />
                      {t("resources.usage", "Usage")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => editModal.open({ template: tpl })}
                    >
                      {t("common.edit", "Edit")}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => askDelete(tpl)}
                      aria-label={t("common.delete", "Delete")}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </DataBoundary>
        </>
      ) : (
        <DataBoundary
          loading={loading}
          error={issuedError || error}
          isEmpty={issued.length === 0}
          onRetry={load}
          empty={
            <EmptyState
              icon={FileCheck}
              title={t("documents.issuedEmptyTitle", "No documents issued yet")}
              description={t(
                "documents.issuedEmptyDesc",
                "Documents your agents issue from a template show up here, with the PDF the customer received.",
              )}
            />
          }
        >
          <div className="flex flex-col gap-2">
            {issued.map((doc) => (
              <Card
                key={doc.id}
                className="flex items-center justify-between gap-4 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-sm text-text-primary">
                      {doc.number ? `${doc.title} ${doc.number}` : doc.title}
                    </span>
                    {doc.revoked && (
                      <Badge variant="secondary">
                        {t("documents.revokedBadge", "Revoked")}
                      </Badge>
                    )}
                    {!doc.revoked && doc.status !== "READY" && (
                      <Badge variant="secondary">
                        {t("documents.pendingBadge", "Not rendered")}
                      </Badge>
                    )}
                  </div>
                  {/* Which template it came from, and when. Without the first, two documents from
                      different templates that happen to share a title are the same row twice. */}
                  <p className="mt-0.5 truncate text-text-muted text-xs">
                    {doc.templateId
                      ? (templateNames.get(doc.templateId) ??
                        t("documents.templateGone", "Template deleted"))
                      : t("documents.templateGone", "Template deleted")}
                    {" · "}
                    {new Date(doc.createdAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openPdf(doc)}
                    // A row exists before its PDF does: the render happens after the insert, and a
                    // failure there leaves a PENDING row with no storage key. Enabled, the button
                    // could only ever fetch a 404 and say nothing about why.
                    disabled={doc.revoked || doc.status !== "READY"}
                  >
                    {t("documents.openPdf", "Open PDF")}
                  </Button>
                  {!doc.revoked && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => askRevoke(doc)}
                    >
                      {t("documents.revoke", "Revoke")}
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        </DataBoundary>
      )}

      <ConfirmDialog modal={confirm} />

      <DocumentTemplateModal modal={editModal} onSaved={() => load()} />

      <Modal
        modal={companyModal}
        title={t("documents.company.title", "Company profile")}
        // Guarded like any other form modal: the letterhead is typed into, and dismissing on a
        // backdrop click used to be free because the form lived on the page, where the nav guard
        // caught it. In a modal the nav guard never fires.
        onCloseRequest={
          companyDirty
            ? () => {
                confirm.open({
                  title: t(
                    "documents.company.discardTitle",
                    "Discard changes?",
                  ),
                  message: t(
                    "documents.company.discardMessage",
                    "The letterhead has unsaved changes. Close anyway?",
                  ),
                  danger: true,
                  confirmLabel: t("common.discard", "Discard"),
                  onConfirm: () => {
                    setCompanyDirty(false);
                    companyModal.close();
                  },
                });
              }
            : undefined
        }
      >
        <CompanyProfileCard
          company={company}
          onChanged={applyCompany}
          // Closed by a PROFILE save only. A logo upload also answers with the whole block, and
          // closing the editor because a picture finished uploading takes the form away mid-edit.
          onSaved={(from) => {
            // A save that belongs to an earlier OPENING of this editor announces itself after the
            // operator has already closed and reopened it. Closing on that would take away the form
            // they are typing into now.
            if (from !== undefined && from !== companySessionRef.current)
              return;
            setCompanyDirty(false);
            companyModal.close();
          }}
          onDirtyChange={setCompanyDirty}
          session={companySession}
        />
      </Modal>

      <Modal
        modal={starterModal}
        title={
          naming
            ? t("documents.nameTitle", "Name this template")
            : t("documents.starterTitle", "Start from a template")
        }
        // Dismissing mid-create would leave a request in flight whose result the operator can no
        // longer see, and the template it creates would then appear in the list with no
        // explanation. It is also what keeps this dialog from being REOPENED while a request from
        // the previous opening is still out — the case that would otherwise need a session token,
        // and does not, because it cannot happen.
        onCloseRequest={creating ? () => undefined : undefined}
      >
        {naming ? (
          <div className="flex flex-col gap-3">
            {/* The name is asked for, not defaulted: it is what the agent's tool is called and what
                the model reads to choose between documents, so two templates cannot share one. The
                starter's name is the suggestion, and it is selected on focus so replacing it is one
                keystroke. */}
            <p className="text-sm text-text-muted">
              {t(
                "documents.nameHint",
                "This is what the agent's tool is called, so each template needs its own name.",
              )}
            </p>
            <FormField label={t("documents.name", "Name")}>
              <Input
                autoFocus
                value={draftName}
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
            {createError && (
              <p className="text-sm text-warning">{createError}</p>
            )}
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
                "documents.starterHint",
                "Pick one to copy into your account, then edit its wording.",
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
                  <p className="text-text-muted text-xs">{s.description}</p>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    setNaming(s);
                    setDraftName(s.name);
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

      <Modal
        modal={refsModal}
        title={t("resources.usageTitle", "Where this is used")}
      >
        {refs === "error" ? (
          <p className="text-sm text-warning">
            {t(
              "documents.refsError",
              "Could not check which agents use this template.",
            )}
          </p>
        ) : (
          <AgentReferences agents={refs} />
        )}
      </Modal>

      <Modal
        modal={deleteModal}
        size="sm"
        title={t("documents.deleteTitle", "Delete document template")}
        onCloseRequest={deleting ? () => undefined : undefined}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => deleteModal.close()}
              disabled={deleting}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            {/* Disabled while the reference lookup is in flight. The dialog's whole job is to say
                what this deletion breaks — which agents lose the tool — and an operator who
                confirms before that arrives deletes it without ever seeing the warning the dialog
                promises (docs/modals.md). */}
            <Button
              variant="danger"
              onClick={confirmDelete}
              loading={deleting}
              // Enabled once the lookup has ANSWERED, whether with a list or with a failure: a
              // failed check must not become a dialog the operator can never leave through the
              // button it offers. The warning below says the impact is unknown.
              disabled={deleteRefs === null}
            >
              {t("common.delete", "Delete")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            {t("documents.deleteMessage", 'Delete "{{name}}"?', {
              name: deleteModal.payload?.name ?? "",
            })}
          </p>
          <p className="text-sm text-text-muted">
            {t(
              "documents.deleteNote",
              "Documents already issued from it keep their own copy and stay readable.",
            )}
          </p>
          {deleteRefs === null && (
            <p className="text-sm text-text-muted">
              {t("documents.deleteChecking", "Checking which agents use it…")}
            </p>
          )}
          {deleteRefs === "error" && (
            <p className="text-sm text-warning">
              {t(
                "documents.refsError",
                "Could not check which agents use this template.",
              )}
            </p>
          )}
          {Array.isArray(deleteRefs) && deleteRefs.length > 0 && (
            <p className="text-sm text-warning">
              {t(
                "resources.deleteRefsWarning",
                "{{count}} agent uses this and will stop working if you delete it.",
                { count: deleteRefs.length },
              )}
            </p>
          )}
          <AgentReferences
            agents={Array.isArray(deleteRefs) ? deleteRefs : null}
          />
        </div>
      </Modal>
    </div>
  );
}
