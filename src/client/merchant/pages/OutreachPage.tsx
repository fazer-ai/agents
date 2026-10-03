import { Plus, Send, ShieldAlert, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  EmptyState,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  PageContainer,
  Select,
  Textarea,
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
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

// Merchant-shadcn theme tokens (see SourcesPage for why the import lives here).
import "@/client/merchant/index.css";

// Phase 3 "grey rails": a capped, approval-gated queue for outreach from the
// operator's own secondary accounts. Nothing here sends on its own - a job is
// QUEUED until a person approves it, and every send is audited. When the
// deployment has OUTREACH_ENABLED off, the API answers 403 and this page
// renders the disabled state instead.

type AccountsData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.outreach.accounts)["get"]>
>["data"];
type OutreachAccount = NonNullable<AccountsData>["accounts"][number];
type JobsData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.outreach.jobs)["get"]>
>["data"];
type OutreachJob = NonNullable<JobsData>["jobs"][number];
type LeadsData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.leads)["get"]>
>["data"];
type LeadOption = NonNullable<LeadsData>["leads"][number];

type AccountStatus = OutreachAccount["status"];
type JobStatus = OutreachJob["status"];
type JobKind = OutreachJob["kind"];

const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  ACTIVE: "merchant.outreach.accountStatus.active",
  PAUSED: "merchant.outreach.accountStatus.paused",
  BANNED: "merchant.outreach.accountStatus.banned",
};
const ACCOUNT_STATUS_VARIANT: Record<
  AccountStatus,
  "success" | "secondary" | "error"
> = {
  ACTIVE: "success",
  PAUSED: "secondary",
  BANNED: "error",
};
// t('merchant.outreach.accountStatus.active', 'Active')
// t('merchant.outreach.accountStatus.paused', 'Paused')
// t('merchant.outreach.accountStatus.banned', 'Banned')

const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  QUEUED: "merchant.outreach.jobStatus.queued",
  APPROVED: "merchant.outreach.jobStatus.approved",
  SENDING: "merchant.outreach.jobStatus.sending",
  READY_FOR_MANUAL: "merchant.outreach.jobStatus.readyForManual",
  SENT: "merchant.outreach.jobStatus.sent",
  FAILED: "merchant.outreach.jobStatus.failed",
  CANCELLED: "merchant.outreach.jobStatus.cancelled",
};
const JOB_STATUS_VARIANT: Record<
  JobStatus,
  "secondary" | "primary" | "info" | "success" | "error"
> = {
  QUEUED: "secondary",
  APPROVED: "primary",
  SENDING: "info",
  READY_FOR_MANUAL: "info",
  SENT: "success",
  FAILED: "error",
  CANCELLED: "secondary",
};
// t('merchant.outreach.jobStatus.queued', 'Queued')
// t('merchant.outreach.jobStatus.approved', 'Approved')
// t('merchant.outreach.jobStatus.sending', 'Sending')
// t('merchant.outreach.jobStatus.readyForManual', 'Manual send')
// t('merchant.outreach.jobStatus.sent', 'Sent')
// t('merchant.outreach.jobStatus.failed', 'Failed')
// t('merchant.outreach.jobStatus.cancelled', 'Cancelled')

const JOB_KIND_LABEL: Record<JobKind, string> = {
  GROUP_COMMENT: "merchant.outreach.kind.groupComment",
  FRIEND_REQUEST: "merchant.outreach.kind.friendRequest",
  DM: "merchant.outreach.kind.dm",
};
const JOB_KINDS: JobKind[] = ["GROUP_COMMENT", "FRIEND_REQUEST", "DM"];
// t('merchant.outreach.kind.groupComment', 'Group comment')
// t('merchant.outreach.kind.friendRequest', 'Friend request')
// t('merchant.outreach.kind.dm', 'Direct message')

const PLATFORMS = [
  "zalo",
  "facebook",
  "tiktok",
  "instagram",
  "threads",
  "whatsapp",
  "telegram",
  "web",
  "other",
] as const;

