import { useTranslation } from "react-i18next";
import { FormField, Input, NumberInput, Select } from "@/client/components";
import type { FieldRefusal } from "@/client/hooks/useFieldRefusal";
import { SIGNATURE_MAX_AGE_SECONDS_MAX } from "@/modules/webhooks/inbound/signed-message";

const MAX_AGE_RANGE = { min: 1, max: SIGNATURE_MAX_AGE_SECONDS_MAX, int: true };

// The HMAC webhook's signature, when the sender signs something other than the raw body
// (`config.signatureHeader` + `config.signature`, read by src/modules/webhooks/inbound/signed-message.ts).
// Every input writes straight into the instance config; the server parses and refuses it, naming the
// field, and these names are the ones a refusal lands on.
export const SIGNATURE_FIELDS = [
  "config.signatureHeader",
  "config.signature.format",
  "config.signature.signaturePart",
  "config.signature.timestampPart",
  "config.signature.message",
  "config.signature.maxAgeSeconds",
] as const;

type Signature = {
  format?: "hex" | "parts";
  signaturePart?: string;
  timestampPart?: string;
  message?: string;
  maxAgeSeconds?: number;
};

function readSignature(cfg: Record<string, unknown>): Signature {
  const s = cfg.signature;
  return s && typeof s === "object" && !Array.isArray(s)
    ? (s as Signature)
    : {};
}

// The refused values, keyed by the names above: what `useFieldRefusal` compares a refusal against.
export function signatureFieldValues(
  cfg: Record<string, unknown>,
): Record<(typeof SIGNATURE_FIELDS)[number], unknown> {
  const s = readSignature(cfg);
  return {
    "config.signatureHeader": cfg.signatureHeader,
    "config.signature.format": s.format,
    "config.signature.signaturePart": s.signaturePart,
    "config.signature.timestampPart": s.timestampPart,
    "config.signature.message": s.message,
    "config.signature.maxAgeSeconds": s.maxAgeSeconds,
  };
}

// An emptied input removes its key, and a signature left with no key is dropped, so an instance the
// operator never touched keeps signing the body exactly as before.
function withSignature(
  cfg: Record<string, unknown>,
  patch: Partial<Signature>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...readSignature(cfg), ...patch };
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === "") delete next[k];
  }
  if (next.format === "hex") delete next.format;
  return { signature: Object.keys(next).length ? next : undefined };
}

export function InboundSignatureFields({
  cfg,
  setCfg,
  refusal,
}: {
  cfg: Record<string, unknown>;
  setCfg: (patch: Record<string, unknown>) => void;
  refusal: FieldRefusal;
}) {
  const { t } = useTranslation();
  const s = readSignature(cfg);
  const parts = s.format === "parts";
  const values = signatureFieldValues(cfg);
  const errorAt = (field: (typeof SIGNATURE_FIELDS)[number]) =>
    refusal.at(field, values[field]);
  const header =
    typeof cfg.signatureHeader === "string" ? cfg.signatureHeader : "";

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label={t("integrations.signature.header", "Signature header")}
          description={t(
            "integrations.signature.headerHint",
            "The request header that carries the signature.",
          )}
          error={errorAt("config.signatureHeader")}
        >
          <Input
            value={header}
            placeholder="x-webhook-signature"
            className="font-mono text-xs"
            onChange={(e) =>
              setCfg({ signatureHeader: e.target.value || undefined })
            }
          />
        </FormField>
        <FormField
          label={t("integrations.signature.format", "Signature format")}
          error={errorAt("config.signature.format")}
        >
          <Select
            value={parts ? "parts" : "hex"}
            onChange={(e) =>
              setCfg(
                withSignature(
                  cfg,
                  e.target.value === "parts"
                    ? {
                        format: "parts",
                        signaturePart: s.signaturePart || "v1",
                      }
                    : {
                        format: "hex",
                        signaturePart: undefined,
                        timestampPart: undefined,
                        maxAgeSeconds: undefined,
                      },
                ),
              )
            }
          >
            <option value="hex">
              {t(
                "integrations.signature.formatHex",
                "The whole header (hex, optional sha256= prefix)",
              )}
            </option>
            <option value="parts">
              {t(
                "integrations.signature.formatParts",
                "Key=value parts (e.g. ts=…,v1=…)",
              )}
            </option>
          </Select>
        </FormField>
      </div>
      {parts && (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label={t(
              "integrations.signature.signaturePart",
              "Part with the signature",
            )}
            error={errorAt("config.signature.signaturePart")}
          >
            <Input
              value={s.signaturePart ?? ""}
              placeholder="v1"
              className="font-mono text-xs"
              onChange={(e) =>
                setCfg(withSignature(cfg, { signaturePart: e.target.value }))
              }
            />
          </FormField>
          <FormField
            label={t(
              "integrations.signature.timestampPart",
              "Part with the timestamp",
            )}
            description={t(
              "integrations.signature.timestampPartHint",
              "Optional. Needed to refuse old notifications.",
            )}
            error={errorAt("config.signature.timestampPart")}
          >
            <Input
              value={s.timestampPart ?? ""}
              placeholder="ts"
              className="font-mono text-xs"
              onChange={(e) =>
                setCfg(
                  withSignature(cfg, {
                    timestampPart: e.target.value,
                    ...(e.target.value ? {} : { maxAgeSeconds: undefined }),
                  }),
                )
              }
            />
          </FormField>
        </div>
      )}
      <FormField
        label={t("integrations.signature.message", "Signed message")}
        description={t(
          "integrations.signature.messageHint",
          "Empty means {{body}}, the raw body.",
          { body: "{{body}}" },
        )}
        help={t(
          "integrations.signature.messageHelp",
          "What the sender signs, written with placeholders: {{body}} is the raw body, {{header}} a request header, {{query}} a parameter of the webhook URL and {{sig}} a part of the signature header.\n\nAdd {{lower}} to lowercase a value. Wrap a piece in {{group}} to leave it out whole when a value inside is missing.\n\nThe provider's own documentation says what it signs.",
          {
            body: "{{body}}",
            header: "{{header.name}}",
            query: "{{query.name}}",
            sig: "{{sig.part}}",
            lower: "|lower",
            group: "[[ ]]",
          },
        )}
        error={errorAt("config.signature.message")}
      >
        <Input
          value={s.message ?? ""}
          placeholder="{{body}}"
          className="font-mono text-xs"
          aria-label={t("integrations.signature.message", "Signed message")}
          onChange={(e) =>
            setCfg(withSignature(cfg, { message: e.target.value }))
          }
        />
      </FormField>
      {parts && s.timestampPart && (
        <FormField
          label={t(
            "integrations.signature.maxAge",
            "Refuse notifications older than (seconds)",
          )}
          description={t(
            "integrations.signature.maxAgeHint",
            "Optional. Leave empty when the provider retries with the original timestamp.",
          )}
          error={errorAt("config.signature.maxAgeSeconds")}
        >
          <NumberInput
            range={MAX_AGE_RANGE}
            optional
            value={s.maxAgeSeconds ?? null}
            onChange={(e) =>
              setCfg(
                withSignature(cfg, {
                  maxAgeSeconds:
                    e.target.value === "" ? undefined : Number(e.target.value),
                }),
              )
            }
          />
        </FormField>
      )}
    </div>
  );
}
