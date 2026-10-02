import { Pencil, Play, Radar, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  ConfirmDialog,
  type ConfirmPayload,
  CredentialPicker,
  DataBoundary,
  EmptyState,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  PageContainer,
  Select,
  Switch,
  Textarea,
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { formatDateTime } from "@/client/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/client/merchant/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/merchant/components/ui/table";

// Merchant-shadcn theme tokens. Importing the CSS here keeps every merchant asset
// inside src/client/merchant/ - App.tsx only needs the page import + one <Route>.
import "@/client/merchant/index.css";

// Discovery lead sources: the configured rails that scan social platforms and
// feed the lead ingest pipeline. Create/edit runs through one modal whose
// fields follow the chosen kind; Run now triggers a scan on demand (the source
// does not need to be enabled - `enabled` is for the future scheduler, see
// INTEGRATION.md).

// Derived from the treaty responses; never hand-mirrored (see docs/eden-treaty.md).
type SourcesData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.sources)["get"]>
>["data"];
type LeadSource = NonNullable<SourcesData>["sources"][number];
// The per-source leads endpoint answers the same page shape as /leads.
type SourceLeadsData = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.merchant.sources>["leads"]["get"]>
>["data"];
type SourceLead = NonNullable<SourceLeadsData>["leads"][number];

const KIND_LABEL: Record<string, string> = {
  file_import: "merchant.sources.kind.file_import",
  threads_api: "merchant.sources.kind.threads_api",
  tiktok_comments: "merchant.sources.kind.tiktok_comments",
};

const KINDS = ["file_import", "threads_api", "tiktok_comments"] as const;

function statusVariant(
  status: string | null,
): "success" | "error" | "secondary" {
  if (status === "ok") return "success";
  if (status === "error") return "error";
  return "secondary";
}

interface SourceModalPayload {
  // Present when editing; absent when creating.
  source?: LeadSource;
}

interface SourceFormState {
  name: string;
  kind: string;
  intervalMin: string;
  enabled: boolean;
  // file_import
  format: string;
  platform: string;
  content: string;
  // threads_api
  credentialRef: string;
  // threads_api + tiktok_comments
  keywords: string;
  // tiktok_comments
  mode: string;
}

const EMPTY_FORM: SourceFormState = {
  name: "",
  kind: "file_import",
  intervalMin: "60",
  enabled: true,
  format: "auto",
  platform: "",
  content: "",
  credentialRef: "",
  keywords: "",
  mode: "fixture",
};

// The dialog's copy of a stored config. The list row carries every key except
// file_import's `content` (elided to `contentChars`); the caller fetches the
// detail record to prefill it.
function formFromConfig(
  base: SourceFormState,
  config: Record<string, unknown>,
): SourceFormState {
  const str = (k: string) =>
    typeof config[k] === "string" ? (config[k] as string) : "";
  const list = (k: string) =>
    Array.isArray(config[k])
      ? (config[k] as unknown[]).filter((v) => typeof v === "string").join("\n")
      : "";
  return {
    ...base,
    format: str("format") || "auto",
    platform: str("platform"),
    content: str("content") || base.content,
    credentialRef: str("credentialRef"),
    keywords: list("keywords"),
    mode: str("mode") || "fixture",
  };
}

function buildConfig(form: SourceFormState): Record<string, unknown> {
  const keywords = form.keywords
    .split("\n")
    .map((k) => k.trim())
    .filter((k) => k !== "");
  switch (form.kind) {
    case "threads_api":
      return {
        credentialRef: form.credentialRef,
        keywords,
      };
    case "tiktok_comments":
      return { mode: form.mode, ...(keywords.length > 0 ? { keywords } : {}) };
    default:
      return {
        format: form.format,
        ...(form.platform !== "" ? { platform: form.platform } : {}),
        ...(form.content.trim() !== "" ? { content: form.content } : {}),
      };
  }
}

