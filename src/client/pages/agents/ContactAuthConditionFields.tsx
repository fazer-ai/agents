import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  Select,
  Textarea,
} from "@/client/components";
import {
  CONTACT_AUTH_IDENTIFIERS_TEXT_MAX,
  CONTACT_AUTH_LABEL_MAX,
  CONTACT_AUTH_PHONES_TEXT_MAX,
  CONTACT_AUTH_RULE_CONDITIONS_MAX,
} from "@/modules/contact-auth/settings";
import {
  type ContactAuthConditionForm,
  type ContactAuthRuleForm,
  contactAuthConditionInvalid,
  contactAuthRuleInvalid,
  newContactAuthConditionForm,
} from "./contactAuthRuleForm";

// The fields of ONE condition of the contact gate's local rule, by kind. Used for the rule itself and
// for each row of an `all` / `any` combination.
export function ContactAuthConditionFields({
  value,
  onChange,
  invalid,
}: {
  value: ContactAuthConditionForm;
  onChange: (next: ContactAuthConditionForm) => void;
  invalid: boolean;
}) {
  const { t } = useTranslation();
  const set = (patch: Partial<ContactAuthConditionForm>) =>
    onChange({ ...value, ...patch });

  if (value.ruleKind === "allowlist") {
    return (
      <>
        <FormField
          label={t("editor.contactAuthRulePhones", "Phones")}
          description={t(
            "editor.contactAuthRulePhonesHint",
            "One per line, with the country code (+55 11 99999-0000). Compared by digits, never by the end of the number.",
          )}
          error={
            invalid
              ? t(
                  "editor.contactAuthRuleListInvalid",
                  "The list needs 1 to 500 entries in total; each phone needs 8 to 15 digits and each identifier at most 200 characters.",
                )
              : null
          }
        >
          <Textarea
            rows={4}
            maxLength={CONTACT_AUTH_PHONES_TEXT_MAX}
            value={value.rulePhones}
            onChange={(e) => set({ rulePhones: e.target.value })}
            placeholder="+55 11 99999-0000"
          />
        </FormField>
        <FormField
          label={t("editor.contactAuthRuleIdentifiers", "Identifiers")}
          description={t(
            "editor.contactAuthRuleIdentifiersHint",
            "One per line: the contact's identifier in Chatwoot, compared exactly.",
          )}
        >
          <Textarea
            rows={3}
            maxLength={CONTACT_AUTH_IDENTIFIERS_TEXT_MAX}
            value={value.ruleIdentifiers}
            onChange={(e) => set({ ruleIdentifiers: e.target.value })}
          />
        </FormField>
      </>
    );
  }
  if (value.ruleKind === "attribute") {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label={t("editor.contactAuthRuleScope", "Attribute of")}>
          <Select
            value={value.ruleScope}
            onChange={(e) => set({ ruleScope: e.target.value })}
          >
            <option value="contact">
              {t("editor.contactAuthRuleScopeContact", "Contact")}
            </option>
            <option value="conversation">
              {t("editor.contactAuthRuleScopeConversation", "Conversation")}
            </option>
          </Select>
        </FormField>
        <FormField
          label={t("editor.contactAuthRuleKey", "Attribute key")}
          error={
            invalid ? t("editor.contactAuthRuleKeyRequired", "Required.") : null
          }
        >
          <Input
            value={value.ruleKey}
            onChange={(e) => set({ ruleKey: e.target.value })}
            placeholder="plano"
          />
        </FormField>
        <FormField
          label={t("editor.contactAuthRuleEquals", "Equal to")}
          description={t(
            "editor.contactAuthRuleEqualsHint",
            "Empty: any value counts.",
          )}
        >
          <Input
            value={value.ruleEquals}
            onChange={(e) => set({ ruleEquals: e.target.value })}
            placeholder="ativo"
          />
        </FormField>
      </div>
    );
  }
  if (value.ruleKind === "conversation_type") {
    return (
      <FormField
        label={t("editor.contactAuthRuleConversationType", "Conversation type")}
        description={t(
          "editor.contactAuthRuleConversationTypeHint",
          "A WhatsApp group or a one-to-one chat, as Chatwoot marks the conversation.",
        )}
      >
        <Select
          value={value.ruleConversationType}
          onChange={(e) => set({ ruleConversationType: e.target.value })}
        >
          <option value="group">
            {t("editor.contactAuthRuleConversationTypeGroup", "Group")}
          </option>
          <option value="individual">
            {t(
              "editor.contactAuthRuleConversationTypeIndividual",
              "One-to-one",
            )}
          </option>
        </Select>
      </FormField>
    );
  }
  if (value.ruleKind === "label") {
    return (
      <FormField
        label={t("editor.contactAuthRuleLabel", "Label")}
        description={t(
          "editor.contactAuthRuleLabelHint",
          "The conversation carries this Chatwoot label. Compared without case.",
        )}
        error={
          invalid ? t("editor.contactAuthRuleKeyRequired", "Required.") : null
        }
      >
        <Input
          value={value.ruleLabel}
          maxLength={CONTACT_AUTH_LABEL_MAX}
          onChange={(e) => set({ ruleLabel: e.target.value })}
          placeholder="suporte"
        />
      </FormField>
    );
  }
  return null;
}

