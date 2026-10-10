import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MONITORING_SECTIONS } from "@/client/pages/agents/BehaviorTab";
import { watcherTabKeys } from "@/client/pages/agents/editorTabs";

// A watcher's editor. The page has eight tabs and a Behavior tab of fifteen sections, and a
// monitoring agent runs almost none of it: drawn in full, the page would say the agent could answer.
// The block that does run for it (what it does with what it reads) has its own screen. The gates
// live in JSX, so they are read as source, the way the conversation page's ownership gates are.
const EDITOR = readFileSync(
  "src/client/pages/agents/AgentEditorPage.tsx",
  "utf8",
);
const BEHAVIOR = readFileSync(
  "src/client/pages/agents/BehaviorTab.tsx",
  "utf8",
);

describe("the editor of a monitoring agent", () => {
  test("draws only the tabs a watcher has a use for", () => {
    // NOTE: tools are drawn on both engines: their grants fence the model's calls and the rules'
    // actions alike. Knowledge is the language model's; questions and rules have their own tab
    // (agents#1224, tested in tests/client/decisions-engine-editor.test.ts).
    for (const engine of ["llm", "decisions"] as const) {
      const tabs = watcherTabKeys(engine);
      for (const key of ["general", "channels", "behavior", "tools"]) {
        expect(tabs.has(key)).toBe(true);
      }
      // What stays out is what only an agent that SPEAKS has: a reply to screen, a redirect that
      // messages the customer on another channel, a conversation to hold in the playground.
      for (const key of ["guardrails", "channelRedirect", "playground"]) {
        expect(tabs.has(key)).toBe(false);
      }
    }
    // And the list the Tabs control draws is the filtered one, keyed on the mode and the engine.
    expect(EDITOR).toContain("items={visibleTabs}");
    expect(EDITOR).toContain('const watcher = agentMode === "monitoring";');
    expect(EDITOR).toContain("watcherTabKeys(engine).has(item.key)");
    // A URL naming a hidden tab lands on General rather than rendering a tab the page hides.
    expect(EDITOR).toContain("? !watcherTabKeys(engine).has(tab)");
  });

  test("no tab a watcher draws offers the playground", () => {
    // NOTE: the playground loads the agent WITHOUT `ignoreMode`, so a monitoring agent cannot run
    // there: an action that opens a panel whose every run fails as `agentNotRunnable` is worse than
    // no action. Every watcher-visible tab guards it. Read as source, like the tab gates above.
    for (const tab of [
      "GeneralTab",
      "BehaviorTab",
      "ToolsTab",
      "KnowledgeTab",
    ]) {
      const at = EDITOR.indexOf(`<${tab}`);
      expect(at).toBeGreaterThan(-1);
      const prop = EDITOR.indexOf("onOpenPlayground=", at);
      expect(prop).toBeGreaterThan(-1);
      expect(EDITOR.slice(prop, prop + 60)).toContain(
        "watcher ? undefined : openPlayground",
      );
    }
  });

  test("the Behavior tab keeps the blocks that apply to a watcher and hides the rest", () => {
    expect([...MONITORING_SECTIONS].sort()).toEqual([
      // NOTE: the prompt block built on every turn, this one included.
      "attributeContext",
      // NOTE: the contact gate's rule decides which conversations a watcher observes.
      "contactAuth",
      // NOTE: ...and the ceiling on the tool calls a watcher actually makes.
      "limits",
      "memory",
      "modelFallback",
      "observability",
      "observation",
      // NOTE: media analysis runs on the observer's route under its own settings, so its controls
      // stay reachable.
      "stt",
      "vision",
    ]);
    // Every section the set leaves out carries the hidden switch; every section it keeps does not.
    const ids = [
      ...BEHAVIOR.matchAll(
        /<Section\n\s+id="([A-Za-z]+)"\n(\s+hidden=\{watcher\}\n)?/g,
      ),
    ];
    expect(ids.length).toBeGreaterThan(10);
    for (const m of ids) {
      const id = m[1] as string;
      const hidden = m[2] !== undefined;
      expect({ id, hidden }).toEqual({
        id,
        hidden: !MONITORING_SECTIONS.has(id),
      });
    }
    // NOTE: ...and a warning is kept for a watcher by its own deep-link TARGET rather than a list of
    // keys: the filter asks whether the section it would scroll to is one the watcher's editor
    // draws, so a new issue kind targeting a visible section is kept automatically.
    expect(EDITOR).toContain("function watcherCanActOn(");
    // NOTE: ...and RAG issues are not dropped by key: a watcher searches the knowledge bases it was
    // granted, so a broken embedding credential is a real fault with a real screen behind it.
    expect(EDITOR.replace(/\s+/g, " ")).not.toContain(
      'issue.key === "knowledge" || issue.key === "embedding"',
    );
    expect(EDITOR).toContain("MONITORING_SECTIONS.has(sectionId)");
    // NOTE: ...and the import warnings' Review button asks the SAME question: it deep-links by the
    // same tab+section pair, and a target the watcher does not draw is an action that appears to work
    // and exposes no setting.
    expect(EDITOR).toContain("function watcherSectionReachable(");
    expect(EDITOR.replace(/\s+/g, " ")).toContain(
      "watcherSectionReachable( w.target.tab, w.target.sectionId, engine, )",
    );
    expect(EDITOR).not.toContain("WATCHER_ISSUE_KEYS");

    // Hidden, not unmounted: the Section keeps its children in the tree.
    const nav = readFileSync("src/client/pages/agents/SectionNav.tsx", "utf8");
    expect(nav).toContain('hidden && "hidden"');
  });

  test("the Observation block is drawn first, and only for a watcher", () => {
    const at = BEHAVIOR.indexOf("<ObservationSection");
    expect(at).toBeGreaterThan(-1);
    expect(BEHAVIOR.slice(at - 60, at)).toContain("{watcher && (");
    const first = BEHAVIOR.indexOf('<Section\n            id="availability"');
    expect(at).toBeLessThan(first);
    // The save REPLACES the `monitoring` block through the form-state pair, like memory, and only
    // for an agent that is a watcher or already has the block. Its timing is the form's, and the
    // decision setup goes back as stored (it has its own save, agents#1224).
    expect(EDITOR.replace(/\s+/g, " ")).toContain(
      '...monitoringPatch( withDecisionsOf( observation, observationToForm(syncedAgentRef.current?.settings ?? {}), ), agentMode === "monitoring", )',
    );
    expect(EDITOR).not.toContain("monitoring: observationToStored(");
  });
});

