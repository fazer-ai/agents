import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MONITORING_SECTIONS } from "@/client/pages/agents/BehaviorTab";

// A watcher's editor (issue #494). The editor is one page with eight tabs and a Behavior tab of
// fifteen sections, and a monitoring agent runs almost none of it: drawn for one, the page says
// the agent could answer, and the one block that does run for it — what it does with what it
// reads — had no screen at all. The gates live in JSX, so they are read as source, the way the
// conversation page's ownership gates are.
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
    const def = EDITOR.indexOf("const MONITORING_TABS");
    expect(def).toBeGreaterThan(-1);
    const body = EDITOR.slice(def, EDITOR.indexOf("]);", def));
    for (const key of ["general", "channels", "behavior"]) {
      expect(body).toContain(`"${key}"`);
    }
    for (const key of [
      "tools",
      "knowledge",
      "guardrails",
      "channelRedirect",
      "playground",
    ]) {
      expect(body).not.toContain(`"${key}"`);
    }
    // And the list the Tabs control draws is the filtered one, keyed on the mode.
    expect(EDITOR).toContain("items={visibleTabs}");
    expect(EDITOR).toContain('const watcher = agentMode === "monitoring";');
    // A URL naming a hidden tab lands on General rather than rendering a tab the page hides.
    expect(EDITOR).toContain(
      'if (agentMode === "monitoring" && !MONITORING_TABS.has(tab))',
    );
  });

  test("the Behavior tab keeps the blocks that apply to a watcher and hides the rest", () => {
    expect([...MONITORING_SECTIONS].sort()).toEqual([
      "memory",
      "observability",
      "observation",
      // Media analysis runs on the observer's route under its own settings (issue #494 review,
      // round 2), so its controls stay reachable.
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
    // ...and a warning is kept for a watcher by its own deep-link TARGET rather than by a list of
    // keys (issue #494 review, round 3): the filter asks whether the section it would scroll to is
    // one the watcher's editor draws, so a new issue kind that targets a visible section is kept
    // without anybody remembering to add it.
    expect(EDITOR).toContain("function watcherCanActOn(");
    // ...with RAG dropped by key, since both of its issues arrive with no tab and a watcher never
    // invokes retrieval: kept, they send the operator to configure a feature nothing here uses
    // (issue #494 review, round 4).
    expect(EDITOR.replace(/\s+/g, " ")).toContain(
      'issue.key === "knowledge" || issue.key === "embedding"',
    );
    expect(EDITOR).toContain("MONITORING_SECTIONS.has(sectionId)");
    // ...and the import warnings' Review button asks the SAME question (issue #494 review, round 6):
    // it deep-links by the same tab+section pair, and a target the watcher does not draw is an
    // action that appears to work and exposes no setting.
    expect(EDITOR).toContain("function watcherSectionReachable(");
    expect(EDITOR.replace(/\s+/g, " ")).toContain(
      "watcherSectionReachable( w.target.tab, w.target.sectionId, )",
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
    // The save REPLACES the `monitoring` block through the form-state pair, like memory.
    expect(EDITOR).toContain("monitoring: observationToStored(observation)");
  });
});

// The Channels tab of a watcher (issue #494 review, round 1). The role an agent has on an inbox is
// a property of the INBOX ROW, not of the mode: an inbox can carry a monitoring agent as its
// responder — the state a mode change on a bound agent leaves, which docs/chatwoot.md keeps — and
// reading the role from the mode showed that binding as off, with no way to remove it, while
// hiding the observer binding a watcher being promoted still had.
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
    // ...and turning it off removes whatever is actually there, both if the inbox carries both —
    // stopping at the first failure (round 11), which is what the guard on the return value is.
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
    // ...and a row we only WATCH is judged by that pair alone (issue #494 review, round 4): falling
    // through to the responder's map marked a healthy observer missing because ANOTHER agent's bot
    // was gone, and offered to repair that agent's bot.
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

  // REMOVAL SURVIVES A DISCONNECTED ACCOUNT (issue #494 review, round 3). `unobserveInbox` asks no
  // account, and the observer row is what refuses to change this agent out of monitoring mode or
  // delete it — replaced by plain text, the operator was locked out of the agent from this tab.
  // THE SECOND OBSERVER IS REFUSED BY THE WRITE, so the editor stops offering it (issue #494 review,
  // round 8). `observeInbox` answers 422 `errors.inboxAlreadyObserved` for an inbox another agent
  // already watches — one watcher per inbox, since the memory thread is the contact-inbox's — and
  // this switch rendered OFF and routed its transition to `setObserving` all the same. The main
  // Channels page has never offered it; the editor was the one surface that still did.
  test("a switch that would write a second observer is blocked and says why", () => {
    const flat = readFileSync(
      "src/client/pages/agents/ChannelsTab.tsx",
      "utf8",
    ).replace(/\s+/g, " ");
    // The predicate: another agent's observer row, on a switch that is not already this agent's.
    expect(flat).toContain(
      "const otherWatcher = !role.observes && ib.observerAgentIds.length > 0",
    );
    expect(flat).toContain(
      "const observeBlocked = watcher && !mine && otherWatcher !== null;",
    );
    // ...on the switch itself, and NAMED beside it: a dead switch with nothing next to it reads as
    // a bug rather than as a rule.
    expect(flat).toContain("disabled={observeBlocked}");
    expect(flat).toContain('"editor.channels.watchedBy"');
  });

  // AN OBSERVE CAN COME BACK HAVING DONE SOMETHING ELSE (issue #494 review, round 10). Where it
  // races a bind of this same agent, `observeInbox` lets the RESPONDER win and answers 200 with a
  // DTO naming this agent as the inbox's responder and no observer row. Applying only
  // `observerAgentIds` left `agentId` stale, so the row's combined switch described a role the
  // server had already decided differently, and the next toggle acted on the wrong one.
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

  // THE COMBINED REMOVAL STOPS AT THE FIRST FAILURE (issue #494 review, round 11). The switch means
  // "this agent is on this inbox", so turning it off has to leave nothing behind — but the two
  // removals are two calls, and `setObserving` swallows its own failure into a toast. Chained, that
  // read as success: the responder unbind ran anyway and the agent came off in one role only, with
  // an error toast and a success toast side by side.
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
    expect(behavior).toContain(
      "(!watcher && (contactAuthUrlInvalid || normalizeBaseUrlInvalid || normalizeBaseUrlUnsupported || fallbackBaseUrlInvalid || fallbackBaseUrlUnsupported || fallbackModelMissing))",
    );
  });

  // ...AND THE HIDDEN SECTION IS NOT SERIALIZED EITHER, which the round-3 change above made load
  // bearing (issue #494 review, round 7). Dropping the validator for a hidden block is only half the
  // move: the Behavior save still WROTE the fallback draft, so a provider picked without its model
  // and then a flip to monitoring sent a half-named pair to a write boundary that refuses it by name
  // (`assertSettingsModelFallback`), with the only control that could fix it off screen. The fallback
  // is the one hidden block whose invalid state the server refuses, so it is the one whose key the
  // save omits; `...settings` then carries the stored value through byte for byte.
  test("a watcher's save omits only the fallback pair the write boundary refuses", () => {
    const flat = EDITOR.replace(/\s+/g, " ");
    // The predicate is the BOUNDARY's question, not "is this a watcher" (round 9): omitting the key
    // for every watcher dropped a valid draft too, and `applyBehavior` reloaded over it.
    expect(flat).toContain(
      "...(watcher && fallbackModelIsMissing(modelFallback) ? {} : { modelFallback: modelFallbackToStored(modelFallback) }),",
    );
    // And nowhere else: an unconditional write beside it would put the refused pair back on the wire.
    expect(
      flat.split("modelFallback: modelFallbackToStored(modelFallback)").length -
        1,
    ).toBe(1);
  });

  // ...AND THE PANEL CLOSES WITH ITS TRIGGER (issue #494 review, round 6). Flipping a production
  // agent to monitoring removed the entry point and left an already-open playground mounted and
  // usable — a reply surface for an agent whose answering UI is meant to be gone.
  test("an open playground closes when the mode hides it", () => {
    expect(EDITOR.replace(/\s+/g, " ")).toContain(
      'if (agentMode === "monitoring") setPlaygroundOpen(false);',
    );
  });

  test("routes a new binding by the SAVED mode", () => {
    // Binding acts immediately and the server judges the stored agent, so a draft flipped on
    // General must not decide which endpoint the switch calls.
    expect(EDITOR).toContain(
      "? normalizeAgentMode(syncedAgentRef.current.mode)",
    );
  });

  test("the tab redirect keeps the way back to the conversation", () => {
    const at = EDITOR.indexOf(
      'if (agentMode === "monitoring" && !MONITORING_TABS.has(tab))',
    );
    expect(at).toBeGreaterThan(-1);
    expect(EDITOR.slice(at, at + 400).replace(/\s+/g, " ")).toContain(
      `backToConversation ? \`?from=${D}{backToConversation}\` : ""`,
    );
  });
});
