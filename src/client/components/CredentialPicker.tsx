import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  KeyRound,
  Pencil,
  PlugZap,
  Plus,
  Search,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import { CredentialForm } from "@/client/components/CredentialForm";
import {
  CredentialTestResult,
  type CredentialTestState,
} from "@/client/components/CredentialTestResult";
import { ServiceLogo } from "@/client/components/icons/ServiceLogo";
import { Modal, useModalController } from "@/client/components/Modal";
import { api } from "@/client/lib/api";
import { canonicalVaultRef, formatVaultRef } from "@/client/lib/credentialRef";
import {
  isTestableSecretType,
  secretTypeService,
} from "@/client/lib/secretTypes";
import { cn } from "@/client/lib/utils";
import {
  loadVault,
  refreshVault,
  VAULT_CHANGED_EVENT,
  type VaultEntry,
} from "@/client/lib/vaultCache";

interface CredentialPickerProps {
  value: string;
  onChange: (name: string) => void;
  // Secret-type ids considered compatible in this context (shown first; the rest behind "show all").
  // Empty/undefined ⇒ no filter (every credential is equally compatible).
  compatibleTypes?: string[];
  // Preselected type in the inline "+ New credential" form (defaults to the first compatible type).
  defaultCreateType?: string;
  // Pre-fills the base URL in the inline "+ New credential" form (e.g. the MCP server URL the
  // operator already typed on the connection), so they do not type it twice.
  defaultCreateBaseUrl?: string;
  // Base URL for testing an already-selected self-hosted credential (override; server uses the saved
  // baseUrl when this is absent).
  testBaseUrl?: string;
  allowNone?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  // When true, an empty selection is flagged as a configuration gap (the feature is enabled but has
  // no credential). Surfaces a warning under the picker — used by active model/STT/TTS/vision pickers.
  required?: boolean;
  // Called when the selected entry changes (or on initial load if value already resolves). Use to
  // read baseUrl / paramName of the selected credential without re-fetching the vault.
  onEntryChange?: (entry: VaultEntry | null) => void;
}

const itemCls =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary";

