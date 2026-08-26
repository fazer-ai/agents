import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  Modal,
  type ModalController,
  SwitchField,
  Textarea,
  useOnModalOpen,
} from "@/client/components";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";
import { api } from "@/client/lib/api";

// Supported MCP scopes (must match MCP_SCOPES server-side). mcp:admin is honored only for a
// SUPER_ADMIN user at grant time, but a client MAY be allowed to request it.
const MCP_SCOPES = ["mcp:read", "mcp:write", "mcp:admin"] as const;

// The keys of the body this modal writes, which are the names the route refuses by (`refused
// body.name`, `refused body.redirectUris.0`). The URI list is one Textarea, and an element-level
// refusal lands on it: see placeRefusal.
//
// `firstParty` is not here on purpose: a Switch has nowhere to render a sentence, and a name
// declared without a control behind it would be marked as placed and then shown to nobody.
const MCP_CLIENT_FIELDS = ["name", "redirectUris", "scopes"] as const;

export interface McpClientPayload {
  // Present when editing an existing client.
  clientId?: string;
  name?: string;
  redirectUris?: string[];
  scopes?: string[];
  firstParty?: boolean;
}

// Create or edit an MCP OAuth client (PUBLIC/PKCE in the MVP). redirect URIs are one per line. The
// client_secret is never shown (public clients have none).
export function RegisterMcpClientModal({
  modal,
  onSaved,
}: {
  modal: ModalController<McpClientPayload>;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [redirectUris, setRedirectUris] = useState("");
  const [scopes, setScopes] = useState<string[]>(["mcp:read"]);
  const [firstParty, setFirstParty] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const refusal = useFieldRefusal(modal.isOpen ? MCP_CLIENT_FIELDS : []);

  const editingId = modal.payload?.clientId;

  useOnModalOpen(modal, () => {
    // The component outlives the dialog, so a mark from the last session is still held here.
    refusal.clear();
    setName(modal.payload?.name ?? "");
    setRedirectUris((modal.payload?.redirectUris ?? []).join("\n"));
    setScopes(modal.payload?.scopes ?? ["mcp:read"]);
    setFirstParty(modal.payload?.firstParty ?? false);
    setError("");
  });

  const toggleScope = (scope: string) =>
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );

  const parsedUris = redirectUris
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean);
  // What the inputs hold right now, in the server's vocabulary. Read from a ref inside the request
  // so a refusal about a value the operator has already replaced goes to the banner instead.
  const current = {
    name: name.trim(),
    redirectUris: parsedUris,
    scopes,
    firstParty,
  };
  const currentRef = useRef(current);
  currentRef.current = current;
  const valid =
    name.trim() !== "" && parsedUris.length > 0 && scopes.length > 0;

  const submit = async () => {
    setError("");
    setLoading(true);
    const body = { ...current };
    const held = (e: unknown) =>
      refusal.capture(
        e,
        t("mcp.admin.clientSaveFailed", "Could not save the client"),
        body,
        currentRef.current,
      ) ?? "";
    try {
      const { error: apiError } = editingId
        ? await api.api.v1.mcp.admin
            .clients({ clientId: editingId })
            .patch(body)
        : await api.api.v1.mcp.admin.clients.post(body);
      if (apiError) {
        setError(held(apiError));
        return;
      }
      refusal.clear();
      onSaved();
      modal.close();
    } catch (e) {
      setError(held(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      modal={modal}
      size="md"
      title={
        editingId
          ? t("mcp.admin.editClientTitle", "Edit MCP client")
          : t("mcp.admin.newClientTitle", "Register MCP client")
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
            {error}
          </div>
        )}
        <FormField
          label={t("mcp.admin.clientName", "Name")}
          required
          error={refusal.at("name", current.name)}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={loading}
            placeholder={t("mcp.admin.clientNamePlaceholder", "Claude Desktop")}
          />
        </FormField>
        <FormField
          label={t("mcp.admin.redirectUris", "Redirect URIs")}
          required
          description={t(
            "mcp.admin.redirectUrisHint",
            "One per line. Exact https URLs (http allowed only for loopback); no wildcards or fragments.",
          )}
          error={refusal.at("redirectUris", current.redirectUris)}
        >
          <Textarea
            value={redirectUris}
            onChange={(e) => setRedirectUris(e.target.value)}
            disabled={loading}
            rows={3}
            className="font-mono text-xs"
            placeholder={"https://app.example.com/oauth/callback"}
          />
        </FormField>
        <FormField
          label={t("mcp.admin.scopes", "Scopes")}
          required
          group
          error={refusal.at("scopes", current.scopes)}
        >
          <div className="flex flex-col gap-1.5">
            {MCP_SCOPES.map((scope) => (
              <label
                key={scope}
                className="flex w-fit items-center gap-2 text-sm text-text-secondary"
              >
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={() => toggleScope(scope)}
                  disabled={loading}
                />
                <code className="font-mono text-xs">{scope}</code>
              </label>
            ))}
          </div>
        </FormField>
        <div className="space-y-1">
          <SwitchField
            checked={firstParty}
            onCheckedChange={setFirstParty}
            disabled={loading}
            label={t(
              "mcp.admin.firstParty",
              "Trusted client (skips the consent screen)",
            )}
          />
          <p className="text-text-muted text-xs">
            {t(
              "mcp.admin.firstPartyHint",
              "Only enable for first-party apps you control. Other clients always ask the user to approve.",
            )}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={modal.close}
            disabled={loading}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <Button onClick={submit} loading={loading} disabled={!valid}>
            {editingId
              ? t("common.save", "Save")
              : t("mcp.admin.register", "Register")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
