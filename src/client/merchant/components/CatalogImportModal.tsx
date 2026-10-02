import { FileUp } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Modal,
  ModalCancelButton,
  type ModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { Button } from "@/client/merchant/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/merchant/components/ui/table";

// CSV catalog import, two steps in one modal: pick a file -> dry-run preview
// (parsed rows + per-line errors, nothing written) -> confirm writes the rows
// and kicks off LLM auto-tagging server-side.

type ImportResponse = Awaited<
  ReturnType<(typeof api.api.v1.merchant.products.import)["post"]>
>["data"];
type PreviewRow = NonNullable<ImportResponse>["rows"][number];

export function CatalogImportModal({
  modal,
  onImported,
}: {
  modal: ModalController<void>;
  onImported: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [okCount, setOkCount] = useState(0);
  const [busy, setBusy] = useState<"idle" | "preview" | "apply">("idle");
  const [error, setError] = useState<string | null>(null);

  // Fresh session per open: the previous file/preview must not bleed through.
  useOnModalOpen(modal, () => {
    setFile(null);
    setRows([]);
    setOkCount(0);
    setBusy("idle");
    setError(null);
    if (fileRef.current) fileRef.current.value = "";
  });

  async function preview(f: File) {
    setBusy("preview");
    setError(null);
    const { data, error: err } = await api.api.v1.merchant.products.import.post(
      { file: f },
      { query: { dryRun: "true" } },
    );
    setBusy("idle");
    if (err || !data) {
      setError(apiErrorMessage(err) ?? String(err));
      setRows([]);
      return;
    }
    setRows(data.rows);
    setOkCount(data.ok);
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    await preview(f);
  }

  async function confirm() {
    if (!file) return;
    setBusy("apply");
    setError(null);
    const { data, error: err } = await api.api.v1.merchant.products.import.post(
      { file },
    );
    setBusy("idle");
    if (err || !data) {
      setError(apiErrorMessage(err) ?? String(err));
      return;
    }
    showToast(
      t(
        "merchant.catalog.import.done",
        "Imported {{created}} new, updated {{updated}}. Auto-tagging is running in the background.",
        {
          created: data.result?.created ?? 0,
          updated: data.result?.updated ?? 0,
        },
      ),
      "success",
    );
    modal.close();
    onImported();
  }

  return (
    <Modal
      modal={modal}
      title={t("merchant.catalog.import.title", "Import products from CSV")}
      description={t(
        "merchant.catalog.import.subtitle",
        "Header row: name,price,stock,description,tags (tags split on |). Preview shows what would be written before anything is saved.",
      )}
      size="xl"
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-text-secondary">
            {rows.length > 0 &&
              t(
                "merchant.catalog.import.previewSummary",
                "{{ok}} of {{total}} rows ready to import.",
                { ok: okCount, total: rows.length },
              )}
          </span>
          <div className="flex gap-2">
            <ModalCancelButton disabled={busy !== "idle"} />
            <Button
              onClick={() => void confirm()}
              disabled={!file || busy !== "idle" || okCount === 0}
            >
              {busy === "apply"
                ? t("merchant.catalog.import.importing", "Importing…")
                : t("merchant.catalog.import.confirm", "Import")}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => void onPick(e)}
          />
          <Button
            variant="outline"
            onClick={() => fileRef.current?.click()}
            disabled={busy !== "idle"}
          >
            <FileUp className="size-4" />
            {file
              ? file.name
              : t("merchant.catalog.import.pickFile", "Choose CSV file")}
          </Button>
        </div>

        {busy === "preview" && (
          <p className="text-sm text-text-secondary">
            {t("merchant.catalog.import.parsing", "Parsing…")}
          </p>
        )}
        {error && <p className="text-error text-sm">{error}</p>}

        {rows.length > 0 && (
          <div className="max-h-80 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    {t("merchant.catalog.import.colLine", "Line")}
                  </TableHead>
                  <TableHead>{t("merchant.catalog.colName", "Name")}</TableHead>
                  <TableHead>
                    {t("merchant.catalog.colPrice", "Price")}
                  </TableHead>
                  <TableHead>
                    {t("merchant.catalog.colStock", "Stock")}
                  </TableHead>
                  <TableHead>{t("merchant.catalog.colTags", "Tags")}</TableHead>
                  <TableHead>
                    {t("merchant.catalog.import.colErrors", "Errors")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.line}>
                    <TableCell className="text-muted-foreground">
                      {r.line}
                    </TableCell>
                    <TableCell className="font-medium">
                      {r.data?.name ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.data ? r.data.price : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.data ? r.data.stock : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {r.data?.tags.map((tag) => (
                          <Badge key={tag} variant="secondary">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="max-w-60">
                      {r.errors.length > 0 ? (
                        <span className="text-error text-xs">
                          {r.errors.join("; ")}
                        </span>
                      ) : (
                        <Badge variant="success">
                          {t("merchant.catalog.import.rowOk", "OK")}
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </Modal>
  );
}
