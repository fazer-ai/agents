import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  Modal,
  type ModalController,
  Select,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import type { LogExportFormat } from "@/modules/flowlog/export";

// Export flow for the Logs page. Picks a time range (a bounded export is the default; exporting the
// whole retention window unfiltered rarely makes sense) plus a format (CSV/JSON), and downloads the
// log rows that match the on-page filters + the chosen range. The server bounds the dump and flags
// truncation. The serialized file rides back in the response body (`content`), which we turn into a
// Blob client-side, mirroring the agent-export download.

type Period = "last24h" | "last7d" | "last30d" | "all" | "custom";

const PRESET_DAYS: Partial<Record<Period, number>> = {
  last24h: 1,
  last7d: 7,
  last30d: 30,
};

// Resolves the picked period into ISO since/until bounds for the export query. Presets look back N
// days from now; "custom" honors whatever bounds the operator typed; "all" adds no date filter.
function rangeFor(
  period: Period,
  since: string,
  until: string,
  now: number,
): { since?: string; until?: string } {
  if (period === "all") return {};
  if (period === "custom") {
    const r: { since?: string; until?: string } = {};
    if (since) r.since = new Date(since).toISOString();
    if (until) r.until = new Date(until).toISOString();
    return r;
  }
  const days = PRESET_DAYS[period] ?? 7;
  return { since: new Date(now - days * 86_400_000).toISOString() };
}

export function LogsExportModal({
  modal,
  filters,
}: {
  modal: ModalController;
  // The active on-page filters, already keyed to the export endpoint's query params (source, and any
  // of stage/level/search/conversationId/turnId). Read at export time. The date range is added here.
  filters: Record<string, string>;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [period, setPeriod] = useState<Period>("last7d");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [format, setFormat] = useState<LogExportFormat>("csv");
  const [busy, setBusy] = useState(false);

  useOnModalOpen(modal, () => {
    setPeriod("last7d");
    setSince("");
    setUntil("");
    setFormat("csv");
    setBusy(false);
  });

  const run = async () => {
    setBusy(true);
    try {
      const query: Record<string, string> = {
        ...filters,
        ...rangeFor(period, since, until, Date.now()),
        format,
      };
      const { data, error } = await api.api.v1.logs.export.get({ query });
      if (error || !data) throw error ?? new Error("no data");
      const blob = new Blob([data.content], { type: data.contentType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename;
      a.click();
      URL.revokeObjectURL(url);
      if (data.count === 0) {
        showToast(
          t("logs.exportEmpty", "No log entries matched. Nothing to export."),
          "info",
        );
      } else if (data.truncated) {
        showToast(
          t(
            "logs.exportTruncated",
            "Exported the newest {{n}} entries (more matched the filters).",
            { n: data.count },
          ),
          "warning",
        );
      } else {
        showToast(
          t("logs.exportDone", "Exported {{n}} entries.", { n: data.count }),
          "success",
        );
      }
      modal.close();
    } catch (e) {
      showToast(
        apiErrorMessage(e) ||
          t("logs.exportError", "Could not export the logs."),
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      modal={modal}
      size="sm"
      title={t("logs.exportTitle", "Export logs")}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => modal.close()}
            disabled={busy}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <Button onClick={() => void run()} loading={busy}>
            {t("logs.exportAction", "Export")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label={t("logs.exportPeriod", "Time range")}>
          <Select
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
          >
            <option value="last24h">
              {t("logs.exportPeriodLast24h", "Last 24 hours")}
            </option>
            <option value="last7d">
              {t("logs.exportPeriodLast7d", "Last 7 days")}
            </option>
            <option value="last30d">
              {t("logs.exportPeriodLast30d", "Last 30 days")}
            </option>
            <option value="all">{t("logs.exportPeriodAll", "All time")}</option>
            <option value="custom">
              {t("logs.exportPeriodCustom", "Custom range")}
            </option>
          </Select>
        </FormField>

        {period === "custom" && (
          <div className="flex flex-col gap-3">
            <FormField label={t("logs.exportSince", "From")}>
              <Input
                type="datetime-local"
                value={since}
                max={until || undefined}
                onChange={(e) => setSince(e.target.value)}
              />
            </FormField>
            <FormField label={t("logs.exportUntil", "To")}>
              <Input
                type="datetime-local"
                value={until}
                min={since || undefined}
                onChange={(e) => setUntil(e.target.value)}
              />
            </FormField>
          </div>
        )}

        <FormField label={t("logs.exportFormat", "Format")}>
          <Select
            value={format}
            onChange={(e) => setFormat(e.target.value as LogExportFormat)}
          >
            <option value="csv">{t("logs.exportFormatCsv", "CSV")}</option>
            <option value="json">{t("logs.exportFormatJson", "JSON")}</option>
          </Select>
        </FormField>
      </div>
    </Modal>
  );
}
