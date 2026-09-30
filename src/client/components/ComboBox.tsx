import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Loader2, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/client/lib/utils";

// One selectable option. `label` is the human name (falls back to `id`); `hint` is a subtler trailing
// note (e.g. the raw id when it differs from the label; an explicit "" suppresses it everywhere,
// including the trigger's fallback-to-value); `color` draws a small dot (Chatwoot labels).
export interface ComboItem {
  id: string;
  label?: string;
  hint?: string;
  color?: string;
}

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; items: ComboItem[] }
  | { status: "error" };

type CommonProps = {
  items?: ComboItem[];
  // Optional async source. When set, the dropdown fetches on first open (and on `loaderKey` change),
  // showing loading/error states. Results are kept until the key changes. Static `items` are merged in.
  loader?: () => Promise<ComboItem[]>;
  // Bumping this string re-runs the loader (e.g. provider/credential changed) and clears the cache.
  loaderKey?: string;
  // Allow choosing a value not in the list by typing it (the "use custom" row). Default true.
  allowCustom?: boolean;
  // Load on mount/loaderKey change (not just on first open), so the trigger can show the selected
  // option's human label without the dropdown being opened. Off by default (load lazily on open).
  eager?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  needsCredential?: boolean;
  "aria-label"?: string;
};

type SingleProps = CommonProps & {
  multiple?: false;
  value: string;
  onChange: (value: string) => void;
};

type MultiProps = CommonProps & {
  multiple: true;
  values: string[];
  onChange: (values: string[]) => void;
};

type ComboBoxProps = SingleProps | MultiProps;

function ColorDot({ color }: { color?: string }) {
  if (!color) return null;
  return (
    <span
      className="h-2.5 w-2.5 shrink-0 rounded-full border border-border"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  );
}