// The Channels tab of a watcher. The role an agent has on an inbox is a property of the INBOX ROW,
// not of the mode: an inbox can carry a monitoring agent as its responder (the state a mode change
// on a bound agent leaves, which docs/chatwoot.md keeps). Reading the role from the mode would show
// that binding as off with no way to remove it, and hide the observer binding of an agent being
// promoted.
describe("the Channels tab of a watcher", () => {
  // The needles below quote SOURCE that interpolates, and a plain string holding `${` is itself a
  // lint error (`noTemplateCurlyInString`) — so the placeholder is assembled instead of written.
  const D = "$";
  const CHANNELS = readFileSync(
    "src/client/pages/agents/ChannelsTab.tsx",
    "utf8",
  );

  test("reads both roles off the inbox row", () => {
    expect(CHANNELS).toContain("const rolesOn = (ib: Inbox) => ({");
    expect(CHANNELS).toContain("responds: ib.agentId === agentId,");
    expect(CHANNELS).toContain(
      "observes: ib.observerAgentIds.includes(agentId),",
    );
    // The switch is on when either role is there...
    expect(CHANNELS).toContain("const mine = role.responds || role.observes;");
    // NOTE: ...and turning it off removes whatever is actually there, both if the inbox carries both,
    // stopping at the first failure (the guard on the return value).
    expect(CHANNELS).toContain(
      "if (role.observes && !(await setObserving(ib.id, false))) return;",
    );
    expect(CHANNELS).toContain(
      "if (role.responds) await setBinding(ib.id, null);",
    );
  });

  test("judges and repairs the observer bot on its own pair", () => {
    // The reconcile answers per PAIR; the responder's map cannot speak for an observer binding.
    expect(CHANNELS).toContain(
      "setObserverStatus({ ...data.observerStatuses })",
    );
    expect(CHANNELS.replace(/\s+/g, " ")).toContain(
      `observerStatus[\`${D}{ib.id}:${D}{agentId}\`] === "missing"`,
    );
    // ...and the repair for that pair is an observe, not the inbox reconnect, which would fix the
    // responder's bot and leave this one exactly as broken.
    expect(CHANNELS).toContain("async function reobserve(inboxId: string) {");
    // NOTE: ...and a row we only WATCH is judged by that pair alone: falling through to the
    // responder's map would mark a healthy observer missing because ANOTHER agent's bot was gone,
    // and offer to repair that agent's bot.
    expect(CHANNELS).toContain(
      "const observerOnly = role.observes && !role.responds;",
    );
    expect(CHANNELS.replace(/\s+/g, " ")).toContain(
      "observerOnly || observerBroken ? reobserve(ib.id) : reconnectBot(ib.id)",
    );
    // Whitespace-insensitive: the point is that the broken PAIR routes to the observe, not the
    // shape the formatter happens to leave the ternary in.
    expect(CHANNELS.replace(/\s+/g, " ")).toContain(
      "observerBroken ? reobserve(ib.id) : reconnectBot(ib.id)",
    );
  });

  // NOTE: an inbox carries several watchers, so no switch is blocked because another
  // agent already observes the inbox, and the main Channels page offers every monitoring agent not
  // already on it.
  test("another agent watching an inbox blocks neither the switch nor the add menu", () => {
    const tab = readFileSync(
      "src/client/pages/agents/ChannelsTab.tsx",
      "utf8",
    ).replace(/\s+/g, " ");
    expect(tab).not.toContain("observerAgentIds[0]");
    expect(tab).not.toContain("disabled={observeBlocked}");
    const page = readFileSync(
      "src/client/pages/ChannelsPage.tsx",
      "utf8",
    ).replace(/\s+/g, " ");
    expect(page).toContain("!observerAgentIds.includes(a.id)");
    expect(page).not.toContain("observerAgentIds.length > 0 ? []");
  });

  // NOTE: an observe can come back having done something else. Racing a bind of this same agent,
  // `observeInbox` lets the RESPONDER win and answers 200 with a DTO naming this agent as responder
  // and no observer row. Both `observerAgentIds` and `agentId` are applied, or the combined switch
  // would describe a stale role and the next toggle act on the wrong one.
  test("an observe applies both roles from the answer, on both callers", () => {
    const flat = readFileSync(
      "src/client/pages/agents/ChannelsTab.tsx",
      "utf8",
    ).replace(/\s+/g, " ");
    // One place writes the pair, and it writes BOTH fields.
    expect(flat).toContain("function applyInboxRoles(");
    expect(flat).toContain("agentId: dto.agentId,");
    expect(flat).toContain("observerAgentIds: dto.observerAgentIds,");
    // The status follows the ANSWER, not the request.
    expect(flat).toContain(
      'if (dto.observerAgentIds.includes(agentId)) nextMap[key] = "active"; else delete nextMap[key];',
    );
    // Both callers go through it: the switch and the repair.
    expect(
      flat.split("applyInboxRoles(inboxId, res.data.inbox)").length - 1,
    ).toBe(2);
    // ...and the toast reports what came back, not what was asked for.
    expect(flat).toContain('"channels.observeResponderWon"');
  });

  // NOTE: the combined removal stops at the first failure. The switch means "this agent is on this inbox",
  // so turning it off must leave nothing behind, but the two removals are two calls and
  // `setObserving` swallows its own failure into a toast. Chained without a check, the unbind would
  // run anyway: the agent removed in one role only, with an error and a success toast side by side.
  test("the combined removal does not unbind the responder after a failed unobserve", () => {
    const flat = readFileSync(
      "src/client/pages/agents/ChannelsTab.tsx",
      "utf8",
    ).replace(/\s+/g, " ");
    expect(flat).toContain(
      "async function setObserving( inboxId: string, next: boolean, ): Promise<boolean> {",
    );
    expect(flat).toContain(
      "if (role.observes && !(await setObserving(ib.id, false))) return;",
    );
  });

  test("an observer can be removed while the account is disconnected", () => {
    const flat = CHANNELS.replace(/\s+/g, " ");
    expect(flat).toContain("{disconnected && role.observes ? (");
    expect(flat).toContain("void setObserving(ib.id, false)");
    // ...and the switch beside it is the REMOVAL: checked, with no way to turn it back on while the
    // account is away.
    expect(flat).toContain("<Switch checked onCheckedChange=");
  });

  // ...and the Behavior tab's Save is not held hostage by a section the watcher does not draw.
  test("save is not blocked by validators for hidden sections", () => {
    const behavior = readFileSync(
      "src/client/pages/agents/BehaviorTab.tsx",
      "utf8",
    ).replace(/\s+/g, " ");
    // NOTE: only the fields a watcher does NOT draw sit behind the exemption. The fallback's
    // validators are asked because its section is drawn for a watcher, and so are the contact gate's
    // conditions, the refusal of a gate with nothing to decide, and its endpoint's url.
    expect(behavior).toContain(
      "contactAuthRuleBad || contactAuthEmpty || contactAuthUrlInvalid || (!watcher && (normalizeBaseUrlInvalid || normalizeBaseUrlUnsupported))",
    );
    // NOTE: ...and memory and the fallback are asked for a watcher on the language model, the one that
    // draws them; a watcher on questions and rules draws neither (agents#1224).
    expect(behavior).toContain(
      "(!chatModelUnused && (memoryBaseUrlInvalid || memoryBaseUrlUnsupported || fallbackBaseUrlInvalid || fallbackBaseUrlUnsupported || fallbackModelMissing)) ||",
    );
    expect(behavior).toContain(
      'const chatModelUnused = watcher && observation.engine === "decisions";',
    );
    expect(behavior).toContain('id="memory" hidden={chatModelUnused}');
    expect(behavior).toContain('id="modelFallback" hidden={chatModelUnused}');
  });

  // NOTE: the fallback section is drawn for a watcher, with its validator, so the save writes the block
  // like any other. Skipping a half-named pair for a watcher would discard an edit the operator can
  // see themselves making; the server refuses that pair by name (`assertSettingsModelFallback`,
  // docs/ui.md).
  test("a watcher's save writes the fallback block like any other", () => {
    const flat = EDITOR.replace(/\s+/g, " ");
    expect(flat).toContain(
      "modelFallback: modelFallbackToStored(modelFallback),",
    );
    expect(flat).not.toContain("watcher && fallbackModelIsMissing");
  });

  // NOTE: the panel closes with its trigger: flipping a production agent to monitoring removes the entry
  // point, and an already-open playground must not stay mounted as a reply surface.
  test("an open playground closes when the mode hides it", () => {
    expect(EDITOR.replace(/\s+/g, " ")).toContain(
      'if (agentMode === "monitoring") setPlaygroundOpen(false);',
    );
  });

  // NOTE: the ceiling acts on a watcher, but not on the tick: an observation rebuilds the conversation into
  // one message and the window always keeps the current turn, so nothing is trimmed off a tick.
  // `runCompaction` loads a watcher's config with `ignoreMode` and hands this ceiling to the
  // summariser, so the control stays and only the help text differs.
  test("the history ceiling tells a watcher what it actually bounds", () => {
    const at = BEHAVIOR.indexOf("editor.limitsMaxHistoryTokensHelpObserving");
    expect(at).toBeGreaterThan(-1);
    const before = BEHAVIOR.slice(Math.max(0, at - 300), at).replace(
      /\s+/g,
      " ",
    );
    expect(before).toContain("help={ watcher ?");
    // ...and the setting itself is still offered: hiding it would take away a control that bounds
    // what the watcher's own memory summarises.
    expect(BEHAVIOR).toContain("editor.limitsMaxHistoryTokens");
    expect(MONITORING_SECTIONS.has("limits")).toBe(true);
  });

  test("routes a new binding by the SAVED mode", () => {
    // Binding acts immediately and the server judges the stored agent, so a draft flipped on
    // General must not decide which endpoint the switch calls.
    expect(EDITOR).toContain(
      "? normalizeAgentMode(syncedAgentRef.current.mode)",
    );
  });

  test("the tab redirect keeps the way back to the conversation", () => {
    const at = EDITOR.indexOf("? !watcherTabKeys(engine).has(tab)");
    expect(at).toBeGreaterThan(-1);
    expect(EDITOR.slice(at, at + 400).replace(/\s+/g, " ")).toContain(
      `backToConversation ? \`?from=${D}{backToConversation}\` : ""`,
    );
  });
});
