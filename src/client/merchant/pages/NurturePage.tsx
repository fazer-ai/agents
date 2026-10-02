import type { TFunction } from "i18next";
import { Pencil, Sprout, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  EmptyState,
  PageContainer,
  Select,
  useModalController,
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
import { NurtureOutboxCard } from "./NurtureOutboxCard";
import {
  NurtureSequenceModal,
  type NurtureSequencePayload,
} from "./NurtureSequenceModal";

import "@/client/merchant/index.css";

// Nurture: operator-authored follow-up sequences walked per enrolled lead by
// the scheduler drain. The outbox is the daily queue - every staged body is
// delivered BY HAND off-platform (copy it out, mark it sent); nothing here
// ever posts to an external service.

type SequencesData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.nurture.sequences)["get"]>
>["data"];
type Sequence = NonNullable<SequencesData>["sequences"][number];
type EnrollmentsData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.nurture.enrollments)["get"]>
>["data"];
type Enrollment = NonNullable<EnrollmentsData>["enrollments"][number];
type OutboxData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.nurture.outbox)["get"]>
>["data"];
type OutboxItem = NonNullable<OutboxData>["outbox"][number];
type LeadsData = Awaited<
  ReturnType<(typeof api.api.v1.merchant.leads)["get"]>
>["data"];
type Lead = NonNullable<LeadsData>["leads"][number];

const ENROLLMENT_STATUS_VARIANT: Record<
  Enrollment["status"],
  "success" | "info" | "secondary" | "warning" | "error"
> = {
  ACTIVE: "info",
  DONE: "success",
  CANCELLED: "secondary",
};

// t('merchant.nurture.status.active', 'Active')
// t('merchant.nurture.status.done', 'Done')
// t('merchant.nurture.status.cancelled', 'Cancelled')
function enrollmentStatusLabel(t: TFunction, status: string): string {
  // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments above
  return t(`merchant.nurture.status.${status.toLowerCase()}`, status);
}

