import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  NumberInput,
  SwitchField,
  Textarea,
  useOnModalOpen,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { CLIENT_APP_RANGES } from "@/modules/client-apps/ranges";

export interface ClientAppView {
  id: string;
  name: string;
  publicId: string;
  allowedOrigins: string[];
  anonymousEnabled: boolean;
  anonSessionsPerHour: number;
  anonMessagesPerMin: number;
  anonExpiryDays: number;
  monthlyCeilingUsd: number | null;
  monthSpendUsd: number | null;
  turnstileEnabled: boolean;
  turnstileSiteKey: string | null;
  turnstileSecretSet: boolean;
}

// The defaults a new app starts with, and the ceilings the instance accepts.
const ANON_DEFAULTS = { sessions: 20, messages: 10, expiry: 30 };
const ANON_MAX = {
  sessions: CLIENT_APP_RANGES.anonSessionsPerHour.max,
  messages: CLIENT_APP_RANGES.anonMessagesPerMin.max,
  expiry: CLIENT_APP_RANGES.anonExpiryDays.max,
};

// The ceiling as typed: empty is none, otherwise dollars to the cent inside its range; undefined when
// the text is neither.
const ceilingOf = (text: string): number | null | undefined => {
  const v = text.trim().replace(",", ".");
  if (v === "") return null;
  const n = Number(v);
  const r = CLIENT_APP_RANGES.monthlyCeilingUsd;
  return /^\d+(\.\d{1,2})?$/.test(v) && n >= r.min && n <= r.max
    ? n
    : undefined;
};

// A limit as typed, or null when it is not a whole number inside its range.
const limitOf = (text: string, max: number) => {
  const n = Number(text);
  return /^\d+$/.test(text.trim()) && n >= 1 && n <= max ? n : null;
};

// What the modal was opened for: registering an app (mints its first key), editing one, or minting a
// new key for one. The first and the last ask the operator's password, as minting an API key does,
// and end on the key, shown once.
export type ClientAppModalPayload =
  | { mode: "create"; agentId: string }
  | { mode: "edit"; app: ClientAppView }
  | { mode: "rotate"; app: ClientAppView };

interface Minted {
  publicId: string;
  kid: string;
  secret: string;
}

const originsOf = (text: string) =>
  text
    .split(/\s+/)
    .map((o) => o.trim())
    .filter(Boolean);