// The rows of an `all` / `any` rule: a kind per row, its fields, remove, and add up to the cap.
export function ContactAuthConditionList({
  form,
  onChange,
  showErrors,
}: {
  form: ContactAuthRuleForm;
  onChange: (next: ContactAuthRuleForm) => void;
  showErrors: boolean;
}) {
  const { t } = useTranslation();
  const rows = form.ruleConditions;
  const setRow = (index: number, next: ContactAuthConditionForm) =>
    onChange({
      ...form,
      ruleConditions: rows.map((r, i) => (i === index ? next : r)),
    });
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: conditions are positional (no stable id); reorder is add/remove only
          key={index}
          className="flex flex-col gap-3 rounded-lg border border-border bg-bg-secondary p-3"
        >
          <div className="flex items-end gap-2">
            <FormField
              className="flex-1"
              label={t("editor.contactAuthRuleCondition", "Condition {{n}}", {
                n: index + 1,
              })}
            >
              <Select
                value={row.ruleKind}
                onChange={(e) =>
                  setRow(index, { ...row, ruleKind: e.target.value })
                }
              >
                <ConditionKindOptions />
              </Select>
            </FormField>
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...form,
                  ruleConditions: rows.filter((_, i) => i !== index),
                })
              }
              aria-label={t(
                "editor.contactAuthRuleRemoveCondition",
                "Remove condition",
              )}
              className="mb-0.5 flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:text-error"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <ContactAuthConditionFields
            value={row}
            onChange={(next) => setRow(index, next)}
            invalid={showErrors && contactAuthConditionInvalid(row)}
          />
        </div>
      ))}
      {showErrors && rows.length === 0 && (
        <p className="text-error text-xs">
          {t(
            "editor.contactAuthRuleConditionsEmpty",
            "Add at least one condition.",
          )}
        </p>
      )}
      {showErrors &&
        rows.length > 0 &&
        !rows.some(contactAuthConditionInvalid) &&
        contactAuthRuleInvalid(form) && (
          <p className="text-error text-xs">
            {t(
              "editor.contactAuthRuleListsTooLong",
              "The lists in this rule hold more than 500 entries in total.",
            )}
          </p>
        )}
      {rows.length < CONTACT_AUTH_RULE_CONDITIONS_MAX && (
        <div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              onChange({
                ...form,
                ruleConditions: [...rows, newContactAuthConditionForm()],
              })
            }
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("editor.contactAuthRuleAddCondition", "Add condition")}
          </Button>
        </div>
      )}
    </div>
  );
}

// The four plain kinds, shared by the rule's own picker and each row of a combination.
export function ConditionKindOptions() {
  const { t } = useTranslation();
  return (
    <>
      <option value="conversation_type">
        {t("editor.contactAuthSourceConversationType", "The conversation type")}
      </option>
      <option value="label">
        {t("editor.contactAuthSourceLabel", "A conversation label")}
      </option>
      <option value="allowlist">
        {t(
          "editor.contactAuthSourceAllowlist",
          "A list of phones or identifiers",
        )}
      </option>
      <option value="attribute">
        {t(
          "editor.contactAuthSourceAttribute",
          "A contact or conversation attribute",
        )}
      </option>
    </>
  );
}