// Credential selector shared by every place that references a vault secret (HTTP tools, MCP,
// integrations, model/STT/TTS keys). Pulls entries straight from the vault, ranks compatible types
// first (with a "show all" escape hatch), shows the service logo + type, and offers inline create
// (reusing CredentialForm with its test-on-save) plus a "test this credential" action via
// POST /v1/vault/:name/test.
export function CredentialPicker({
  value,
  onChange,
  compatibleTypes,
  defaultCreateType,
  defaultCreateBaseUrl,
  testBaseUrl,
  allowNone = true,
  disabled,
  ariaLabel,
  required = false,
  onEntryChange,
}: CredentialPickerProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<CredentialTestState>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const createModal = useModalController();
  const editModal = useModalController();

  const load = useCallback(async () => {
    try {
      setEntries(await loadVault());
    } catch {
      // a failed load leaves an empty list; the operator can still create one
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Re-read when the vault changes anywhere (this picker's create/edit, another picker, or the Vault
  // panel) — load() hits the shared cache, so all listening pickers refresh from a single fetch.
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener(VAULT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(VAULT_CHANGED_EVENT, onChanged);
  }, [load]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: clear a stale test result whenever the selection changes
  useEffect(() => {
    setTestResult(null);
  }, [value]);

  // Notify parent of the currently selected entry. Runs on load (when entries resolve) and on value
  // change. useRef guards against stale closures and avoids re-firing when entries list is stable.
  const prevNotifiedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const selected =
      entries.find((e) => formatVaultRef(e.id) === canonicalVaultRef(value)) ??
      null;
    const notifyKey = value + (selected?.id ?? "__none__");
    if (prevNotifiedRef.current === notifyKey) return;
    prevNotifiedRef.current = notifyKey;
    onEntryChange?.(selected);
  }, [loaded, value, entries, onEntryChange]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focus search on open; showSearchInput derived from entries
  useEffect(() => {
    if (open && showSearchInput) {
      // NOTE: rAF defers until after Radix positions the floating panel and its own focus logic runs.
      const id = requestAnimationFrame(() => searchRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  const hasFilter = !!compatibleTypes && compatibleTypes.length > 0;
  const isCompatible = (e: VaultEntry) =>
    !hasFilter || (!!e.kind && compatibleTypes.includes(e.kind));

  const showSearchInput = entries.length > 0;

  const matchesSearch = (e: VaultEntry) => {
    if (!search) return true;
    const q = search.toLowerCase();
    const nameMatch = e.name.toLowerCase().includes(q);
    const kindIdMatch = e.kind ? e.kind.toLowerCase().includes(q) : false;
    const kindLabelMatch = e.kind
      ? // biome-ignore lint/plugin/no-dynamic-i18n-key: secret-type keys registered in CredentialForm/VaultPanel
        t(`vault.secretType.${e.kind}`, e.kind).toLowerCase().includes(q)
      : false;
    return nameMatch || kindIdMatch || kindLabelMatch;
  };

  const compatible = entries.filter((e) => isCompatible(e) && matchesSearch(e));
  const others = hasFilter
    ? entries.filter((e) => !isCompatible(e) && matchesSearch(e))
    : [];

  // Stored refs are always `vault:<id>`; a value with no matching entry (after load) points at a
  // removed credential → flagged "unavailable" in the trigger (never the raw id).
  const selected =
    entries.find((e) => formatVaultRef(e.id) === canonicalVaultRef(value)) ??
    null;
  const unresolved = !selected && !!value;
  // The entry is there and its secret is not: `credential_create` (MCP) and the vault's own "add a
  // reference now, fill it later" both produce this, deliberately: resolveSecretRef says so and
  // points at the alert that would surface it. That alert only ever existed for the agent's own
  // credentials (configHealth), so every other field wired to a pending entry failed with nothing
  // said anywhere: an integration's inbound secret failed as a bare 401 (issue #124). Saying it in
  // the picker says it once, for every field that references a credential.
  const unfilled = selected?.status === "pending";
  const canTest = !!selected && isTestableSecretType(selected.kind);
  // Same compatibility rule as the list ranking: flags a selection left behind after the
  // context changed (e.g. the provider switched while an old credential stayed selected).
  const selectedIncompatible = !!selected && !isCompatible(selected);

  // Auto-reselect: when the COMPATIBLE TYPES change (the operator switched provider) and the current
  // pick no longer fits, drop to the first compatible credential — or clear it — so the field never
  // stays stuck on a stale, incompatible selection. Gated on a types CHANGE (tracked below) so a
  // deliberate cross-type pick via "show all" is never yanked back, and a deleted/unresolved cred is
  // surfaced rather than silently swapped.
  const prevTypesRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: isCompatible derives from compatibleTypes (tracked via key)
  useEffect(() => {
    if (!loaded) return;
    const key = (compatibleTypes ?? []).join(",");
    const changed =
      prevTypesRef.current !== null && prevTypesRef.current !== key;
    prevTypesRef.current = key;
    if (!changed || !hasFilter || !selectedIncompatible) return;
    const firstCompatible = entries.find(isCompatible);
    const next = firstCompatible ? formatVaultRef(firstCompatible.id) : "";
    if (next !== value) onChange(next);
  }, [
    loaded,
    hasFilter,
    selectedIncompatible,
    entries,
    value,
    onChange,
    compatibleTypes,
  ]);

  async function testExisting() {
    // The ENTRY's id, never the ref's own spelling: the route takes `^\d+$`, and a ref reaches this
    // field unvalidated (`PATCH /v1/agents/:id` stores what it is handed), so `vault: 7 ` — which
    // resolves everywhere else, including the selection above — would be refused here and the
    // credential reported as unreachable.
    if (!selected) return;
    const id = selected.id;
    setTesting(true);
    setTestResult(null);
    try {
      // If the entry has a saved baseUrl, the server uses it; only override when testBaseUrl is given.
      const { data, error: err } = await api.api.v1
        .vault({ id })
        .test.post({ baseURL: testBaseUrl?.trim() || null });
      const r = data as
        | { testable?: boolean; ok?: boolean; code?: string; status?: number }
        | null
        | undefined;
      if (err || !r || r.testable === false) {
        setTestResult({ kind: "fail", code: "unreachable" });
        return;
      }
      setTestResult(
        r.ok
          ? { kind: "ok" }
          : { kind: "fail", code: r.code ?? "unreachable", status: r.status },
      );
    } catch {
      setTestResult({ kind: "fail", code: "unreachable" });
    } finally {
      setTesting(false);
    }
  }

  function renderEntry(e: VaultEntry) {
    return (
      <DropdownMenuPrimitive.Item
        key={e.id}
        className={itemCls}
        onSelect={() => onChange(formatVaultRef(e.id))}
      >
        <ServiceLogo
          service={secretTypeService(e.kind)}
          className="h-4 w-4 shrink-0 text-text-secondary"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-xs">{e.name}</span>
          {e.baseUrl && (
            <span className="truncate text-text-muted text-xs">
              {e.baseUrl}
            </span>
          )}
        </div>
        {e.kind && e.kind !== "generic" && (
          <span className="shrink-0 text-text-muted text-xs">
            {/* biome-ignore lint/plugin/no-dynamic-i18n-key: secret-type keys registered in CredentialForm/VaultPanel */}
            {t(`vault.secretType.${e.kind}`, e.kind)}
          </span>
        )}
        {canonicalVaultRef(value) === formatVaultRef(e.id) && (
          <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
      </DropdownMenuPrimitive.Item>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <DropdownMenuPrimitive.Root
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            // NOTE: reset on OPEN, not close — clearing on close re-renders the full list while
            // the Radix exit animation still shows the content (visible flicker).
            if (next) setSearch("");
          }}
        >
          <DropdownMenuPrimitive.Trigger asChild disabled={disabled}>
            <button
              type="button"
              disabled={disabled}
              aria-label={ariaLabel}
              className="flex min-h-[38px] flex-1 items-center gap-2 rounded-lg border border-border bg-bg-tertiary py-2 pr-3 pl-3 text-sm text-text-primary focus:border-border-focus focus:outline-none disabled:opacity-60"
            >
              {selected ? (
                <>
                  <ServiceLogo
                    service={secretTypeService(selected.kind)}
                    className="h-4 w-4 shrink-0 text-text-secondary"
                  />
                  <span className="flex-1 truncate text-left font-mono text-xs">
                    {selected.name}
                  </span>
                  {selectedIncompatible && (
                    <TriangleAlert
                      className="h-3.5 w-3.5 shrink-0 text-warning"
                      aria-hidden="true"
                    />
                  )}
                </>
              ) : loaded && unresolved ? (
                <span className="flex-1 truncate text-left text-text-muted">
                  {t("credentialPicker.unavailable", "Credential unavailable")}
                </span>
              ) : (
                <span className="flex-1 truncate text-left text-text-muted">
                  {allowNone
                    ? t("credentialPicker.none", "None")
                    : t("credentialPicker.select", "Select a credential")}
                </span>
              )}
              <ChevronDown
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-text-muted"
              />
            </button>
          </DropdownMenuPrimitive.Trigger>

          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="start"
              sideOffset={6}
              // Above the modal it may be opened inside (z-dropdown 60 < z-modal 80); stays under
              // the toast layer (90).
              style={{
                zIndex: "calc(var(--z-modal) + 5)",
                minWidth: "var(--radix-dropdown-menu-trigger-width)",
              }}
              className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 max-h-72 overflow-y-auto rounded-lg border border-border bg-bg-secondary p-1 shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in"
            >
              {showSearchInput && (
                <div className="mb-1 flex items-center gap-1.5 border-border border-b px-2 py-1.5">
                  <Search
                    className="pointer-events-none h-4 w-4 shrink-0 text-text-muted"
                    aria-hidden="true"
                  />
                  <input
                    ref={searchRef}
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => {
                      // NOTE: Block typeahead for printable characters so the menu's native typeahead
                      // doesn't steal keystrokes; navigation keys pass through to keep arrow/esc working.
                      if (
                        e.key.length === 1 ||
                        e.key === "Backspace" ||
                        e.key === "Delete"
                      ) {
                        e.stopPropagation();
                      }
                    }}
                    placeholder={t(
                      "vault.searchPlaceholder",
                      "Search by name or type…",
                    )}
                    aria-label={t(
                      "vault.searchPlaceholder",
                      "Search by name or type…",
                    )}
                    className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                  />
                </div>
              )}

              {allowNone && (
                <DropdownMenuPrimitive.Item
                  className={itemCls}
                  onSelect={() => onChange("")}
                >
                  <KeyRound
                    className="h-4 w-4 shrink-0 text-text-muted"
                    aria-hidden="true"
                  />
                  <span className="flex-1">
                    {t("credentialPicker.none", "None")}
                  </span>
                  {!value && (
                    <Check
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  )}
                </DropdownMenuPrimitive.Item>
              )}

              {compatible.length === 0 && !allowNone && !search && (
                <div className="px-2 py-1.5 text-text-muted text-xs">
                  {t("credentialPicker.empty", "No credentials yet")}
                </div>
              )}
              {compatible.map(renderEntry)}

              {search && compatible.length === 0 && others.length === 0 && (
                <div className="px-2 py-1.5 text-sm text-text-muted">
                  {t("vault.noSearchResults", "No secrets match your search.")}
                </div>
              )}

              {others.length > 0 && (
                <>
                  <DropdownMenuPrimitive.Item
                    className={cn(itemCls, "text-text-muted text-xs")}
                    onSelect={(e) => {
                      e.preventDefault();
                      setShowAll((v) => !v);
                    }}
                  >
                    {showAll
                      ? t(
                          "credentialPicker.showCompatible",
                          "Show compatible only",
                        )
                      : t("credentialPicker.showAll", "Show all ({{count}})", {
                          count: others.length,
                        })}
                  </DropdownMenuPrimitive.Item>
                  {showAll && others.map(renderEntry)}
                </>
              )}

              <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <DropdownMenuPrimitive.Item
                className={itemCls}
                onSelect={() => createModal.open()}
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{t("credentialPicker.new", "New credential")}</span>
              </DropdownMenuPrimitive.Item>
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>

        {selected && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => editModal.open()}
            aria-label={t("vault.editCredential", "Edit credential")}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
        {canTest && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={testExisting}
            loading={testing}
            aria-label={t("vault.test", "Test connection")}
          >
            <PlugZap className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>

      {selectedIncompatible && (
        <span className="text-warning text-xs" role="status">
          {t(
            "credentialPicker.incompatible",
            "This credential's type doesn't match this context and may not work here.",
          )}
        </span>
      )}

      {loaded && unresolved && (
        <span className="text-warning text-xs" role="status">
          {t(
            "credentialPicker.unresolvedMissing",
            "The selected credential was deleted — pick another.",
          )}
        </span>
      )}

      {unfilled && (
        <span
          className="flex flex-wrap items-center gap-2 text-warning text-xs"
          role="status"
        >
          {t(
            "credentialPicker.pendingUnfilled",
            "This credential has no value yet, so anything using it cannot run.",
          )}
          <button
            type="button"
            className="underline"
            onClick={() => editModal.open()}
          >
            {t("vault.fill", "Fill")}
          </button>
        </span>
      )}

      {loaded && required && !value && (
        <span className="text-warning text-xs" role="status">
          {t(
            "credentialPicker.requiredMissing",
            "This feature is enabled but has no credential — select one.",
          )}
        </span>
      )}

      <CredentialTestResult result={testResult} />

      <Modal
        modal={createModal}
        title={t("credentialPicker.createTitle", "New credential")}
      >
        <CredentialForm
          mode="create"
          initialKind={defaultCreateType ?? compatibleTypes?.[0] ?? "generic"}
          initialBaseUrl={defaultCreateBaseUrl || undefined}
          onSaved={(ref) => {
            createModal.close();
            onChange(ref);
            // A failed refresh leaves the previous list in place rather than throwing into the
            // void: the entry was already saved, and the vault-changed listeners re-read anyway.
            refreshVault().catch(() => undefined);
          }}
          onCancel={() => createModal.close()}
        />
      </Modal>

      <Modal
        modal={editModal}
        title={
          unfilled
            ? t("vault.fillTitle", "Fill pending credential")
            : t("vault.updateTitle", "Update secret")
        }
      >
        <CredentialForm
          mode="update"
          // Filling here has to demand a real value, exactly as the vault panel does: a rename-only
          // save would close the form and leave the entry just as unfilled as it was.
          requireValue={unfilled}
          initialId={selected?.id}
          initialName={selected?.name}
          initialKind={selected?.kind ?? "generic"}
          initialBaseUrl={selected?.baseUrl ?? undefined}
          initialParamName={selected?.paramName ?? undefined}
          onSaved={(_ref, _name, _kind) => {
            editModal.close();
            // Clear the notify guard so onEntryChange re-fires with the updated entry once the
            // refreshed list arrives (via the vault-changed listener above).
            prevNotifiedRef.current = null;
            // A failed refresh leaves the previous list in place rather than throwing into the
            // void: the entry was already saved, and the vault-changed listeners re-read anyway.
            refreshVault().catch(() => undefined);
          }}
          onCancel={() => editModal.close()}
        />
      </Modal>
    </div>
  );
}
