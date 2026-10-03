import { Plus, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  Select,
  Switch,
  Textarea,
  useOnModalOpen,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";

// Create/edit dialog for one nurture sequence: name, active flag and the
// ordered step list (delay + channel + body template the drain renders per
// lead). Steps are edited as plain rows; saving posts the whole list.

export interface NurtureStepDraft {
  delayMin: string;
  channel: "dm" | "reply";
  bodyTemplate: string;
}

// The fields the dialog reads off a sequence row; the page's treaty-derived
// DTO carries more, which is fine structurally.
export interface NurtureSequenceLike {
  id: string;
  name: string;
  active: boolean;
  steps: unknown;
}

export interface NurtureSequencePayload {
  sequence?: NurtureSequenceLike;
}

const EMPTY_STEP: NurtureStepDraft = {
  delayMin: "60",
  channel: "dm",
  bodyTemplate: "",
};

function stepsFromJson(raw: unknown): NurtureStepDraft[] {
  if (!Array.isArray(raw)) return [{ ...EMPTY_STEP }];
  const steps = raw
    .map((s) => {
      if (typeof s !== "object" || s === null) return null;
      const r = s as Record<string, unknown>;
      return {
        delayMin: String(typeof r.delayMin === "number" ? r.delayMin : 60),
        channel: (r.channel === "reply" ? "reply" : "dm") as "dm" | "reply",
        bodyTemplate: typeof r.bodyTemplate === "string" ? r.bodyTemplate : "",
      };
    })
    .filter((s): s is NurtureStepDraft => s !== null);
  return steps.length === 0 ? [{ ...EMPTY_STEP }] : steps;
}

export function NurtureSequenceModal({
  modal,
  onSaved,
}: {
  modal: ModalController<NurtureSequencePayload>;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const activeId = useId();
  const editing = modal.payload?.sequence;
  const [name, setName] = useState("");
  const [active, setActive] = useState(true);
  const [steps, setSteps] = useState<NurtureStepDraft[]>([{ ...EMPTY_STEP }]);
  const baseline = useRef("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useOnModalOpen(modal, () => {
    setError("");
    const seq = modal.payload?.sequence;
    const nextSteps = stepsFromJson(seq?.steps);
    setName(seq?.name ?? "");
    setActive(seq?.active ?? true);
    setSteps(nextSteps);
    baseline.current = JSON.stringify({
      name: seq?.name ?? "",
      active: seq?.active ?? true,
      steps: nextSteps,
    });
  });

  const isDirty = JSON.stringify({ name, active, steps }) !== baseline.current;

  const setStep = <K extends keyof NurtureStepDraft>(
    index: number,
    key: K,
    value: NurtureStepDraft[K],
  ) =>
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, [key]: value } : s)),
    );

  const canSubmit =
    name.trim() !== "" &&
    steps.length >= 1 &&
    steps.every((s) => {
      const n = Number.parseInt(s.delayMin, 10);
      return (
        Number.isFinite(n) &&
        n >= 0 &&
        n <= 43200 &&
        s.bodyTemplate.trim() !== ""
      );
    });

  const handleSubmit = async () => {
    setError("");
    setLoading(true);
    const body = {
      name: name.trim(),
      active,
      steps: steps.map((s) => ({
        delayMin: Number.parseInt(s.delayMin, 10),
        channel: s.channel,
        bodyTemplate: s.bodyTemplate.trim(),
      })),
    };
    try {
      const { error: err } = editing
        ? await api.api.v1.merchant.nurture
            .sequences({ id: editing.id })
            .patch(body)
        : await api.api.v1.merchant.nurture.sequences.post(body);
      if (err) {
        setError(
          apiErrorMessage(err) ??
            t("merchant.nurture.saveFailed", "Could not save the sequence"),
        );
        return;
      }
      onSaved();
      modal.close();
    } catch {
      setError(t("merchant.nurture.saveFailed", "Could not save the sequence"));
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
          ? t("merchant.nurture.editTitle", "Edit sequence")
          : t("merchant.nurture.createTitle", "New nurture sequence")
      }
      description={t(
        "merchant.nurture.dialogSubtitle",
        "Steps run in order per enrolled lead; each staged message lands in the outbox for a human to send.",
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
        <FormField label={t("merchant.nurture.fieldName", "Name")} required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t(
              "merchant.nurture.fieldNamePlaceholder",
              "e.g. Follow-up after first contact",
            )}
          />
        </FormField>

        <FormField label={t("merchant.nurture.fieldActive", "Active")}>
          <div className="flex h-9 items-center">
            <Switch
              id={activeId}
              checked={active}
              onCheckedChange={setActive}
              aria-label={t("merchant.nurture.fieldActive", "Active")}
            />
          </div>
        </FormField>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">
              {t("merchant.nurture.stepsTitle", "Steps")}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSteps((prev) => [...prev, { ...EMPTY_STEP }])}
              disabled={steps.length >= 20}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t("merchant.nurture.addStep", "Add step")}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            {t(
              "merchant.nurture.stepsHint",
              "{{name}}, {{product}} and {{platform}} are rendered per lead at send time.",
            )}
          </p>
          {steps.map((step, index) => (
            <div
              // Steps have no stable id; index order is the identity here.
              // biome-ignore lint/suspicious/noArrayIndexKey: ordered form rows
              key={index}
              className="flex flex-col gap-2 rounded-md border border-border p-3"
            >
              <div className="flex items-end gap-2">
                <span className="pb-2 text-muted-foreground text-xs">
                  {`#${index + 1}`}
                </span>
                <FormField
                  label={t("merchant.nurture.stepDelay", "Delay (min)")}
                  className="w-28"
                >
                  <Input
                    type="number"
                    min={0}
                    max={43200}
                    value={step.delayMin}
                    onChange={(e) => setStep(index, "delayMin", e.target.value)}
                  />
                </FormField>
                <FormField
                  label={t("merchant.nurture.stepChannel", "Channel")}
                  className="w-32"
                >
                  <Select
                    value={step.channel}
                    onChange={(e) =>
                      setStep(
                        index,
                        "channel",
                        e.target.value as "dm" | "reply",
                      )
                    }
                  >
                    <option value="dm">{"DM"}</option>
                    <option value="reply">
                      {t("merchant.nurture.channelReply", "Reply")}
                    </option>
                  </Select>
                </FormField>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSteps((prev) => prev.filter((_, i) => i !== index))
                  }
                  disabled={steps.length <= 1}
                  aria-label={t("common.delete", "Delete")}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
              <Textarea
                value={step.bodyTemplate}
                onChange={(e) => setStep(index, "bodyTemplate", e.target.value)}
                rows={3}
                placeholder={t(
                  "merchant.nurture.stepBodyPlaceholder",
                  "e.g. Hi {{name}}, the {{product}} you asked about is still available.",
                )}
              />
            </div>
          ))}
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
