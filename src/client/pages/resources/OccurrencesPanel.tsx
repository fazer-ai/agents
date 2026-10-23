import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Tabs } from "@/client/components";
import { OccurrenceRounds } from "./OccurrenceRounds";
import {
  OccurrenceSettings,
  type OccurrencesConfig,
} from "./OccurrenceSettings";
import { OccurrenceThemes } from "./OccurrenceThemes";

const TABS = ["config", "themes", "rounds"] as const;
type Tab = (typeof TABS)[number];

// The account's occurrence monitor (docs/occurrences.md), in three tabs: its configuration, the open
// themes and the rounds. The open tab is in the URL (`?tab=`), so a link opens it and Back returns to
// the one before; an unknown value opens the configuration. Every tab stays mounted, so an unsaved
// edit survives a look at the rounds.
export function OccurrencesPanel() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? "")
    ? (raw as Tab)
    : "config";
  const [monitorOn, setMonitorOn] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const onLoaded = useCallback(
    (c: OccurrencesConfig) => setMonitorOn(c.enabled),
    [],
  );
  const onSaved = useCallback((c: OccurrencesConfig) => {
    setMonitorOn(c.enabled);
    setReloadKey((k) => k + 1);
  }, []);
  const go = (next: string) => {
    if (next === tab) return;
    const p = new URLSearchParams(params);
    p.set("tab", next);
    setParams(p);
  };

  return (
    <div className="flex flex-col gap-4">
      <Tabs
        aria-label={t("occurrences.title", "Occurrence monitor")}
        value={tab}
        onChange={go}
        items={[
          {
            key: "config",
            label: t("occurrences.tab.config", "Configuration"),
            dirty,
          },
          { key: "themes", label: t("occurrences.tab.themes", "Themes") },
          { key: "rounds", label: t("occurrences.tab.rounds", "Rounds") },
        ]}
      />
      <div role="tabpanel" hidden={tab !== "config"}>
        <OccurrenceSettings
          onLoaded={onLoaded}
          onSaved={onSaved}
          onDirtyChange={setDirty}
          onShowRounds={() => go("rounds")}
          reloadKey={reloadKey}
          active={tab === "config"}
        />
      </div>
      <div role="tabpanel" hidden={tab !== "themes"}>
        <OccurrenceThemes active={tab === "themes"} />
      </div>
      <div role="tabpanel" hidden={tab !== "rounds"}>
        <OccurrenceRounds
          monitorOn={monitorOn}
          active={tab === "rounds"}
          reloadKey={reloadKey}
        />
      </div>
    </div>
  );
}