export function ClientAppModal({
  modal,
  onSaved,
}: {
  modal: ModalController<ClientAppModalPayload>;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const payload = modal.payload;
  const [name, setName] = useState("");
  const [origins, setOrigins] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [sessions, setSessions] = useState(String(ANON_DEFAULTS.sessions));
  const [messages, setMessages] = useState(String(ANON_DEFAULTS.messages));
  const [expiry, setExpiry] = useState(String(ANON_DEFAULTS.expiry));
  const [ceiling, setCeiling] = useState("");
  const [turnstile, setTurnstile] = useState(false);
  const [siteKey, setSiteKey] = useState("");
  // Typed only to set or replace the stored secret, which never comes back.
  const [turnstileSecret, setTurnstileSecret] = useState("");
  const [password, setPassword] = useState("");
  const [minted, setMinted] = useState<Minted | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const session = useRef(0);

  useOnModalOpen(modal, () => {
    session.current += 1;
    const p = modal.payload;
    const app = p && p.mode !== "create" ? p.app : null;
    setName(app?.name ?? "");
    setOrigins(app?.allowedOrigins.join("\n") ?? "");
    setAnonymous(app?.anonymousEnabled ?? false);
    setSessions(String(app?.anonSessionsPerHour ?? ANON_DEFAULTS.sessions));
    setMessages(String(app?.anonMessagesPerMin ?? ANON_DEFAULTS.messages));
    setExpiry(String(app?.anonExpiryDays ?? ANON_DEFAULTS.expiry));
    setCeiling(
      app?.monthlyCeilingUsd == null ? "" : String(app.monthlyCeilingUsd),
    );
    setTurnstile(app?.turnstileEnabled ?? false);
    setSiteKey(app?.turnstileSiteKey ?? "");
    setTurnstileSecret("");
    setPassword("");
    setMinted(null);
    setError("");
    setLoading(false);
  });

  const mode = payload?.mode;
  const asksPassword = mode === "create" || mode === "rotate";
  const editsFields = mode === "create" || mode === "edit";
  const sessionsLimit = limitOf(sessions, ANON_MAX.sessions);
  const messagesLimit = limitOf(messages, ANON_MAX.messages);
  const expiryDays = limitOf(expiry, ANON_MAX.expiry);
  const ceilingUsd = ceilingOf(ceiling);
  const opened = payload && payload.mode !== "create" ? payload.app : null;
  const secretStored = opened?.turnstileSecretSet ?? false;
  // The challenge on needs both halves: the site key, and a secret typed now or already stored.
  const turnstileReady =
    !turnstile ||
    (siteKey.trim() !== "" && (turnstileSecret.trim() !== "" || secretStored));
  const canSubmit =
    (!editsFields ||
      (name.trim() !== "" &&
        originsOf(origins).length > 0 &&
        ceilingUsd !== undefined &&
        (!anonymous ||
          (sessionsLimit !== null &&
            messagesLimit !== null &&
            expiryDays !== null &&
            turnstileReady)))) &&
    (!asksPassword || password !== "");
  const fieldsMoved =
    mode === "create"
      ? name !== "" ||
        origins !== "" ||
        anonymous ||
        sessions !== String(ANON_DEFAULTS.sessions) ||
        messages !== String(ANON_DEFAULTS.messages) ||
        expiry !== String(ANON_DEFAULTS.expiry) ||
        ceiling !== "" ||
        turnstile ||
        siteKey !== "" ||
        turnstileSecret !== ""
      : mode === "edit" && opened !== null
        ? name !== opened.name ||
          originsOf(origins).join("\n") !== opened.allowedOrigins.join("\n") ||
          anonymous !== opened.anonymousEnabled ||
          sessions !== String(opened.anonSessionsPerHour) ||
          messages !== String(opened.anonMessagesPerMin) ||
          expiry !== String(opened.anonExpiryDays) ||
          ceiling !==
            (opened.monthlyCeilingUsd === null
              ? ""
              : String(opened.monthlyCeilingUsd)) ||
          turnstile !== opened.turnstileEnabled ||
          siteKey !== (opened.turnstileSiteKey ?? "") ||
          turnstileSecret !== ""
        : false;
  const isDirty = !minted && (password !== "" || fieldsMoved);

  const submit = async () => {
    if (!payload) return;
    const mine = session.current;
    const current = () => session.current === mine;
    setError("");
    setLoading(true);
    const failed = t("clientApps.saveFailed", "Could not save the application");
    try {
      const fields = {
        name: name.trim(),
        allowedOrigins: originsOf(origins),
        anonymousEnabled: anonymous,
        ...(ceilingUsd !== undefined && { monthlyCeilingUsd: ceilingUsd }),
        // NOTE: with anonymous visitors off the limits are hidden, so a draft left invalid there is
        // dropped instead of blocking the save; the stored value stays.
        ...(sessionsLimit !== null && { anonSessionsPerHour: sessionsLimit }),
        ...(messagesLimit !== null && { anonMessagesPerMin: messagesLimit }),
        ...(expiryDays !== null && { anonExpiryDays: expiryDays }),
        // NOTE: the challenge sits under anonymous visitors, so with them off it is left as stored.
        // An empty secret field keeps the stored secret.
        ...(anonymous && {
          turnstileEnabled: turnstile,
          turnstileSiteKey: siteKey.trim() === "" ? null : siteKey.trim(),
          ...(turnstileSecret.trim() !== "" && {
            turnstileSecret: turnstileSecret.trim(),
          }),
        }),
      };
      if (payload.mode === "create") {
        const { data, error: e } = await api.api.v1["client-apps"].post({
          agentId: payload.agentId,
          ...fields,
          password,
        });
        if (!current()) return;
        if (e || !data) return setError(apiErrorMessage(e) ?? failed);
        setMinted({ publicId: data.clientApp.publicId, ...data.secret });
      } else if (payload.mode === "edit") {
        const { error: e } = await api.api.v1["client-apps"]({
          id: payload.app.id,
        }).patch(fields);
        if (!current()) return;
        if (e) return setError(apiErrorMessage(e) ?? failed);
        modal.close();
      } else {
        const { data, error: e } = await api.api.v1["client-apps"]({
          id: payload.app.id,
        }).secrets.post({ password });
        if (!current()) return;
        if (e || !data) return setError(apiErrorMessage(e) ?? failed);
        setMinted({ publicId: data.clientApp.publicId, ...data.secret });
      }
      setPassword("");
      onSaved();
    } catch (e) {
      if (current()) setError(apiErrorMessage(e) ?? failed);
    } finally {
      if (current()) setLoading(false);
    }
  };

  const title =
    mode === "create"
      ? t("clientApps.createTitle", "New embedding application")
      : mode === "edit"
        ? t("clientApps.editTitle", "Edit application")
        : t("clientApps.rotateTitle", "New key");

  return (
    <Modal
      modal={modal}
      title={title}
      size="md"
      unsavedChanges={isDirty && !loading}
      busy={loading}
    >
      {minted ? (
        <MintedKey minted={minted} onDone={modal.close} />
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!loading && canSubmit) void submit();
          }}
        >
          {error && (
            <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
              {error}
            </div>
          )}
          {mode === "rotate" && (
            <p className="text-sm text-text-secondary">
              {t(
                "clientApps.rotateHint",
                "The new key becomes the current one. The previous key keeps working for 24 hours, so users already signed in stay signed in while you deploy the new one.",
              )}
            </p>
          )}
          {editsFields && (
            <>
              <FormField label={t("clientApps.name", "Name")} required>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={loading}
                  placeholder={t("clientApps.namePlaceholder", "My app")}
                />
              </FormField>
              <FormField
                label={t("clientApps.origins", "Allowed origins")}
                required
                description={t(
                  "clientApps.originsHint",
                  "One per line, exactly as the browser shows it: https://app.example.com. http only for localhost; no path and no wildcard.",
                )}
              >
                <Textarea
                  value={origins}
                  onChange={(e) => setOrigins(e.target.value)}
                  disabled={loading}
                  rows={3}
                  placeholder="https://app.example.com"
                />
              </FormField>
              <FormField
                label={t("clientApps.ceiling", "Monthly spend ceiling (USD)")}
                description={t(
                  "clientApps.ceilingHint",
                  "The application's turns stop for the rest of the month past it. Empty for none; the account's client ceiling still applies.",
                )}
                error={
                  ceilingUsd === undefined
                    ? t(
                        "clientApps.ceilingInvalid",
                        "An amount in dollars, such as 50 or 12.50",
                      )
                    : undefined
                }
              >
                <Input
                  inputMode="decimal"
                  value={ceiling}
                  onChange={(e) => setCeiling(e.target.value)}
                  disabled={loading}
                  placeholder={t("clientApps.ceilingNone", "No ceiling")}
                />
              </FormField>
              <SwitchField
                label={t("clientApps.anonymous", "Anonymous visitors")}
                help={t(
                  "clientApps.anonymousHint",
                  "Lets a page with no signed-in user talk to the agent. Leave it off for an assistant inside a logged-in app.",
                )}
                checked={anonymous}
                onCheckedChange={setAnonymous}
                disabled={loading}
              />
              {anonymous && (
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    label={t(
                      "clientApps.anonSessions",
                      "New sessions per address, per hour",
                    )}
                  >
                    <NumberInput
                      inputMode="numeric"
                      range={CLIENT_APP_RANGES.anonSessionsPerHour}
                      value={sessions}
                      onChange={(e) => setSessions(e.target.value)}
                      disabled={loading}
                    />
                  </FormField>
                  <FormField
                    label={t(
                      "clientApps.anonMessages",
                      "Messages per session, per minute",
                    )}
                  >
                    <NumberInput
                      inputMode="numeric"
                      range={CLIENT_APP_RANGES.anonMessagesPerMin}
                      value={messages}
                      onChange={(e) => setMessages(e.target.value)}
                      disabled={loading}
                    />
                  </FormField>
                </div>
              )}
              {anonymous && (
                <FormField
                  label={t(
                    "clientApps.anonExpiry",
                    "Delete idle anonymous conversations after (days)",
                  )}
                  description={t(
                    "clientApps.anonExpiryHint",
                    "A conversation with no message for this long is deleted. One handed over to a signed-in user is kept, and one with spend this month stays until the month ends.",
                  )}
                >
                  <NumberInput
                    inputMode="numeric"
                    range={CLIENT_APP_RANGES.anonExpiryDays}
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                    disabled={loading}
                  />
                </FormField>
              )}
              {anonymous && (
                <SwitchField
                  label={t("clientApps.turnstile", "Human check (Turnstile)")}
                  help={t(
                    "clientApps.turnstileHint",
                    "Before a new anonymous session, the visitor passes a Cloudflare Turnstile challenge. Create the widget in your Cloudflare account for your site's domains and paste its keys here.",
                  )}
                  checked={turnstile}
                  onCheckedChange={setTurnstile}
                  disabled={loading}
                />
              )}
              {anonymous && turnstile && (
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    label={t("clientApps.turnstileSiteKey", "Site key")}
                    required
                    description={t(
                      "clientApps.turnstileSiteKeyHint",
                      "Public. The page shows the challenge with it.",
                    )}
                  >
                    <Input
                      value={siteKey}
                      onChange={(e) => setSiteKey(e.target.value)}
                      disabled={loading}
                      autoComplete="off"
                    />
                  </FormField>
                  <FormField
                    label={t("clientApps.turnstileSecret", "Secret key")}
                    required={!secretStored}
                    description={
                      secretStored
                        ? t(
                            "clientApps.turnstileSecretStored",
                            "A secret is stored. Leave empty to keep it.",
                          )
                        : t(
                            "clientApps.turnstileSecretHint",
                            "Stays on the server and is never shown again.",
                          )
                    }
                  >
                    <Input
                      type="password"
                      autoComplete="new-password"
                      value={turnstileSecret}
                      onChange={(e) => setTurnstileSecret(e.target.value)}
                      disabled={loading}
                    />
                  </FormField>
                </div>
              )}
            </>
          )}
          {asksPassword && (
            <FormField
              label={t("clientApps.password", "Your password")}
              required
              description={t(
                "clientApps.passwordHint",
                "This mints a key that signs users in. Confirm with your password.",
              )}
            >
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
              />
            </FormField>
          )}
          <div className="flex justify-end gap-2">
            <ModalCancelButton disabled={loading} />
            <Button
              type="submit"
              loading={loading}
              disabled={loading || !canSubmit}
            >
              {mode === "create"
                ? t("clientApps.create", "Create application")
                : mode === "edit"
                  ? t("common.save", "Save")
                  : t("clientApps.rotate", "Mint new key")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// The key, once, with what the application's server needs to sign a user in with it.
function MintedKey({ minted, onDone }: { minted: Minted; onDone: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      // NOTE: clipboard unavailable (insecure context); the value stays selectable.
    }
  };
  const rows: Array<[string, string, string]> = [
    ["secret", t("clientApps.secret", "Key"), minted.secret],
    ["kid", t("clientApps.kid", "Key id (kid)"), minted.kid],
    ["app", t("clientApps.publicId", "Application id"), minted.publicId],
  ];
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-warning bg-warning-soft px-3 py-2 text-text-primary text-xs">
        {t(
          "clientApps.secretWarning",
          "Copy the key now. It is shown only once and cannot be retrieved again; keep it on your application's server, never in the browser.",
        )}
      </div>
      {rows.map(([key, label, value]) => (
        <div key={key} className="space-y-1">
          <p className="text-text-secondary text-xs">{label}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg border border-border bg-bg-tertiary px-3 py-2 font-mono text-text-primary text-xs">
              {value}
            </code>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void copy(key, value)}
              aria-label={t("common.copy", "Copy")}
            >
              {copied === key ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
            </Button>
          </div>
        </div>
      ))}
      <p className="text-text-secondary text-xs">
        {t(
          "clientApps.signHint",
          "Your server signs each user as a JWT (HS256) with this key: kid in the header, aud = application id, sub = user id, exp within an hour; name, email and scope optional.",
        )}
      </p>
      <div className="flex justify-end">
        <Button onClick={onDone}>{t("common.done", "Done")}</Button>
      </div>
    </div>
  );
}
