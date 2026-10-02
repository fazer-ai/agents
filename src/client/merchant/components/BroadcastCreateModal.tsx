import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  Textarea,
  useOnModalOpen,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { Button } from "@/client/merchant/components/ui/button";

// Compose a broadcast: the template + the audience filter the server resolves
// ONCE into recipient rows. No send happens here - this only writes the
// composition the operator then works through by hand on the detail view.

const LEAD_STATUS_OPTIONS = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "CONVERTED",
  "DEAD",
] as const;
type LeadStatusOption = (typeof LEAD_STATUS_OPTIONS)[number];

interface FormState {
  name: string;
  body: string;
  minScore: string;
  tags: string;
  statuses: LeadStatusOption[];
}

const EMPTY: FormState = {
  name: "",
  body: "",
  minScore: "",
  tags: "",
  statuses: [],
};

export function BroadcastCreateModal({
  modal,
  onCreated,
}: {
  modal: ModalController<void>;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useOnModalOpen(modal, () => {
    setForm(EMPTY);
    setBusy(false);
    setError(null);
  });

  const canSubmit = form.name.trim() !== "" && form.body.trim() !== "";

  function toggleStatus(status: LeadStatusOption) {
    setForm((prev) => ({
      ...prev,
      statuses: prev.statuses.includes(status)
        ? prev.statuses.filter((s) => s !== status)
        : [...prev.statuses, status],
    }));
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const minScore = form.minScore.trim();
    const tags = form.tags
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const audienceFilter: {
      tags?: string[];
      minScore?: number;
      status?: LeadStatusOption[];
    } = {};
    if (minScore !== "") audienceFilter.minScore = Number(minScore);
    if (tags.length > 0) audienceFilter.tags = tags;
    if (form.statuses.length > 0) audienceFilter.status = form.statuses;
    const { data, error: err } = await api.api.v1.merchant.broadcasts.post({
      name: form.name.trim(),
      body: form.body,
      ...(Object.keys(audienceFilter).length > 0 ? { audienceFilter } : {}),
    });
    setBusy(false);
    if (err || !data) {
      setError(
        apiErrorMessage(err) ??
          t(
            "merchant.broadcasts.createFailed",
            "Could not create the broadcast",
          ),
      );
      return;
    }
    modal.close();
    onCreated();
  }

  return (
    <Modal
      modal={modal}
      title={t("merchant.broadcasts.createTitle", "New broadcast")}
      description={t(
        "merchant.broadcasts.createSubtitle",
        "The audience filter resolves once into a fixed recipient list. Tokens {{authorName}}, {{authorHandle}}, {{platform}}, {{groupName}} render per recipient.",
      )}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <ModalCancelButton disabled={busy} />
          <Button onClick={() => void submit()} disabled={!canSubmit || busy}>
            {busy
              ? t("merchant.broadcasts.creating", "Creating…")
              : t("merchant.broadcasts.createConfirm", "Create")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label={t("merchant.broadcasts.fieldName", "Name")} required>
          <Input
            value={form.name}
            maxLength={200}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, name: e.target.value }))
            }
            placeholder={t(
              "merchant.broadcasts.fieldNamePlaceholder",
              "e.g. Serum promo - hội mỹ phẩm",
            )}
          />
        </FormField>
        <FormField
          label={t("merchant.broadcasts.fieldBody", "Message template")}
          required
          description={t(
            "merchant.broadcasts.fieldBodyHint",
            "Written in Vietnamese sales tone; each recipient's copy renders with their own name/handle.",
          )}
        >
          <Textarea
            value={form.body}
            rows={5}
            maxLength={4000}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, body: e.target.value }))
            }
            placeholder="Chào {{authorName}}, em thấy anh/chị đang tìm…"
          />
        </FormField>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label={t("merchant.broadcasts.fieldMinScore", "Minimum score")}
            description={t(
              "merchant.broadcasts.fieldMinScoreHint",
              "Empty keeps every scored lead.",
            )}
          >
            <Input
              value={form.minScore}
              inputMode="numeric"
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  minScore: e.target.value.replace(/[^0-9]/g, ""),
                }))
              }
              placeholder="0"
            />
          </FormField>
          <FormField
            label={t("merchant.broadcasts.fieldTags", "Product tags")}
            description={t(
              "merchant.broadcasts.fieldTagsHint",
              "Comma separated; keeps leads matched to a product carrying ANY tag.",
            )}
          >
            <Input
              value={form.tags}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, tags: e.target.value }))
              }
              placeholder="serum, trị mụn"
            />
          </FormField>
        </div>
        <FormField
          label={t("merchant.broadcasts.fieldStatuses", "Lead statuses")}
          description={t(
            "merchant.broadcasts.fieldStatusesHint",
            "Nothing checked targets the active funnel: NEW, CONTACTED, QUALIFIED.",
          )}
          group
        >
          <div className="flex flex-wrap gap-2">
            {LEAD_STATUS_OPTIONS.map((status) => (
              <label
                key={status}
                className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-sm"
              >
                <input
                  type="checkbox"
                  checked={form.statuses.includes(status)}
                  onChange={() => toggleStatus(status)}
                />
                {
                  // t('merchant.leads.status.new', 'New')
                  // t('merchant.leads.status.contacted', 'Contacted')
                  // t('merchant.leads.status.qualified', 'Qualified')
                  // t('merchant.leads.status.converted', 'Converted')
                  // t('merchant.leads.status.dead', 'Dead')
                  // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments above
                  t(`merchant.leads.status.${status.toLowerCase()}`, status)
                }
              </label>
            ))}
          </div>
        </FormField>
        {error && <p className="text-error text-sm">{error}</p>}
      </div>
    </Modal>
  );
}
