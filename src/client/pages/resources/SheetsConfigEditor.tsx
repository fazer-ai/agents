import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  FormField,
  Input,
  Skeleton,
  useHoldSave,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { apiErrorMessage } from "@/client/lib/apiError";
import { cn } from "@/client/lib/utils";

// The Google Sheets integration's settings: which spreadsheet and which tab the agent's tools work on.
// The spreadsheet comes from the account's list (needs a Drive read scope) or from a pasted URL or id;
// the tabs are read from the spreadsheet with the columns of each header row, so the operator sees what
// the agent will fill. Stored as `spreadsheetId` + `sheetId` (the tab's numeric id, stable across
// renames), with the names kept beside them only for display.

type Spreadsheet = { id: string; name: string };
type Tab = { sheetId: number; title: string; columns: string[] | null };

export type SheetsLoaders = {
  spreadsheets: (credentialRef: string) => Promise<Spreadsheet[]>;
  tabs: (
    credentialRef: string,
    spreadsheetId: string,
  ) => Promise<{ title: string; tabs: Tab[] }>;
};

const apiLoaders: SheetsLoaders = {
  async spreadsheets(credentialRef) {
    const { data, error } =
      await api.api.v1.integrations.google.spreadsheets.get({
        query: { credentialRef },
      });
    if (error || !data) throw error ?? new Error("no data");
    return data.spreadsheets;
  },
  async tabs(credentialRef, spreadsheetId) {
    const { data, error } = await api.api.v1.integrations.google[
      "spreadsheet-tabs"
    ].get({ query: { credentialRef, spreadsheetId } });
    if (error || !data) throw error ?? new Error("no data");
    return { title: data.title, tabs: data.tabs };
  },
};

// The id out of a pasted spreadsheet URL, or the text itself when it already is an id.
export function spreadsheetIdFrom(input: string): string | null {
  const s = input.trim();
  const fromUrl = /\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(
    s,
  )?.[1];
  const id = fromUrl ?? s;
  return /^[A-Za-z0-9_-]{10,200}$/.test(id) ? id : null;
}

function RadioRow({
  selected,
  onClick,
  title,
  detail,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  detail?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors",
        {
          "border-accent bg-accent-soft": selected,
          "border-border hover:bg-bg-hover": !selected,
        },
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
          { "border-accent": selected, "border-border": !selected },
        )}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-accent-solid" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm text-text-primary">
          {title}
        </span>
        {detail && (
          <span className="block truncate text-text-muted text-xs">
            {detail}
          </span>
        )}
      </span>
    </button>
  );
}