interface AccountForm {
  platform: string;
  handle: string;
  transport: "manual" | "zca_bridge";
  credentialRef: string;
  dailyCap: string;
  cooldownMin: string;
  notes: string;
}
const EMPTY_ACCOUNT: AccountForm = {
  platform: "zalo",
  handle: "",
  transport: "manual",
  credentialRef: "",
  dailyCap: "20",
  cooldownMin: "10",
  notes: "",
};

interface JobForm {
  accountId: string;
  leadId: string;
  kind: JobKind;
  body: string;
}
const EMPTY_JOB: JobForm = {
  accountId: "",
  leadId: "",
  kind: "DM",
  body: "",
};

function AccountModal({
  modal,
  onCreated,
}: {
  modal: ModalController;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [form, setForm] = useState<AccountForm>(EMPTY_ACCOUNT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useOnModalOpen(modal, () => {
    setForm(EMPTY_ACCOUNT);
    setError("");
  });
  const set = <K extends keyof AccountForm>(k: K, v: AccountForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const canSubmit = form.handle.trim() !== "" && form.platform !== "";

  async function submit() {
    setSaving(true);
    setError("");
    const { error: err } = await api.api.v1.merchant.outreach.accounts.post({
      platform: form.platform,
      handle: form.handle.trim(),
      transport: form.transport,
      ...(form.credentialRef.trim() !== ""
        ? { credentialRef: form.credentialRef.trim() }
        : {}),
      dailyCap: Number(form.dailyCap) || 20,
      cooldownMin: Number(form.cooldownMin) || 0,
      ...(form.notes.trim() !== "" ? { notes: form.notes.trim() } : {}),
    });
    setSaving(false);
    if (err) {
      setError(
        apiErrorMessage(err) ??
          t("merchant.outreach.saveFailed", "Could not save the account"),
      );
      return;
    }
    showToast(t("merchant.outreach.accountCreated", "Account registered"));
    modal.close();
    onCreated();
  }

  return (
    <Modal
      modal={modal}
      title={t("merchant.outreach.newAccount", "New outreach account")}
      description={t(
        "merchant.outreach.newAccountSub",
        "A secondary account you own. Sends stay capped and audited.",
      )}
      footer={
        <>
          <ModalCancelButton />
          <Button onClick={() => void submit()} disabled={!canSubmit || saving}>
            {saving
              ? t("common.saving", "Saving...")
              : t("common.save", "Save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            label={t("merchant.outreach.fieldPlatform", "Platform")}
            required
          >
            <Select
              value={form.platform}
              onChange={(e) => set("platform", e.target.value)}
            >
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label={"Handle"} required>
            <Input
              value={form.handle}
              onChange={(e) => set("handle", e.target.value)}
              placeholder="@shop_phu"
            />
          </FormField>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <FormField label={t("merchant.outreach.fieldTransport", "Send via")}>
            <Select
              value={form.transport}
              onChange={(e) =>
                set("transport", e.target.value as AccountForm["transport"])
              }
            >
              <option value="manual">
                {t(
                  "merchant.outreach.transportManual",
                  "Manual (operator sends)",
                )}
              </option>
              <option value="zca_bridge">{"zca-bridge"}</option>
            </Select>
          </FormField>
          <FormField label={t("merchant.outreach.fieldDailyCap", "Daily cap")}>
            <Input
              type="number"
              min={1}
              max={500}
              value={form.dailyCap}
              onChange={(e) => set("dailyCap", e.target.value)}
            />
          </FormField>
          <FormField
            label={t("merchant.outreach.fieldCooldown", "Cooldown (min)")}
          >
            <Input
              type="number"
              min={0}
              max={1440}
              value={form.cooldownMin}
              onChange={(e) => set("cooldownMin", e.target.value)}
            />
          </FormField>
        </div>
        <FormField
          label={t("merchant.outreach.fieldCredentialRef", "Credential ref")}
          description={t(
            "merchant.outreach.fieldCredentialRefHint",
            "Optional vault:<id> the transport reads (e.g. the zca-bridge token).",
          )}
        >
          <Input
            value={form.credentialRef}
            onChange={(e) => set("credentialRef", e.target.value)}
            placeholder="vault:3"
          />
        </FormField>
        <FormField label={t("merchant.outreach.fieldNotes", "Notes")}>
          <Textarea
            rows={2}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </FormField>
        {error !== "" && <p className="text-destructive text-sm">{error}</p>}
      </div>
    </Modal>
  );
}

function JobModal({
  modal,
  accounts,
  onCreated,
}: {
  modal: ModalController;
  accounts: OutreachAccount[];
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [form, setForm] = useState<JobForm>(EMPTY_JOB);
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useOnModalOpen(modal, () => {
    setForm(EMPTY_JOB);
    setError("");
    void api.api.v1.merchant.leads
      .get({ query: { limit: "100" } })
      .then(({ data }) => setLeads(data?.leads ?? []));
  });
  const set = <K extends keyof JobForm>(k: K, v: JobForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const canSubmit =
    form.accountId !== "" && form.leadId !== "" && form.body.trim() !== "";

  async function submit() {
    setSaving(true);
    setError("");
    const { error: err } = await api.api.v1.merchant.outreach.jobs.post({
      accountId: form.accountId,
      leadId: form.leadId,
      kind: form.kind,
      body: form.body.trim(),
    });
    setSaving(false);
    if (err) {
      setError(
        apiErrorMessage(err) ??
          t("merchant.outreach.saveFailed", "Could not save the account"),
      );
      return;
    }
    showToast(
      t("merchant.outreach.jobQueued", "Job queued - approve it to send"),
    );
    modal.close();
    onCreated();
  }

  return (
    <Modal
      modal={modal}
      title={t("merchant.outreach.queueJob", "Queue outreach")}
      description={t(
        "merchant.outreach.queueJobSub",
        "The job stays QUEUED until a person approves it.",
      )}
      footer={
        <>
          <ModalCancelButton />
          <Button onClick={() => void submit()} disabled={!canSubmit || saving}>
            {saving
              ? t("common.saving", "Saving...")
              : t("common.save", "Save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            label={t("merchant.outreach.fieldAccount", "Account")}
            required
          >
            <Select
              value={form.accountId}
              onChange={(e) => set("accountId", e.target.value)}
            >
              <option value="">{"-"}</option>
              {accounts
                .filter((a) => a.status === "ACTIVE")
                .map((a) => (
                  <option
                    key={a.id}
                    value={a.id}
                  >{`${a.handle} (${a.platform})`}</option>
                ))}
            </Select>
          </FormField>
          <FormField label={t("merchant.outreach.fieldKind", "Kind")}>
            <Select
              value={form.kind}
              onChange={(e) => set("kind", e.target.value as JobKind)}
            >
              {JOB_KINDS.map((k) => (
                <option key={k} value={k}>
                  {
                    // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in JOB_KIND_LABEL
                    t(JOB_KIND_LABEL[k] ?? k, k)
                  }
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <FormField label={"Lead"} required>
          <Select
            value={form.leadId}
            onChange={(e) => set("leadId", e.target.value)}
          >
            <option value="">{"-"}</option>
            {leads.map((l) => (
              <option
                key={l.id}
                value={l.id}
              >{`#${l.id} ${l.authorName} - ${l.platform}`}</option>
            ))}
          </Select>
        </FormField>
        <FormField label={t("merchant.outreach.fieldBody", "Message")} required>
          <Textarea
            rows={4}
            value={form.body}
            onChange={(e) => set("body", e.target.value)}
            placeholder={t(
              "merchant.outreach.fieldBodyPlaceholder",
              "The exact text the operator approves before anything sends.",
            )}
          />
        </FormField>
        {error !== "" && <p className="text-destructive text-sm">{error}</p>}
      </div>
    </Modal>
  );
}

export function OutreachPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [accounts, setAccounts] = useState<OutreachAccount[]>([]);
  const [jobs, setJobs] = useState<OutreachJob[]>([]);
  const [disabled, setDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const accountModal = useModalController();
  const jobModal = useModalController();
  const confirm = useModalController<ConfirmPayload>();

  const reload = useCallback(async () => {
    const [accs, jobsRes] = await Promise.all([
      api.api.v1.merchant.outreach.accounts.get(),
      api.api.v1.merchant.outreach.jobs.get({ query: { limit: "100" } }),
    ]);
    if (accs.error?.status === 403 || jobsRes.error?.status === 403) {
      setDisabled(true);
      setLoading(false);
      return;
    }
    setFailed(accs.error !== undefined && jobsRes.error !== undefined);
    setAccounts(accs.data?.accounts ?? []);
    setJobs(jobsRes.data?.jobs ?? []);
    setLoading(false);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function accountStatus(
    account: OutreachAccount,
    status: AccountStatus,
  ) {
    const { error: err } = await api.api.v1.merchant.outreach
      .accounts({ id: account.id })
      .patch({ status });
    if (err) {
      showToast(
        apiErrorMessage(err) ??
          t("merchant.outreach.actionFailed", "The action failed"),
        "error",
      );
      return;
    }
    void reload();
  }

  function requestDelete(account: OutreachAccount) {
    confirm.open({
      title: t("merchant.outreach.deleteAccount", "Delete account"),
      message: t(
        "merchant.outreach.deleteAccountSub",
        "Pending jobs from this account stop; sent history stays in the audit log.",
      ),
      confirmLabel: t("common.delete", "Delete"),
      danger: true,
      onConfirm: async () => {
        const { error: err } = await api.api.v1.merchant.outreach
          .accounts({ id: account.id })
          .delete();
        if (err) {
          showToast(
            apiErrorMessage(err) ??
              t("merchant.outreach.actionFailed", "The action failed"),
            "error",
          );
          return;
        }
        void reload();
      },
    });
  }

  async function jobAction(job: OutreachJob, action: string) {
    const target = api.api.v1.merchant.outreach.jobs({ id: job.id });
    const { error: err } =
      action === "approve"
        ? await target.approve.post({})
        : action === "cancel"
          ? await target.cancel.post({})
          : action === "requeue"
            ? await target.requeue.post({})
            : await target["mark-sent"].post({});
    if (err) {
      showToast(
        apiErrorMessage(err) ??
          t("merchant.outreach.actionFailed", "The action failed"),
        "error",
      );
      return;
    }
    void reload();
  }

  return (
    <PageContainer>
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="flex items-center gap-2 font-semibold text-2xl text-text-primary">
              <Send className="size-6" />
              {t("merchant.outreach.title", "Outreach")}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">
              {t(
                "merchant.outreach.subtitle",
                "Capped, approval-gated sends from secondary accounts. Nothing leaves without an operator's approval.",
              )}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => accountModal.open()}>
              <Plus className="size-4" />
              {t("merchant.outreach.newAccount", "New outreach account")}
            </Button>
            <Button onClick={() => jobModal.open()}>
              <Plus className="size-4" />
              {t("merchant.outreach.queueJob", "Queue outreach")}
            </Button>
          </div>
        </div>

        <DataBoundary loading={loading} error={failed}>
          {disabled ? (
            <EmptyState
              icon={ShieldAlert}
              title={t("merchant.outreach.disabled", "Outreach is disabled")}
              description={t(
                "merchant.outreach.disabledSub",
                "Set OUTREACH_ENABLED=true to turn on the capped outreach rails.",
              )}
            />
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>
                    {t("merchant.outreach.accountsTitle", "Accounts")}
                  </CardTitle>
                  <CardDescription>
                    {t(
                      "merchant.outreach.accountsSub",
                      "Secondary/personal accounts, each with its own daily cap and cooldown.",
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {accounts.length === 0 ? (
                    <EmptyState
                      title={t("merchant.outreach.noAccounts", "No accounts")}
                      description={t(
                        "merchant.outreach.noAccountsSub",
                        "Register a secondary account to queue sends from.",
                      )}
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>
                            {t("merchant.outreach.colAccount", "Account")}
                          </TableHead>
                          <TableHead>
                            {t("merchant.outreach.colToday", "Today")}
                          </TableHead>
                          <TableHead>
                            {t("merchant.outreach.colTransport", "Send via")}
                          </TableHead>
                          <TableHead>{"Status"}</TableHead>
                          <TableHead>
                            {t("merchant.outreach.colActions", "Actions")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {accounts.map((a) => (
                          <TableRow key={a.id}>
                            <TableCell>
                              <div className="font-medium">{a.handle}</div>
                              <div className="text-text-muted text-xs">
                                {a.platform}
                              </div>
                            </TableCell>
                            <TableCell>
                              {a.sentToday}/{a.dailyCap}
                            </TableCell>
                            <TableCell>{a.transport}</TableCell>
                            <TableCell>
                              <Badge variant={ACCOUNT_STATUS_VARIANT[a.status]}>
                                {t(
                                  // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in ACCOUNT_STATUS_LABEL
                                  ACCOUNT_STATUS_LABEL[a.status] ?? a.status,
                                  a.status,
                                )}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                {a.status === "ACTIVE" ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      void accountStatus(a, "PAUSED")
                                    }
                                  >
                                    {t("merchant.outreach.pause", "Pause")}
                                  </Button>
                                ) : a.status === "PAUSED" ? (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      void accountStatus(a, "ACTIVE")
                                    }
                                  >
                                    {t("merchant.outreach.resume", "Resume")}
                                  </Button>
                                ) : null}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => requestDelete(a)}
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>
                    {t("merchant.outreach.jobsTitle", "Send queue")}
                  </CardTitle>
                  <CardDescription>
                    {t(
                      "merchant.outreach.jobsSub",
                      "QUEUED jobs wait for approval; the worker only sends APPROVED ones inside caps.",
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {jobs.length === 0 ? (
                    <EmptyState
                      title={t("merchant.outreach.noJobs", "No queued sends")}
                      description={t(
                        "merchant.outreach.noJobsSub",
                        "Queue a DM, friend request, or group comment for review.",
                      )}
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{"Lead"}</TableHead>
                          <TableHead>
                            {t("merchant.outreach.colKind", "Kind")}
                          </TableHead>
                          <TableHead>
                            {t("merchant.outreach.colAccount", "Account")}
                          </TableHead>
                          <TableHead>{"Status"}</TableHead>
                          <TableHead>
                            {t("merchant.outreach.colActions", "Actions")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {jobs.map((j) => (
                          <TableRow key={j.id}>
                            <TableCell>
                              <div className="font-medium">
                                {j.leadAuthorName}
                              </div>
                              <div className="max-w-xs truncate text-text-muted text-xs">
                                {j.leadText}
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge variant="secondary">
                                {t(
                                  // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in JOB_KIND_LABEL
                                  JOB_KIND_LABEL[j.kind] ?? j.kind,
                                  j.kind,
                                )}
                              </Badge>
                            </TableCell>
                            <TableCell>{j.accountHandle}</TableCell>
                            <TableCell>
                              <Badge variant={JOB_STATUS_VARIANT[j.status]}>
                                {t(
                                  // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in JOB_STATUS_LABEL
                                  JOB_STATUS_LABEL[j.status] ?? j.status,
                                  j.status,
                                )}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                {j.status === "QUEUED" && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => void jobAction(j, "approve")}
                                  >
                                    {t("merchant.outreach.approve", "Approve")}
                                  </Button>
                                )}
                                {j.status === "READY_FOR_MANUAL" && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      void jobAction(j, "mark-sent")
                                    }
                                  >
                                    {t(
                                      "merchant.outreach.markSent",
                                      "Mark sent",
                                    )}
                                  </Button>
                                )}
                                {(j.status === "QUEUED" ||
                                  j.status === "APPROVED" ||
                                  j.status === "READY_FOR_MANUAL") && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => void jobAction(j, "cancel")}
                                  >
                                    {t("common.cancel", "Cancel")}
                                  </Button>
                                )}
                                {j.status === "FAILED" && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => void jobAction(j, "requeue")}
                                  >
                                    {t("merchant.outreach.requeue", "Requeue")}
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </DataBoundary>
      </div>

      <AccountModal modal={accountModal} onCreated={reload} />
      <JobModal modal={jobModal} accounts={accounts} onCreated={reload} />
      <ConfirmDialog modal={confirm} />
    </PageContainer>
  );
}
