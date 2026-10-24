import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { Tabs } from "@/client/components";
import {
  useConfirmLeave,
  useNavGuard,
} from "@/client/contexts/NavGuardContext";
import { api } from "@/client/lib/api";
import { afterTrapRelease, sentinelOnTop } from "@/client/lib/unsavedGuard";
import type { InboxOption } from "./OccurrenceInboxes";
import { OccurrenceMonitorHeader } from "./OccurrenceMonitorHeader";
import { type MonitorView, OccurrenceMonitors } from "./OccurrenceMonitors";
import { OccurrenceRounds } from "./OccurrenceRounds";
import {
  loadInboxOptions,
  OccurrenceSettings,
  type OccurrencesConfig,
} from "./OccurrenceSettings";
import { OccurrenceThemes } from "./OccurrenceThemes";

const TABS = ["config", "themes", "rounds"] as const;
type Tab = (typeof TABS)[number];
const tabOf = (raw: string | null): Tab =>
  (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "config";

// One monitor (docs/occurrences.md): its header (the name, edited in place, Duplicate and Delete) over
// three tabs: its configuration, the open themes and the rounds.
// A link opens the tab `?tab=` names; an unknown value opens the configuration. Every tab stays
// mounted, so an unsaved edit survives a look at the rounds, and leaving with one asks first.
// A tab change is no history entry: the guard's Back trap copies the page's URL into its sentinel,
// so the URL follows the tab in place, and only while nothing is unsaved.
function MonitorTabs({
  monitor,
  others,
  onBack,
  onSaved: onMonitorSaved,
  onDuplicated,
  onDeleted,
}: {
  monitor: MonitorView;
  others: MonitorView[];
  onBack: () => void;
  onSaved: () => void;
  onDuplicated: (copy: MonitorView) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  // A tab picked here that the URL does not say yet. A URL change (a link, or the write below) is the
  // tab again, so the two never write each other back.
  const [picked, setPicked] = useState<Tab | null>(null);
  const tab = picked ?? tabOf(raw);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on a URL change only.
  useEffect(() => {
    setPicked(null);
  }, [raw]);
  const [monitorOn, setMonitorOn] = useState(monitor.enabled);
  const [reloadKey, setReloadKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  // A name typed in the header and not saved: unsaved like the configuration, so it guards leaving
  // and holds the tab out of the URL the same way.
  const [nameDirty, setNameDirty] = useState(false);
  const unsaved = dirty || nameDirty;
  useNavGuard(unsaved);
  const confirmLeave = useConfirmLeave();
  const back = () => confirmLeave(onBack);
  const onLoaded = useCallback(
    (c: OccurrencesConfig) => setMonitorOn(c.enabled),
    [],
  );
  const onSaved = useCallback(
    (c: OccurrencesConfig) => {
      setMonitorOn(c.enabled);
      setReloadKey((k) => k + 1);
      onMonitorSaved();
    },
    [onMonitorSaved],
  );
  const go = (next: string) => {
    const to = tabOf(next);
    setPicked(to === tabOf(raw) ? null : to);
  };
  // The URL takes the picked tab once nothing is unsaved, after the trap has popped its sentinel, and
  // only while this monitor is still the open one.
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    if (unsaved || picked === null) return;
    afterTrapRelease(() => {
      if (!alive.current) return;
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          next.set("tab", picked);
          return next;
        },
        { replace: true },
      );
    });
  }, [unsaved, picked, setParams]);

  return (
    <div className="flex flex-col gap-4">
      <OccurrenceMonitorHeader
        monitor={monitor}
        onBack={back}
        onRenamed={onMonitorSaved}
        onDuplicated={onDuplicated}
        onDeleted={onDeleted}
        onNameDirtyChange={setNameDirty}
      />
      <Tabs
        aria-label={monitor.name}
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
          monitorId={monitor.id}
          otherMonitors={others}
          onLoaded={onLoaded}
          onSaved={onSaved}
          onDirtyChange={setDirty}
          onShowRounds={() => go("rounds")}
          reloadKey={reloadKey}
          active={tab === "config"}
        />
      </div>
      <div role="tabpanel" hidden={tab !== "themes"}>
        <OccurrenceThemes monitorId={monitor.id} active={tab === "themes"} />
      </div>
      <div role="tabpanel" hidden={tab !== "rounds"}>
        <OccurrenceRounds
          monitorId={monitor.id}
          monitorOn={monitorOn}
          active={tab === "rounds"}
          reloadKey={reloadKey}
        />
      </div>
    </div>
  );
}

// The account's occurrence monitors: the list, and one of them open (`?monitor=<id>`), so a link opens
// a monitor and Back returns to the list. An id the account does not have shows the list.
export function OccurrencesPanel() {
  const [params, setParams] = useSearchParams();
  const openId = params.get("monitor");
  // The monitor open now, for a continuation that lands after the operator moved on: a copy or a
  // delete answered late never takes them away from where they went, in this page or past it.
  const openNow = useRef<string | null>(openId);
  openNow.current = openId;
  useEffect(
    () => () => {
      openNow.current = null;
    },
    [],
  );
  const [monitors, setMonitors] = useState<MonitorView[]>([]);
  const [max, setMax] = useState(10);
  // null when the newest read of the account's inboxes failed (or none landed yet): a monitor's inbox
  // is then named by its id, never called removed.
  const [inboxes, setInboxes] = useState<InboxOption[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const confirmLeave = useConfirmLeave();

  // Only the newest read lands: two refreshes in flight (two quick duplicates) never let the older
  // list replace the newer one.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    setFailed(false);
    const [res, roster] = await Promise.all([
      api.api.v1.occurrences.monitors.get(),
      loadInboxOptions(),
    ]);
    if (mine !== seq.current) return;
    if (res.error || !res.data) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setMonitors(res.data.monitors);
    setMax(res.data.max);
    setInboxes(roster);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (id: string | null) => {
    const p = new URLSearchParams(params);
    p.delete("tab");
    if (id === null) p.delete("monitor");
    else p.set("monitor", id);
    // Discarding an edit leaves with the guard's sentinel still on top: the list takes its place, as
    // a guarded link does, so Back does not land on a dead copy of the monitor.
    setParams(p, { replace: sentinelOnTop() });
  };

  const current = monitors.find((m) => m.id === openId);
  if (current)
    return (
      <MonitorTabs
        key={current.id}
        monitor={current}
        others={monitors.filter((m) => m.id !== current.id)}
        onBack={() => {
          open(null);
          void load();
        }}
        onSaved={() => void load()}
        onDuplicated={(copy) => {
          // NOTE: the copy the server answered is the one opened, so a list read that fails or lands
          // late does not decide it. It opens after the name form's Back trap has let go (a
          // navigation before that pop would be undone by it), only while the monitor that made it
          // is still the open one, and an unsaved edit asks first; keeping it leaves the copy listed.
          setMonitors((ms) =>
            ms.some((m) => m.id === copy.id) ? ms : [...ms, copy],
          );
          void load();
          afterTrapRelease(() => {
            if (openNow.current === current.id)
              confirmLeave(() => open(copy.id));
          });
        }}
        onDeleted={() => {
          setMonitors((ms) => ms.filter((m) => m.id !== current.id));
          if (openNow.current === current.id) open(null);
          void load();
        }}
      />
    );
  return (
    <OccurrenceMonitors
      monitors={monitors}
      max={max}
      inboxes={inboxes}
      loading={loading}
      failed={failed}
      onRetry={() => void load()}
      onOpen={open}
      onChanged={load}
    />
  );
}