function SourceEditModal({
  modal,
  onSaved,
}: {
  modal: ModalController<SourceModalPayload>;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const enabledId = useId();
  const editing = modal.payload?.source;
  const [form, setForm] = useState<SourceFormState>(EMPTY_FORM);
  const baseline = useRef<SourceFormState>(EMPTY_FORM);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useOnModalOpen(modal, () => {
    setError("");
    const src = modal.payload?.source;
    const next: SourceFormState = src
      ? formFromConfig(
          {
            ...EMPTY_FORM,
            name: src.name,
            kind: src.kind,
            intervalMin: String(src.intervalMin),
            enabled: src.enabled,
          },
          src.config,
        )
      : EMPTY_FORM;
    setForm(next);
    baseline.current = next;
    // The list DTO elides file_import's pasted `content`; the detail record
    // carries it, so an edit dialog prefills from a follow-up fetch. While it
    // is in flight the textarea holds what the operator last typed, which a
    // late response must not clobber - compare against the baseline the open
    // reset, not whatever the field shows now. `alive` is the stale-response
    // guard (the effect cleanup flips it when the dialog closes or re-opens).
    let alive = true;
    if (src && src.kind === "file_import") {
      void api.api.v1.merchant
        .sources({ id: src.id })
        .get()
        .then(({ data }) => {
          if (!alive || !data) return;
          const detail = data.source.config;
          const content =
            typeof detail.content === "string" ? detail.content : "";
          setForm((prev) =>
            prev.content === baseline.current.content
              ? { ...prev, content }
              : prev,
          );
          baseline.current = { ...baseline.current, content };
        })
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  });

  const set = <K extends keyof SourceFormState>(
    key: K,
    value: SourceFormState[K],
  ) => setForm((prev) => ({ ...prev, [key]: value }));

  const keywordsValid =
    form.kind === "file_import" ||
    form.kind === "tiktok_comments" ||
    form.keywords.trim() !== "";
  const credentialValid =
    form.kind !== "threads_api" || form.credentialRef.trim() !== "";
  const intervalNum = Number.parseInt(form.intervalMin, 10);
  const intervalValid =
    Number.isFinite(intervalNum) && intervalNum >= 1 && intervalNum <= 10080;
  const canSubmit =
    form.name.trim() !== "" &&
    keywordsValid &&
    credentialValid &&
    intervalValid;

  const isDirty = (Object.keys(form) as (keyof SourceFormState)[]).some(
    (k) => form[k] !== baseline.current[k],
  );

  const handleSubmit = async () => {
    setError("");
    setLoading(true);
    const body = {
      name: form.name.trim(),
      kind: form.kind,
      config: buildConfig(form),
      intervalMin: intervalNum,
      enabled: form.enabled,
    };
    try {
      const { error: err } = editing
        ? await api.api.v1.merchant.sources({ id: editing.id }).patch(body)
        : await api.api.v1.merchant.sources.post(body);
      if (err) {
        setError(
          apiErrorMessage(err) ??
            t("merchant.sources.saveFailed", "Could not save the source"),
        );
        return;
      }
      onSaved();
      modal.close();
    } catch {
      setError(t("merchant.sources.saveFailed", "Could not save the source"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      modal={modal}
      size="lg"
      unsavedChanges={isDirty}
      title={
        editing
          ? t("merchant.sources.editTitle", "Edit source")
          : t("merchant.sources.createTitle", "New lead source")
      }
      description={t(
        "merchant.sources.dialogSubtitle",
        "A source scans a platform and feeds matching posts into the lead pipeline.",
      )}
      footer={
        <>
          <ModalCancelButton />
          <Button
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || loading}
          >
            {loading
              ? t("common.saving", "Saving...")
              : t("common.save", "Save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label={t("merchant.sources.fieldName", "Name")} required>
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder={t(
              "merchant.sources.fieldNamePlaceholder",
              "e.g. TikTok comments - skincare keywords",
            )}
          />
        </FormField>

        <FormField
          label={t("merchant.sources.fieldKind", "Kind")}
          description={t(
            "merchant.sources.fieldKindHint",
            "Changing the kind re-validates the config against the new scanner.",
          )}
        >
          <Select
            value={form.kind}
            onChange={(e) => set("kind", e.target.value)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {
                  // t('merchant.sources.kind.file_import', 'File import (JSONL/CSV)')
                  // t('merchant.sources.kind.threads_api', 'Threads API search')
                  // t('merchant.sources.kind.tiktok_comments', 'TikTok comments')
                  // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in KIND_LABEL
                  t(KIND_LABEL[k] as string, k)
                }
              </option>
            ))}
          </Select>
        </FormField>

        {form.kind === "file_import" && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <FormField label={t("merchant.sources.fieldFormat", "Format")}>
                <Select
                  value={form.format}
                  onChange={(e) => set("format", e.target.value)}
                >
                  <option value="auto">
                    {t("merchant.sources.formatAuto", "Auto-detect")}
                  </option>
                  <option value="jsonl">
                    {t("merchant.sources.formatJsonl", "JSONL")}
                  </option>
                  <option value="csv">
                    {t("merchant.sources.formatCsv", "CSV")}
                  </option>
                </Select>
              </FormField>
              <FormField
                label={t("merchant.sources.fieldPlatform", "Default platform")}
                description={t(
                  "merchant.sources.fieldPlatformHint",
                  "Used for rows that do not name a platform.",
                )}
              >
                <Select
                  value={form.platform}
                  onChange={(e) => set("platform", e.target.value)}
                >
                  <option value="">
                    {t("merchant.sources.platformNone", "None")}
                  </option>
                  {[
                    "facebook",
                    "instagram",
                    "threads",
                    "tiktok",
                    "zalo",
                    "whatsapp",
                    "telegram",
                    "web",
                    "other",
                  ].map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
            <FormField
              label={t("merchant.sources.fieldContent", "Content")}
              description={t(
                "merchant.sources.fieldContentHint",
                "Pasted JSONL or CSV export. Leave empty to pass the content at run time instead.",
              )}
            >
              <Textarea
                value={form.content}
                onChange={(e) => set("content", e.target.value)}
                rows={6}
                placeholder={
                  '{"id":"p1","author":"Lan","text":"cần mua serum BHA"}'
                }
              />
            </FormField>
          </>
        )}

        {form.kind === "threads_api" && (
          <>
            <FormField
              label={t("merchant.sources.fieldCredential", "Access token")}
              description={t(
                "merchant.sources.fieldCredentialHint",
                "A vault entry holding the Threads API access token.",
              )}
              required
            >
              <CredentialPicker
                value={form.credentialRef}
                onChange={(ref) => set("credentialRef", ref)}
                compatibleTypes={["bearer_token", "generic"]}
                defaultCreateType="bearer_token"
                ariaLabel={t(
                  "merchant.sources.fieldCredential",
                  "Access token",
                )}
              />
            </FormField>
            <FormField
              label={t("merchant.sources.fieldKeywords", "Keywords")}
              description={t(
                "merchant.sources.fieldKeywordsHint",
                "One per line; each keyword runs one search per scan.",
              )}
              required
            >
              <Textarea
                value={form.keywords}
                onChange={(e) => set("keywords", e.target.value)}
                rows={4}
                placeholder={"cần mua\nai bán"}
              />
            </FormField>
          </>
        )}

        {form.kind === "tiktok_comments" && (
          <>
            <FormField label={t("merchant.sources.fieldMode", "Mode")}>
              <Select
                value={form.mode}
                onChange={(e) => set("mode", e.target.value)}
              >
                <option value="fixture">
                  {t(
                    "merchant.sources.modeFixture",
                    "Fixture (bundled sample)",
                  )}
                </option>
                <option value="api">
                  {t("merchant.sources.modeApi", "TikTok API (not wired yet)")}
                </option>
              </Select>
            </FormField>
            <FormField
              label={t("merchant.sources.fieldKeywords", "Keywords")}
              description={t(
                "merchant.sources.fieldKeywordsOptionalHint",
                "One per line; empty imports every scanned comment.",
              )}
            >
              <Textarea
                value={form.keywords}
                onChange={(e) => set("keywords", e.target.value)}
                rows={4}
                placeholder={"serum\nkem chống nắng"}
              />
            </FormField>
          </>
        )}

        <div className="grid grid-cols-2 gap-4">
          <FormField
            label={t("merchant.sources.fieldInterval", "Interval (minutes)")}
            description={t(
              "merchant.sources.fieldIntervalHint",
              "Used by the scheduler once one is wired; Run now works regardless.",
            )}
          >
            <Input
              type="number"
              min={1}
              max={10080}
              value={form.intervalMin}
              onChange={(e) => set("intervalMin", e.target.value)}
            />
          </FormField>
          <FormField label={t("merchant.sources.fieldEnabled", "Enabled")}>
            <div className="flex h-9 items-center">
              <Switch
                id={enabledId}
                checked={form.enabled}
                onCheckedChange={(v) => set("enabled", v)}
                aria-label={t("merchant.sources.fieldEnabled", "Enabled")}
              />
            </div>
          </FormField>
        </div>

        {error !== "" && (
          <p className="text-danger text-sm" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

// The leads one source produced: a read-only table opened from the row's count.
function SourceLeadsModal({ modal }: { modal: ModalController<LeadSource> }) {
  const { t, i18n } = useTranslation();
  const [leads, setLeads] = useState<SourceLead[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useOnModalOpen(modal, () => {
    setLeads([]);
    setError(false);
    const src = modal.payload;
    if (!src) return;
    // `alive` drops a response that lands after the dialog closed/re-opened.
    let alive = true;
    setLoading(true);
    void api.api.v1.merchant
      .sources({ id: src.id })
      .leads.get({ query: { limit: "50" } })
      .then(({ data, error: err }) => {
        if (!alive) return;
        if (err || !data) setError(true);
        else setLeads(data.leads);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  });

  return (
    <Modal
      modal={modal}
      size="xl"
      title={t("merchant.sources.leadsTitle", "Leads from {{name}}", {
        name: modal.payload?.name ?? "",
      })}
      footer={
        <ModalCancelButton>{t("common.close", "Close")}</ModalCancelButton>
      }
    >
      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={leads.length === 0}
        empty={
          <EmptyState
            icon={Users}
            title={t(
              "merchant.sources.noLeads",
              "No leads from this source yet",
            )}
            description={t(
              "merchant.sources.noLeadsHint",
              "Run the source to scan for posts.",
            )}
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("merchant.leads.colAuthor", "Author")}</TableHead>
              <TableHead>{t("merchant.leads.colText", "Post")}</TableHead>
              <TableHead>{t("merchant.leads.colScore", "Score")}</TableHead>
              <TableHead>
                {t("merchant.leads.colMatches", "Matched products")}
              </TableHead>
              <TableHead>{t("merchant.leads.colCreated", "Found")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {leads.map((lead) => (
              <TableRow key={lead.id}>
                <TableCell className="font-medium">
                  <div className="flex flex-col">
                    <span>{lead.authorName}</span>
                    <span className="text-muted-foreground text-xs capitalize">
                      {lead.platform}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="max-w-md">
                  <span className="line-clamp-2 whitespace-normal text-muted-foreground">
                    {lead.text}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      lead.score >= 70
                        ? "success"
                        : lead.score >= 40
                          ? "warning"
                          : "secondary"
                    }
                  >
                    {lead.score}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-xs">
                  <div className="flex flex-wrap gap-1">
                    {lead.matches.map((m) => (
                      <Badge key={m.productId} variant="secondary">
                        {m.productName}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDateTime(lead.createdAt, i18n.language)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataBoundary>
    </Modal>
  );
}

export function SourcesPage() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const [sources, setSources] = useState<LeadSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const editModal = useModalController<SourceModalPayload>();
  const leadsModal = useModalController<LeadSource>();
  const confirm = useModalController<ConfirmPayload>();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data, error: err } = await api.api.v1.merchant.sources.get();
      if (err || !data) {
        setError(true);
        return;
      }
      setSources(data.sources);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const runNow = async (src: LeadSource) => {
    setRunningId(src.id);
    try {
      const { data, error: err } = await api.api.v1.merchant
        .sources({ id: src.id })
        .run.post({});
      if (err || !data) {
        showToast(
          apiErrorMessage(err) ??
            t("merchant.sources.runFailed", "The scan failed"),
          "error",
        );
        return;
      }
      showToast(
        t(
          "merchant.sources.runDone",
          "Scan done: {{new}} new, {{deduped}} deduped, {{skipped}} skipped",
          { new: data.new, deduped: data.deduped, skipped: data.skipped },
        ),
        "success",
      );
      void fetchAll();
    } catch {
      showToast(t("merchant.sources.runFailed", "The scan failed"), "error");
    } finally {
      setRunningId(null);
    }
  };

  const requestDelete = (src: LeadSource) => {
    confirm.open({
      title: t("merchant.sources.deleteTitle", "Delete source"),
      message: t(
        "merchant.sources.deleteMessage",
        "Leads it produced are kept; only the source is removed.",
      ),
      confirmLabel: t("common.delete", "Delete"),
      danger: true,
      onConfirm: async () => {
        const { error: err } = await api.api.v1.merchant
          .sources({ id: src.id })
          .delete();
        if (err) {
          showToast(
            apiErrorMessage(err) ??
              t("merchant.sources.deleteFailed", "Could not delete the source"),
            "error",
          );
          throw new Error("delete failed");
        }
        showToast(t("merchant.sources.deleted", "Source deleted"), "success");
        void fetchAll();
      },
    });
  };

  return (
    <PageContainer size="wide">
      <div className="flex items-center justify-between gap-4 py-4">
        <div>
          <h1 className="font-semibold text-text-primary text-xl">
            {t("merchant.sources.title", "Lead sources")}
          </h1>
          <p className="text-sm text-text-secondary">
            {t(
              "merchant.sources.subtitle",
              "Configured rails that scan social platforms and feed the lead pipeline.",
            )}
          </p>
        </div>
        <Button onClick={() => editModal.open({})}>
          {t("merchant.sources.create", "New source")}
        </Button>
      </div>

      <SourceEditModal
        modal={editModal}
        onSaved={() => {
          showToast(t("merchant.sources.saved", "Source saved"), "success");
          void fetchAll();
        }}
      />
      <SourceLeadsModal modal={leadsModal} />
      <ConfirmDialog modal={confirm} />

      <Card>
        <CardHeader>
          <CardTitle>
            {t("merchant.sources.tableTitle", "Configured sources")}
          </CardTitle>
          <CardDescription>
            {t(
              "merchant.sources.tableSubtitle",
              "Each run scans, dedupes on the post's upstream id and feeds new posts into scoring.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataBoundary
            loading={loading}
            error={error}
            isEmpty={sources.length === 0}
            onRetry={() => void fetchAll()}
            empty={
              <EmptyState
                icon={Radar}
                title={t("merchant.sources.emptyTitle", "No sources yet")}
                description={t(
                  "merchant.sources.emptyDescription",
                  "Add a file import, a Threads search, or TikTok comments to start finding leads.",
                )}
              />
            }
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("merchant.sources.colName", "Name")}</TableHead>
                  <TableHead>{t("merchant.sources.colKind", "Kind")}</TableHead>
                  <TableHead>
                    {t("merchant.sources.colEnabled", "Enabled")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.sources.colInterval", "Interval")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.sources.colLastRun", "Last run")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.sources.colLeads", "Leads")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.sources.colActions", "Actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((src) => (
                  <TableRow key={src.id}>
                    <TableCell className="font-medium">{src.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {
                          // t('merchant.sources.kind.file_import', 'File import (JSONL/CSV)')
                          // t('merchant.sources.kind.threads_api', 'Threads API search')
                          // t('merchant.sources.kind.tiktok_comments', 'TikTok comments')
                          // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in KIND_LABEL
                          t(KIND_LABEL[src.kind] ?? src.kind, src.kind)
                        }
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {src.enabled ? (
                        <Badge variant="success">
                          {t("merchant.sources.enabled", "On")}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          {t("merchant.sources.disabled", "Off")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t("merchant.sources.intervalMin", "{{min}} min", {
                        min: src.intervalMin,
                      })}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        {src.lastStatus ? (
                          <Badge variant={statusVariant(src.lastStatus)}>
                            {src.lastStatus === "ok"
                              ? t("merchant.sources.statusOk", "OK")
                              : t("merchant.sources.statusError", "Error")}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">
                            {t("merchant.sources.neverRun", "Never run")}
                          </span>
                        )}
                        <span className="text-muted-foreground text-xs">
                          {formatDateTime(src.lastRunAt, i18n.language)}
                        </span>
                        {src.lastError && (
                          <span
                            className="max-w-[16rem] truncate text-danger text-xs"
                            title={src.lastError}
                          >
                            {src.lastError}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => leadsModal.open(src)}
                      >
                        {src.leadCount}
                      </Button>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void runNow(src)}
                          disabled={runningId === src.id}
                        >
                          <Play className="h-4 w-4" aria-hidden="true" />
                          {runningId === src.id
                            ? t("merchant.sources.running", "Running...")
                            : t("merchant.sources.runNow", "Run now")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => editModal.open({ source: src })}
                          aria-label={t("common.edit", "Edit")}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => requestDelete(src)}
                          aria-label={t("common.delete", "Delete")}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataBoundary>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