export function SheetsConfigEditor({
  credentialRef,
  cfg,
  setCfg,
  loaders = apiLoaders,
}: {
  credentialRef: string;
  cfg: Record<string, unknown>;
  setCfg: (patch: Record<string, unknown>) => void;
  loaders?: SheetsLoaders;
}) {
  const { t } = useTranslation();
  const spreadsheetId =
    typeof cfg.spreadsheetId === "string" ? cfg.spreadsheetId : "";
  const spreadsheetName =
    typeof cfg.spreadsheetName === "string" ? cfg.spreadsheetName : "";
  const sheetId = typeof cfg.sheetId === "number" ? cfg.sheetId : null;
  const sheetTitle = typeof cfg.sheetTitle === "string" ? cfg.sheetTitle : "";
  // The server refuses an instance without both, so the modal's Save waits for them.
  const unpicked = !spreadsheetId.trim() || sheetId === null;
  useHoldSave(unpicked);

  const [pasted, setPasted] = useState("");
  const [pasteInvalid, setPasteInvalid] = useState(false);
  const [list, setList] = useState<Spreadsheet[] | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [tabsLoading, setTabsLoading] = useState(false);
  const [tabsError, setTabsError] = useState<string | null>(null);
  // The latest tab request wins: a slower answer for a spreadsheet no longer picked is dropped.
  const tabsSeq = useRef(0);
  // Same for the account's list, which also belongs to ONE credential: switching drops it.
  const listSeq = useRef(0);

  async function loadTabs(id: string) {
    const seq = ++tabsSeq.current;
    setTabs(null);
    setTabsError(null);
    if (!credentialRef || !id) return;
    setTabsLoading(true);
    try {
      const out = await loaders.tabs(credentialRef, id);
      if (seq !== tabsSeq.current) return;
      setTabs(out.tabs);
      if (out.title && out.title !== spreadsheetName)
        setCfg({ spreadsheetName: out.title });
    } catch (err) {
      if (seq !== tabsSeq.current) return;
      setTabsError(
        apiErrorMessage(err) ??
          t(
            "integrations.sheets.tabsError",
            "Could not read the spreadsheet's tabs. Check that the credential has the Google Sheets scope and can open this spreadsheet.",
          ),
      );
    } finally {
      if (seq === tabsSeq.current) setTabsLoading(false);
    }
  }

  async function loadList() {
    if (!credentialRef) return;
    const seq = ++listSeq.current;
    setListLoading(true);
    setListError(null);
    try {
      const out = await loaders.spreadsheets(credentialRef);
      if (seq === listSeq.current) setList(out);
    } catch (err) {
      if (seq !== listSeq.current) return;
      setList(null);
      setListError(
        apiErrorMessage(err) ??
          t(
            "integrations.sheets.listError",
            "Could not list the account's spreadsheets. Paste the spreadsheet's URL instead.",
          ),
      );
    } finally {
      if (seq === listSeq.current) setListLoading(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: the list is the credential's, so a new credential drops it and any answer still in flight
  useEffect(() => {
    listSeq.current++;
    setList(null);
    setListError(null);
    setListLoading(false);
    setFilter("");
    return () => {
      listSeq.current++;
    };
  }, [credentialRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloads only when the credential or the spreadsheet changes, not on every config keystroke
  useEffect(() => {
    void loadTabs(spreadsheetId);
    // An answer that lands after the spreadsheet changed or the editor closed writes nothing: the
    // modal keeps its form state across integrations, so a late title would land on the next one.
    return () => {
      tabsSeq.current++;
    };
  }, [credentialRef, spreadsheetId]);

  function pickSpreadsheet(id: string, name: string) {
    if (id === spreadsheetId) return;
    setCfg({
      spreadsheetId: id,
      spreadsheetName: name,
      sheetId: null,
      sheetTitle: "",
    });
  }

  function applyPasted() {
    const id = spreadsheetIdFrom(pasted);
    setPasteInvalid(id === null);
    if (!id) return;
    setPasted("");
    pickSpreadsheet(id, "");
  }

  const q = filter.trim().toLowerCase();
  const shown = (list ?? []).filter(
    (s) => !q || s.name.toLowerCase().includes(q),
  );
  const savedTabGone =
    tabs !== null &&
    sheetId !== null &&
    !tabs.some((x) => x.sheetId === sheetId);

  if (!credentialRef) {
    return (
      <p className="text-text-muted text-xs">
        {t(
          "integrations.sheets.needsCredential",
          "Choose the Google credential above to pick the spreadsheet.",
        )}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <FormField
        label={t("integrations.sheets.spreadsheet", "Spreadsheet")}
        group
      >
        <div className="flex flex-col gap-2">
          <p className="text-sm text-text-primary" data-testid="sheets-current">
            {spreadsheetId
              ? spreadsheetName || spreadsheetId
              : t("integrations.sheets.noSpreadsheet", "No spreadsheet chosen")}
          </p>
          <div className="flex items-center gap-2">
            <Input
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value);
                setPasteInvalid(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyPasted();
                }
              }}
              aria-label={t(
                "integrations.sheets.pasteLabel",
                "Spreadsheet URL or id",
              )}
              placeholder={t(
                "integrations.sheets.pastePlaceholder",
                "Paste the spreadsheet's URL or id",
              )}
            />
            <Button
              variant="secondary"
              size="sm"
              onClick={applyPasted}
              disabled={!pasted.trim()}
            >
              {t("integrations.sheets.use", "Use")}
            </Button>
          </div>
          {pasteInvalid && (
            <p className="text-error text-xs">
              {t(
                "integrations.sheets.pasteInvalid",
                "That is not a spreadsheet URL or id.",
              )}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-text-muted text-xs">
              {t(
                "integrations.sheets.fromAccount",
                "Or choose from the connected account (needs the Drive read-only scope)",
              )}
            </span>
            <Button
              variant="secondary"
              size="sm"
              loading={listLoading}
              onClick={() => loadList()}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {list
                ? t("common.reload", "Reload")
                : t("integrations.sheets.load", "Load")}
            </Button>
          </div>
          {listError && <p className="text-error text-xs">{listError}</p>}
          {list && list.length === 0 && (
            <p className="text-text-muted text-xs">
              {t(
                "integrations.sheets.listEmpty",
                "No spreadsheets found in this account. Paste the URL of one shared with it.",
              )}
            </p>
          )}
          {list && list.length > 0 && (
            <>
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-label={t(
                  "integrations.sheets.filter",
                  "Filter spreadsheets by name",
                )}
                placeholder={t(
                  "integrations.sheets.filter",
                  "Filter spreadsheets by name",
                )}
              />
              <div className="flex max-h-60 flex-col gap-1.5 overflow-auto">
                {shown.map((s) => (
                  <RadioRow
                    key={s.id}
                    selected={s.id === spreadsheetId}
                    onClick={() => pickSpreadsheet(s.id, s.name)}
                    title={s.name}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </FormField>

      <FormField label={t("integrations.sheets.tab", "Tab")} group>
        <p className="mb-1.5 text-text-muted text-xs">
          {t(
            "integrations.sheets.tabHint",
            "Row 1 of the tab names the columns; the agent reads and writes by those names.",
          )}
        </p>
        {!spreadsheetId ? (
          <p className="text-text-muted text-xs">
            {t(
              "integrations.sheets.pickSpreadsheetFirst",
              "Choose the spreadsheet first.",
            )}
          </p>
        ) : tabsLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : tabsError ? (
          <div className="flex flex-col items-start gap-2">
            <p className="text-error text-xs">{tabsError}</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => loadTabs(spreadsheetId)}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {t("common.reload", "Reload")}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {savedTabGone && (
              <p className="text-error text-xs">
                {t(
                  "integrations.sheets.tabGone",
                  'The saved tab "{{title}}" is no longer in this spreadsheet. Choose a tab.',
                  { title: sheetTitle || String(sheetId) },
                )}
              </p>
            )}
            {(tabs ?? []).map((tab) => (
              <RadioRow
                key={tab.sheetId}
                selected={tab.sheetId === sheetId}
                onClick={() =>
                  setCfg({ sheetId: tab.sheetId, sheetTitle: tab.title })
                }
                title={tab.title}
                detail={
                  tab.columns === null
                    ? undefined
                    : tab.columns.length
                      ? t("integrations.sheets.columns", "Columns: {{list}}", {
                          list: tab.columns.join(", "),
                        })
                      : t(
                          "integrations.sheets.noHeader",
                          "No header row: row 1 must name the columns",
                        )
                }
              />
            ))}
          </div>
        )}
      </FormField>

      {unpicked && (
        <p className="text-text-muted text-xs" data-testid="sheets-unpicked">
          {t(
            "integrations.sheets.pickToSave",
            "Choose the spreadsheet and the tab to save.",
          )}
        </p>
      )}

      <div className="flex items-start gap-2 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-text-primary text-xs">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-warning"
          aria-hidden="true"
        />
        <span>
          {t(
            "integrations.sheets.readsWholeTab",
            "With the find tool granted, the agent can read every row of this tab, and what it reads can reach the customer. Keep data a customer must not see in another tab. Values the agent writes are stored as plain text, never as formulas.",
          )}
        </span>
      </div>
    </div>
  );
}