// A searchable single/multi select with optional async loading and a "use custom" escape hatch. The
// shared shell behind ModelPicker (chat/TTS models), the TTS voice picker, and the label picker — one
// dropdown UX everywhere (replaces the old free-input ComboInput and the duplicated Select+Input).
export function ComboBox(props: ComboBoxProps) {
  const {
    items: staticItems,
    loader,
    loaderKey,
    allowCustom = true,
    eager,
    placeholder,
    searchPlaceholder,
    disabled,
    needsCredential,
    "aria-label": ariaLabel,
  } = props;
  const multiple = props.multiple === true;
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const inFlight = useRef(false);
  // The loaderKey we've already loaded (or are loading), so doLoad is idempotent without depending on
  // the loadState closure (which would be stale when called right after a reset).
  const loadedKey = useRef<string | undefined>(undefined);

  async function doLoad() {
    if (!loader || inFlight.current) return;
    if (loadedKey.current === loaderKey) return;
    inFlight.current = true;
    loadedKey.current = loaderKey;
    setLoadState({ status: "loading" });
    try {
      const items = await loader();
      setLoadState({ status: "ok", items });
    } catch {
      loadedKey.current = undefined; // allow a retry on the next open
      setLoadState({ status: "error" });
    } finally {
      inFlight.current = false;
    }
  }

  // Reset when the key changes; eagerly (re)load when asked and a credential is present.
  // biome-ignore lint/correctness/useExhaustiveDependencies: loaderKey is the explicit re-fetch trigger.
  useEffect(() => {
    if (!loader) return;
    loadedKey.current = undefined;
    setLoadState({ status: "idle" });
    if (eager && !needsCredential) void doLoad();
  }, [loaderKey]);

  const loaded = loadState.status === "ok" ? loadState.items : [];
  // Merge static + loaded, de-duplicated by id (static first so curated labels win).
  const merged: ComboItem[] = [];
  const seen = new Set<string>();
  for (const it of [...(staticItems ?? []), ...loaded]) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    merged.push(it);
  }

  const q = search.trim().toLowerCase();
  const filtered = q
    ? merged.filter(
        (m) =>
          m.id.toLowerCase().includes(q) ||
          (m.label ?? "").toLowerCase().includes(q),
      )
    : merged;
  const searchTrimmed = search.trim();
  const showCustom =
    allowCustom &&
    searchTrimmed.length > 0 &&
    !merged.some((m) => m.id === searchTrimmed);

  const selectedValues = multiple
    ? (props as MultiProps).values
    : (props as SingleProps).value
      ? [(props as SingleProps).value]
      : [];
  const selectedSet = new Set(selectedValues);

  function pick(id: string) {
    if (multiple) {
      const cur = (props as MultiProps).values;
      const next = cur.includes(id)
        ? cur.filter((v) => v !== id)
        : [...cur, id];
      (props as MultiProps).onChange(next);
      setSearch("");
    } else {
      (props as SingleProps).onChange(id);
      setOpen(false);
    }
  }

  function itemOf(id: string): ComboItem | undefined {
    return merged.find((m) => m.id === id);
  }

  const single = !multiple ? (props as SingleProps) : null;
  const singleSelected = single ? itemOf(single.value) : undefined;
  // Secondary text next to the selected label: an explicit item `hint` wins ("" = none); otherwise
  // fall back to the raw id when a label is shown, so the operator still sees what gets saved.
  const singleHint =
    singleSelected?.hint ??
    (singleSelected?.label && singleSelected.label !== single?.value
      ? (single?.value ?? "")
      : "");

  return (
    <div className="flex w-full flex-col gap-1.5">
      {/* Selected chips (multi only). */}
      {multiple && selectedValues.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedValues.map((v) => {
            const it = itemOf(v);
            return (
              <span
                key={v}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-tertiary py-0.5 pr-1 pl-2 text-text-primary text-xs"
              >
                <ColorDot color={it?.color} />
                <span className="truncate">{it?.label ?? v}</span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={t("common.remove", "Remove")}
                  onClick={() => pick(v)}
                  className="rounded-full p-0.5 text-text-muted hover:bg-bg-hover hover:text-text-primary"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      <DropdownMenuPrimitive.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setSearch("");
            void doLoad();
          }
        }}
      >
        <DropdownMenuPrimitive.Trigger asChild disabled={disabled}>
          <button
            type="button"
            disabled={disabled}
            aria-label={ariaLabel}
            className="flex min-h-8 w-full items-center gap-2 rounded-md border border-border-hover bg-bg-tertiary px-2.5 py-1 text-sm text-text-primary transition-colors focus:border-border-focus focus:outline-none focus:ring-2 focus:ring-accent-soft disabled:opacity-60"
          >
            <span
              className={cn(
                "flex min-w-0 flex-1 items-baseline gap-1.5 text-left",
                { "text-text-muted": multiple || !single?.value },
              )}
            >
              {multiple ? (
                <span className="truncate">
                  {placeholder ?? t("common.comboBoxAddMore", "Add…")}
                </span>
              ) : (
                <>
                  <ColorDot color={singleSelected?.color} />
                  <span className="truncate">
                    {singleSelected?.label ?? (single?.value || placeholder)}
                  </span>
                  {singleHint && (
                    <span className="max-w-[45%] truncate text-text-muted text-xs">
                      {`(${singleHint})`}
                    </span>
                  )}
                </>
              )}
            </span>
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
            style={{
              zIndex: "calc(var(--z-modal) + 5)",
              minWidth: "var(--radix-dropdown-menu-trigger-width)",
            }}
            className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 rounded-lg border border-border bg-bg-secondary shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in"
          >
            <div className="flex items-center gap-1.5 border-border border-b px-2 py-1.5">
              <Search
                className="pointer-events-none h-4 w-4 shrink-0 text-text-muted"
                aria-hidden="true"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key.length === 1 ||
                    e.key === "Backspace" ||
                    e.key === "Delete"
                  ) {
                    e.stopPropagation();
                  }
                }}
                placeholder={searchPlaceholder ?? t("common.search", "Search")}
                aria-label={searchPlaceholder ?? t("common.search", "Search")}
                className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
              />
            </div>

            <div className="max-h-72 overflow-y-auto p-1">
              {showCustom && (
                <DropdownMenuPrimitive.Item
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary"
                  // Keep the menu open in multi mode so several can be added in a row.
                  onSelect={(e) => {
                    if (multiple) e.preventDefault();
                    pick(searchTrimmed);
                  }}
                >
                  <span className="flex-1 truncate italic">
                    {t("common.comboBoxUseCustom", 'Use "{{value}}"', {
                      value: searchTrimmed,
                    })}
                  </span>
                </DropdownMenuPrimitive.Item>
              )}

              {loadState.status === "loading" && (
                <div className="flex items-center gap-2 px-2 py-1.5 text-sm text-text-muted">
                  <Loader2
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 animate-spin"
                  />
                  {t("common.comboBoxLoading", "Loading…")}
                </div>
              )}

              {loadState.status === "error" && (
                <div className="px-2 py-1.5 text-error text-sm">
                  {t("common.comboBoxLoadError", "Could not load the list.")}
                </div>
              )}

              {loadState.status === "idle" && loader && needsCredential && (
                <div className="px-2 py-1.5 text-sm text-text-muted">
                  {t(
                    "common.comboBoxNeedsCredential",
                    "Select a credential to list options.",
                  )}
                </div>
              )}

              {filtered.length === 0 &&
                !showCustom &&
                loadState.status !== "loading" &&
                loadState.status !== "error" && (
                  <div className="px-2 py-1.5 text-sm text-text-muted">
                    {t("common.comboBoxEmpty", "No options")}
                  </div>
                )}

              {filtered.map((m) => {
                const checked = selectedSet.has(m.id);
                return (
                  <DropdownMenuPrimitive.Item
                    key={m.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary"
                    onSelect={(e) => {
                      if (multiple) e.preventDefault();
                      pick(m.id);
                    }}
                  >
                    {multiple && (
                      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                        {checked && (
                          <Check
                            className="h-3.5 w-3.5 text-accent"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                    )}
                    <ColorDot color={m.color} />
                    <span className="flex-1 truncate">{m.label ?? m.id}</span>
                    {(m.hint ?? (m.label ? m.id : "")) && (
                      <span className="max-w-[45%] truncate text-text-muted text-xs">
                        {m.hint ?? m.id}
                      </span>
                    )}
                  </DropdownMenuPrimitive.Item>
                );
              })}
            </div>
          </DropdownMenuPrimitive.Content>
        </DropdownMenuPrimitive.Portal>
      </DropdownMenuPrimitive.Root>
    </div>
  );
}
