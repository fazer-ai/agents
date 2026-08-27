import { AlertTriangle } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  CredentialPicker,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  type ModalController,
  Select,
  Skeleton,
  SwitchField,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";
import { isValidHttpUrl } from "@/client/lib/validation";
import {
  composeStdioCommand,
  DEFAULT_MCP_STDIO_LAUNCHER,
  MCP_STDIO_LAUNCHERS,
  parseStdioCommand,
} from "@/lib/mcp-launchers";

// Derived from the vault treaty response; never hand-mirrored (see docs/eden-treaty.md).
type VaultEntry = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.vault.get>>["data"]
>["entries"][number];

const TRANSPORTS = ["streamableHttp", "sse", "stdio"] as const;

function emptyForm() {
  return {
    name: "",
    transport: "streamableHttp" as (typeof TRANSPORTS)[number],
    url: "",
    // stdio command is split into launcher (allowlisted: bunx | uvx) + free-form args, composed into
    // the stored `command` on save and parsed back on load.
    launcher: DEFAULT_MCP_STDIO_LAUNCHER as string,
    args: "",
    credentialRef: "",
    enabled: true,
  };
}

type Form = ReturnType<typeof emptyForm>;

// The body this modal writes, from the form it renders. ONE function, because it is also what the
// refusal is matched against: `capture` compares the value that was SENT with the value the inputs
// hold NOW, and two spellings of "the body" would disagree about a field nobody edited.
function bodyOf(form: Form) {
  const isStdio = form.transport === "stdio";
  return {
    name: form.name.trim(),
    transport: form.transport,
    url: isStdio ? null : form.url.trim() || null,
    command: isStdio
      ? composeStdioCommand(form.launcher, form.args.trim()) || null
      : null,
    credentialRef: form.credentialRef || null,
    enabled: form.enabled,
  };
}

// The server's own names for what this modal renders, and they are the keys of the body above — the
// route's schema refuses by them (`refused body.name`, `refused body.transport`) and
// `requireVaultRef` names `credentialRef`.
//
// `command` is declared even though no single input holds it: the launcher Select and the args Input
// compose into it, so a refusal about the command is marked on the args field, which is the half an
// operator can act on. See the render.
const MCP_FIELDS = ["name", "transport", "credentialRef"] as const;

// A stdio server is launched, the others are reached: the modal draws the command line for one and
// the URL for the other, never both. Both stay in the BODY, so declaring both would put a refusal
// about the one that is hidden onto a control that is not there.
const MCP_STDIO_FIELDS = [...MCP_FIELDS, "command"] as const;
const MCP_URL_FIELDS = [...MCP_FIELDS, "url"] as const;

// Per-launcher args placeholder (the package + its flags; the launcher itself is the Select).
function argsPlaceholder(launcher: string): string {
  return launcher === "uvx"
    ? "mcp-server-time"
    : "@modelcontextprotocol/server-everything";
}