export function NurturePage() {
  const { t, i18n } = useTranslation();
  const { showToast } = useToast();
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [enrollSeq, setEnrollSeq] = useState("");
  const [enrollLeadId, setEnrollLeadId] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const editModal = useModalController<NurtureSequencePayload>();
  const confirm = useModalController<ConfirmPayload>();

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [seqRes, enrRes, outRes, leadRes] = await Promise.all([
        api.api.v1.merchant.nurture.sequences.get(),
        api.api.v1.merchant.nurture.enrollments.get({
          query: { limit: "100" },
        }),
        api.api.v1.merchant.nurture.outbox.get({
          query: { status: "PENDING", limit: "100" },
        }),
        api.api.v1.merchant.leads.get({ query: { limit: "100" } }),
      ]);
      if (seqRes.error || enrRes.error || outRes.error || leadRes.error) {
        setError(true);
        return;
      }
      setSequences(seqRes.data?.sequences ?? []);
      setEnrollments(enrRes.data?.enrollments ?? []);
      setOutbox(outRes.data?.outbox ?? []);
      setLeads(leadRes.data?.leads ?? []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const enroll = async () => {
    if (enrollSeq === "" || enrollLeadId === "") return;
    setEnrolling(true);
    try {
      const { error: err } = await api.api.v1.merchant.nurture.enrollments.post(
        { sequenceId: enrollSeq, leadId: enrollLeadId },
      );
      if (err) {
        showToast(
          apiErrorMessage(err) ??
            t("merchant.nurture.enrollFailed", "Could not enroll the lead"),
          "error",
        );
        return;
      }
      showToast(t("merchant.nurture.enrolled", "Lead enrolled"), "success");
      setEnrollLeadId("");
      void fetchAll();
    } catch {
      showToast(
        t("merchant.nurture.enrollFailed", "Could not enroll the lead"),
        "error",
      );
    } finally {
      setEnrolling(false);
    }
  };

  const cancelEnrollment = async (enrollment: Enrollment) => {
    const { error: err } = await api.api.v1.merchant.nurture
      .enrollments({ id: enrollment.id })
      .delete();
    if (err) {
      showToast(
        apiErrorMessage(err) ??
          t("merchant.nurture.cancelFailed", "Could not cancel"),
        "error",
      );
      return;
    }
    void fetchAll();
  };

  const requestDeleteSequence = (seq: Sequence) => {
    confirm.open({
      title: t("merchant.nurture.deleteTitle", "Delete sequence"),
      message: t(
        "merchant.nurture.deleteMessage",
        "Its enrollments and staged outbox rows are deleted with it.",
      ),
      confirmLabel: t("common.delete", "Delete"),
      danger: true,
      onConfirm: async () => {
        const { error: err } = await api.api.v1.merchant.nurture
          .sequences({ id: seq.id })
          .delete();
        if (err) {
          showToast(
            apiErrorMessage(err) ??
              t("merchant.nurture.deleteFailed", "Could not delete"),
            "error",
          );
          throw new Error("delete failed");
        }
        showToast(t("merchant.nurture.deleted", "Sequence deleted"), "success");
        void fetchAll();
      },
    });
  };

  const activeSequences = sequences.filter((s) => s.active);

  return (
    <PageContainer size="wide">
      <div className="flex items-center justify-between gap-4 py-4">
        <div>
          <h1 className="font-semibold text-text-primary text-xl">
            {t("merchant.nurture.title", "Nurture")}
          </h1>
          <p className="text-sm text-text-secondary">
            {t(
              "merchant.nurture.subtitle",
              "Follow-up sequences staged per lead. Every message is sent by hand from the outbox.",
            )}
          </p>
        </div>
        <Button onClick={() => editModal.open({})}>
          {t("merchant.nurture.create", "New sequence")}
        </Button>
      </div>

      <NurtureSequenceModal
        modal={editModal}
        onSaved={() => {
          showToast(t("merchant.nurture.saved", "Sequence saved"), "success");
          void fetchAll();
        }}
      />
      <ConfirmDialog modal={confirm} />

      <div className="flex flex-col gap-6 pb-8">
        <NurtureOutboxCard
          items={outbox}
          loading={loading}
          error={error}
          onRetry={() => void fetchAll()}
          onChanged={() => void fetchAll()}
        />

        <Card>
          <CardHeader>
            <CardTitle>
              {t("merchant.nurture.sequencesTitle", "Sequences")}
            </CardTitle>
            <CardDescription>
              {t(
                "merchant.nurture.sequencesSubtitle",
                "Ordered follow-up steps; each delay is relative to the previous step.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DataBoundary
              loading={loading}
              error={error}
              isEmpty={sequences.length === 0}
              onRetry={() => void fetchAll()}
              empty={
                <EmptyState
                  icon={Sprout}
                  title={t("merchant.nurture.emptyTitle", "No sequences yet")}
                  description={t(
                    "merchant.nurture.emptyDescription",
                    "Create a sequence, then enroll leads to start staging follow-ups.",
                  )}
                />
              }
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {t("merchant.nurture.colName", "Name")}
                    </TableHead>
                    <TableHead>
                      {t("merchant.nurture.colSteps", "Steps")}
                    </TableHead>
                    <TableHead>
                      {t("merchant.nurture.colActive", "Active")}
                    </TableHead>
                    <TableHead>
                      {t("merchant.nurture.colEnrolled", "Enrolled")}
                    </TableHead>
                    <TableHead>
                      {t("merchant.nurture.colCreated", "Created")}
                    </TableHead>
                    <TableHead>
                      {t("merchant.nurture.colActions", "Actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sequences.map((seq) => (
                    <TableRow key={seq.id}>
                      <TableCell className="font-medium">{seq.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {seq.steps.length}
                      </TableCell>
                      <TableCell>
                        {seq.active ? (
                          <Badge variant="success">
                            {t("merchant.nurture.active", "On")}
                          </Badge>
                        ) : (
                          <Badge variant="secondary">
                            {t("merchant.nurture.paused", "Paused")}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {seq.activeEnrollments}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(seq.createdAt, i18n.language)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => editModal.open({ sequence: seq })}
                            aria-label={t("common.edit", "Edit")}
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => requestDeleteSequence(seq)}
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

        <Card>
          <CardHeader>
            <CardTitle>
              {t("merchant.nurture.enrollmentsTitle", "Enrollments")}
            </CardTitle>
            <CardDescription>
              {t(
                "merchant.nurture.enrollmentsSubtitle",
                "One active enrollment per lead per sequence; the drain walks each through the steps.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Select
                value={enrollSeq}
                onChange={(e) => setEnrollSeq(e.target.value)}
                aria-label={t("merchant.nurture.pickSequence", "Sequence")}
              >
                <option value="">
                  {t("merchant.nurture.pickSequence", "Sequence")}
                </option>
                {activeSequences.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <Select
                value={enrollLeadId}
                onChange={(e) => setEnrollLeadId(e.target.value)}
                aria-label={t("merchant.nurture.pickLead", "Lead")}
              >
                <option value="">
                  {t("merchant.nurture.pickLead", "Lead")}
                </option>
                {leads.map((lead) => (
                  <option key={lead.id} value={lead.id}>
                    {`${lead.authorName} (${lead.platform})`}
                  </option>
                ))}
              </Select>
              <Button
                variant="secondary"
                size="sm"
                disabled={enrollSeq === "" || enrollLeadId === "" || enrolling}
                onClick={() => void enroll()}
              >
                {enrolling
                  ? t("merchant.nurture.enrolling", "Enrolling...")
                  : t("merchant.nurture.enroll", "Enroll")}
              </Button>
            </div>
            <DataBoundary
              loading={loading}
              error={error}
              isEmpty={enrollments.length === 0}
              onRetry={() => void fetchAll()}
              empty={
                <EmptyState
                  icon={Sprout}
                  title={t(
                    "merchant.nurture.enrollmentsEmpty",
                    "No enrollments",
                  )}
                  description={t(
                    "merchant.nurture.enrollmentsEmptyDescription",
                    "Pick a sequence and a lead above.",
                  )}
                />
              }
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      {t("merchant.nurture.colLead", "Lead")}
                    </TableHead>
                    <TableHead>
                      {t("merchant.nurture.colSequence", "Sequence")}
                    </TableHead>
                    <TableHead>
                      {t("merchant.nurture.colStep", "Step")}
                    </TableHead>
                    <TableHead>
                      {t("merchant.nurture.colNextRun", "Next run")}
                    </TableHead>
                    <TableHead>
                      {t("merchant.nurture.colStatus", "Status")}
                    </TableHead>
                    <TableHead>
                      {t("merchant.nurture.colActions", "Actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {enrollments.map((en) => (
                    <TableRow key={en.id}>
                      <TableCell className="font-medium">
                        {en.leadAuthorName}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {en.sequenceName}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {`${Math.min(en.stepIndex + 1, en.stepCount)}/${en.stepCount}`}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {en.status === "ACTIVE"
                          ? formatDateTime(en.nextRunAt, i18n.language)
                          : "-"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={ENROLLMENT_STATUS_VARIANT[en.status]}>
                          {enrollmentStatusLabel(t, en.status)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {en.status === "ACTIVE" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void cancelEnrollment(en)}
                          >
                            {t("merchant.nurture.cancelEnrollment", "Cancel")}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </DataBoundary>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