// Reusable create/edit modal for an MCP server connection. Shared by the Components → MCP panel and
// the agent editor's Tools tab. On edit the full connection is fetched by id; `onSaved` lets the
// caller refetch + auto-select. `sharedNotice` warns the edit affects every agent using the server.
export function McpEditModal({
  modal,
  onSaved,
  sharedNotice,
}: {
  modal: ModalController<{ id?: string }>;
  onSaved?: (saved: { id: string; name: string }, isNew: boolean) => void;
  sharedNotice?: boolean;
}) {
  const { t } = useTranslation();
  const transportLabel = (tr: (typeof TRANSPORTS)[number]) => {
    switch (tr) {
      case "streamableHttp":
        return t("mcp.transportLabel.streamableHttp", "Streamable HTTP");
      case "sse":
        return t("mcp.transportLabel.sse", "SSE");
      default:
        return t("mcp.transportLabel.stdio", "stdio");
    }
  };
  const { showToast } = useToast();
  const { mcpStdioEnabled } = useAuth();
  const [form, setForm] = useState(emptyForm());
  // The CURRENT form, readable from inside a request that started before it: the operator can type
  // while the save is out, and a refusal about a value they have already replaced belongs in the
  // banner rather than under a box that no longer holds it.
  const formRef = useRef(form);
  formRef.current = form;
  const [saving, setSaving] = useState(false);
  const [loadingForm, setLoadingForm] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const formBaseline = useRef<string | null>(null);
  // Base URL from the selected credential (locks the URL field when set).
  const [mcpCredBaseUrl, setMcpCredBaseUrl] = useState<string | null>(null);
  // User's own URL value preserved while a credential with baseUrl is selected.
  const mcpUserUrlRef = useRef("");

  const editId = modal.payload?.id;

  useOnModalOpen(modal, () => {
    // The component outlives the dialog, so a mark from the last session is still held here.
    refusal.clear();
    setFormError(null);
    setLoadError(false);
    setMcpCredBaseUrl(null);
    const payloadId = modal.payload?.id;
    if (!payloadId) {
      const initial = emptyForm();
      setForm(initial);
      formBaseline.current = JSON.stringify(initial);
      mcpUserUrlRef.current = "";
      return;
    }
    formBaseline.current = null;
    setLoadingForm(true);
    void (async () => {
      try {
        const { data, error } = await api.api.v1["mcp-connections"]({
          id: payloadId,
        }).get();
        if (error || !data) {
          setLoadError(true);
          return;
        }
        const c = data.connection;
        const parsed = c.command
          ? parseStdioCommand(c.command)
          : { launcher: DEFAULT_MCP_STDIO_LAUNCHER as string, args: "" };
        const initial = {
          name: c.name,
          transport: c.transport as (typeof TRANSPORTS)[number],
          url: c.url ?? "",
          launcher: parsed.launcher,
          args: parsed.args,
          credentialRef: c.credentialRef ?? "",
          enabled: c.enabled,
        };
        setForm(initial);
        formBaseline.current = JSON.stringify(initial);
        mcpUserUrlRef.current = c.url ?? "";
      } catch {
        setLoadError(true);
      } finally {
        setLoadingForm(false);
      }
    })();
  });

  const isStdio = form.transport === "stdio";
  const refusal = useFieldRefusal(
    modal.isOpen ? (isStdio ? MCP_STDIO_FIELDS : MCP_URL_FIELDS) : [],
  );
  // What the inputs hold right now, in the server's vocabulary. The marks are keyed by VALUE, so this
  // has to be the same function the save sends — an edit takes the mark off because the box stops
  // holding what was refused.
  const current = bodyOf(form);

  async function save() {
    setFormError(null);
    const body = bodyOf(form);
    setSaving(true);
    // Measured live, and it is why this modal is wired: a second connection under a name already
    // taken answers 409 "mcp connection name already in use", and the banner said "check the
    // URL/command" — the wrong input, named confidently (#329).
    const fallback = t("mcp.saveError", "Could not save.");
    const held = (e: unknown) =>
      refusal.capture(e, fallback, body, bodyOf(formRef.current));
    try {
      const { data, error: err } = editId
        ? await api.api.v1["mcp-connections"]({ id: editId }).patch(body)
        : await api.api.v1["mcp-connections"].post(body);
      if (err || !data) {
        setFormError(held(err));
        return;
      }
      refusal.clear();
      showToast(t("mcp.saved", "MCP server saved."), "success");
      modal.close();
      onSaved?.(
        { id: data.connection.id, name: data.connection.name },
        !editId,
      );
    } catch (e) {
      setFormError(held(e));
    } finally {
      setSaving(false);
    }
  }

  // URL is optional when credential provides its own base (server resolves it). Invalid only when the
  // URL field is editable (not locked) and has a non-empty bad value.
  const mcpUrlInvalid =
    !isStdio && !mcpCredBaseUrl && !isValidHttpUrl(form.url);
  const valid =
    !loadingForm &&
    !loadError &&
    form.name.trim() &&
    !mcpUrlInvalid &&
    (isStdio
      ? mcpStdioEnabled && form.args.trim()
      : form.url.trim() || !!mcpCredBaseUrl);

  // NOTE: baseline is captured on open (create defaults / loaded server); null while the edit fetch
  // is in flight.
  const isDirty =
    formBaseline.current !== null &&
    JSON.stringify(form) !== formBaseline.current;

  return (
    <Modal
      modal={modal}
      unsavedChanges={isDirty}
      title={
        editId
          ? t("mcp.editTitle", "Edit MCP server")
          : t("mcp.addTitle", "New MCP server")
      }
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-error text-xs">{formError}</span>
          <div className="flex gap-2">
            <ModalCancelButton disabled={saving} />
            <Button onClick={save} loading={saving} disabled={!valid}>
              {t("common.save", "Save")}
            </Button>
          </div>
        </div>
      }
    >
      {loadingForm ? (
        <div className="flex flex-col gap-3" role="status">
          <span className="sr-only">{t("common.loading", "Loading…")}</span>
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : loadError ? (
        <p className="text-error text-sm">
          {t("mcp.loadError", "Could not load this server.")}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {sharedNotice && editId && (
            <div className="flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-text-primary text-xs">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              <span>
                {t(
                  "mcp.sharedNotice",
                  "This is a shared MCP server. Changes affect every agent that uses it.",
                )}
              </span>
            </div>
          )}
          <FormField
            label={t("mcp.name", "Name")}
            required
            error={refusal.at("name", current.name)}
          >
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </FormField>
          <FormField
            label={t("mcp.transport", "Transport")}
            error={refusal.at("transport", current.transport)}
          >
            <Select
              value={form.transport}
              onChange={(e) =>
                setForm({
                  ...form,
                  transport: e.target.value as (typeof TRANSPORTS)[number],
                })
              }
            >
              {TRANSPORTS.map((tr) => (
                <option key={tr} value={tr}>
                  {transportLabel(tr)}
                </option>
              ))}
            </Select>
          </FormField>
          {isStdio ? (
            <>
              {!mcpStdioEnabled && (
                <div className="flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-text-primary text-xs">
                  <AlertTriangle
                    className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                    aria-hidden="true"
                  />
                  <span>
                    {t(
                      "mcp.stdioDisabled",
                      "stdio transport is disabled on this server (MCP_STDIO_ENABLED). Enable it on a host you control to create a stdio connection.",
                    )}
                  </span>
                </div>
              )}
              <FormField
                label={t("mcp.launcher", "Launcher")}
                description={t(
                  "mcp.launcherHint",
                  "bunx runs npm-published servers (use it wherever docs say npx). uvx runs Python servers.",
                )}
              >
                <Select
                  value={form.launcher}
                  onChange={(e) =>
                    setForm({ ...form, launcher: e.target.value })
                  }
                  disabled={!mcpStdioEnabled}
                >
                  {MCP_STDIO_LAUNCHERS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField
                label={t("mcp.args", "Arguments")}
                required
                description={t(
                  "mcp.argsHint",
                  "The package to run plus its flags (the launcher is selected above). The credential's token is injected as an environment variable, never written here.",
                )}
                error={refusal.at("command", current.command)}
              >
                <Input
                  value={form.args}
                  onChange={(e) => setForm({ ...form, args: e.target.value })}
                  placeholder={argsPlaceholder(form.launcher)}
                  disabled={!mcpStdioEnabled}
                />
              </FormField>
            </>
          ) : (
            <FormField
              label={t("mcp.url", "URL")}
              required={!mcpCredBaseUrl}
              description={
                mcpCredBaseUrl
                  ? t(
                      "editor.baseURLFromCredential",
                      "Defined by the selected credential.",
                    )
                  : undefined
              }
              error={
                mcpUrlInvalid && form.url.trim()
                  ? t("common.invalidUrl", "Must be a valid http(s) URL.")
                  : refusal.at("url", current.url)
              }
            >
              <Input
                value={mcpCredBaseUrl ?? form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                disabled={!!mcpCredBaseUrl}
                placeholder="https://mcp.example.com/sse"
              />
            </FormField>
          )}
          <FormField
            label={t("mcp.credential", "Credential")}
            group
            error={refusal.at("credentialRef", current.credentialRef)}
          >
            <CredentialPicker
              value={form.credentialRef}
              onChange={(v) => setForm({ ...form, credentialRef: v })}
              compatibleTypes={
                isStdio
                  ? ["mcp_env", "bearer_token"]
                  : ["mcp_oauth", "bearer_token", "header", "basic_auth"]
              }
              defaultCreateType={isStdio ? "mcp_env" : "mcp_oauth"}
              defaultCreateBaseUrl={mcpCredBaseUrl ?? form.url}
              onEntryChange={(entry: VaultEntry | null) => {
                const credUrl = entry?.baseUrl ?? null;
                setMcpCredBaseUrl(credUrl);
                if (credUrl) {
                  mcpUserUrlRef.current = form.url;
                } else {
                  setForm((prev) => ({
                    ...prev,
                    url: mcpUserUrlRef.current,
                  }));
                }
              }}
              ariaLabel={t("mcp.credential", "Credential")}
            />
          </FormField>
          <SwitchField
            checked={form.enabled}
            onCheckedChange={(v) => setForm({ ...form, enabled: v })}
            label={t("common.enabled", "Enabled")}
          />
        </div>
      )}
    </Modal>
  );
}
