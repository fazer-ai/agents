/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components/Toast";
import { AuthProvider } from "@/client/contexts/AuthContext";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import { BehaviorTab } from "@/client/pages/agents/BehaviorTab";
import { observationToForm } from "@/client/pages/agents/observationFormState";
import { ToolGrantsEditor } from "@/client/pages/agents/ToolGrantsEditor";
import { readTtsFormState } from "@/client/pages/agents/ttsFormState";

// OPENING A TAB MUST NOT REWRITE A TARGET THE RUNTIME STILL HONORS.
//
// A Chatwoot team (or agent) id belongs to ONE account, so both handoff targets are stored with the
// account they were picked in: `contactAuth.handoffTeamInstanceId` and `handoff.targetInstanceId`.
// The runtime reads exactly that — `teamTargetUsable` in modules/chatwoot/webhook.ts and the pinned
// fallback in graph/prepare.ts both say the recorded account decides, per conversation, and that
// counting accounts is only the fallback for a value stored before the field existed.
//
// Both editors were still deciding on the count alone. Bind one inbox per account to the same agent
// (a test inbox beside the live one) and merely OPENING the tab wiped the stored target and left the
// tab marked unsaved, with nobody having touched the form. The next save persisted the loss: refused
// contacts stopped being routed to the team that had been configured for them.
//
// So these tests assert on the SETTER, not on pixels: the write is both the damage and the reason
// the unsaved dot lights up, and a test that only looked at the rendered field would pass on the
// broken code the moment the field still showed the old value for a frame.
//
// NOTE: every assertion reduces to a number or a boolean BEFORE expect. A failing expectation
// holding a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const realFetch = globalThis.fetch;

interface Account {
  instanceId: string;
  accountId: number;
  accountName: string | null;
}

const ACCOUNT_ONE: Account = {
  instanceId: "1",
  accountId: 2,
  accountName: "Homologação",
};
const ACCOUNT_TWO: Account = {
  instanceId: "2",
  accountId: 1,
  accountName: "Guichê Web",
};

// `agents-teams` answers with the accounts the agent's bound inboxes live in, and deliberately with
// an EMPTY listing whenever that is more than one: agent and team ids are account-scoped, so there
// is no single account whose names could be offered.
function stubAgentsTeams(accounts: Account[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    // The other live reads the tab fires on mount, answered in their real SHAPE rather than with an
    // empty object: a picker that gets `{}` reads `undefined.filter` and takes the whole tree down,
    // and a crashed render is indistinguishable here from a component that decided to write nothing.
    const body = url.pathname.includes("/agents-teams/")
      ? { agents: [], teams: [], accounts }
      : url.pathname.includes("/custom-attributes/")
        ? { attributes: [], accountCount: accounts.length }
        : url.pathname.includes("/labels/")
          ? { labels: [], accountCount: accounts.length }
          : url.pathname.includes("/service-window-templates/")
            ? { templates: [] }
            : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

// ── contact-auth: the team a refused conversation is assigned to ──────────────────────────────

function renderContactAuth(
  handoffTeamId: string,
  handoffTeamInstanceId: string,
): { teamIds: string[] } {
  const noop = () => undefined;
  const teamIds: string[] = [];
  // STATEFUL on purpose. A setter that records and throws the value away leaves the component
  // re-deciding on the same stale props forever, so the "cleared" cases would show an unbounded
  // stream of writes instead of one — and a run that loops is not a run that proved anything.
  function Harness() {
    const [contactAuth, setContactAuth] = useState({
      enabled: true,
      url: "https://gate.example.com/authorize",
      credentialRef: "",
      timeoutMs: "5000",
      noticeCooldownSeconds: "60",
      includeMessageText: false,
      denyMessage: "",
      mode: "perMessage",
      grantTtlSeconds: "86400",
      handoffEnabled: true,
      handoffTeamId,
      handoffTeamInstanceId,
    });
    const props: React.ComponentProps<typeof BehaviorTab> &
      Record<string, unknown> = {
      refusals: {
        sttCredential: null,
        ttsCredential: null,
        ttsNormalizeCredential: null,
        visionCredential: null,
        visionExtractionPrompt: null,
        contactAuthCredential: null,
        contactAuthDenyMessage: null,
        memoryCredential: null,
        modelFallbackCredential: null,
        awayMessage: null,
        followUpSteps: [],
      },
      agentId: "1",
      agentName: "Recepção",
      companyName: "Clínica Moreira",
      hours: [],
      businessHoursId: "",
      setBusinessHoursId: noop,
      awayEnabled: false,
      setAwayEnabled: noop,
      awayMessage: "",
      setAwayMessage: noop,
      followUpHoursId: "",
      setFollowUpHoursId: noop,
      debounce: {
        enabled: false,
        windowSeconds: "8",
        maxMessagesPerBurst: "10",
        maxWindowSeconds: "60",
      },
      setDebounce: noop,
      stt: {
        enabled: false,
        provider: "openai",
        model: "",
        language: "pt",
        credentialRef: "",
        baseURL: "",
      },
      setStt: noop,
      sttCredBaseUrl: null,
      contactAuth,
      // The write under test. Recording the team id it is called with is what separates "left alone"
      // from "cleared": the component clears by calling this with an empty pair.
      setContactAuth: (next: unknown) => {
        teamIds.push((next as { handoffTeamId: string }).handoffTeamId);
        setContactAuth(next as typeof contactAuth);
      },
      tts: readTtsFormState(undefined),
      setTts: noop,
      agentModelProvider: "openai",
      agentModelName: "gpt-4o",
      agentModelCredentialRef: "",
      agentModelBaseUrl: "",
      ttsNormalizeCredBaseUrl: null,
      split: {
        enabled: false,
        maxChars: "300",
        typingWpm: "200",
        maxDelayMs: "0",
      },
      setSplit: noop,
      signature: {
        enabled: false,
        text: "",
        position: "top" as const,
        separator: "blank" as const,
      },
      setSignature: () => {},
      vision: {
        enabled: false,
        provider: "openai",
        model: "",
        credentialRef: "",
        baseURL: "",
        extractionPrompt: "",
      },
      setVision: noop,
      visionCredBaseUrl: null,
      limits: { maxToolCalls: "10", maxHistoryTokens: "" },
      setLimits: noop,
      memory: {
        compactionEnabled: false,
        provider: "",
        model: "",
        credentialRef: "",
        baseURL: "",
      },
      setMemory: noop,
      mode: "production",
      observation: observationToForm({}),
      setObservation: noop,
      memoryCredBaseUrl: null,
      modelFallback: {
        provider: "",
        model: "",
        credentialRef: "",
        baseURL: "",
      },
      setModelFallback: noop,
      modelFallbackCredBaseUrl: null,
      // A SUPERSET of what this tree's component reads: the two editions do not carry the same props,
      // and the extras are absorbed by the `Record<string, unknown>` half of the annotation. Annotated
      // rather than cast on purpose — a cast would also absorb a prop the component REQUIRES and this
      // bag omits, turning it into a render-time TypeError instead of a tsc error.
      observability: {
        logToolValues: false,
        fullDetail: false,
        fullDetailUntil: null,
      },
      savedObservability: {
        logToolValues: false,
        fullDetail: false,
        fullDetailUntil: null,
      },
      langfuseSendContent: false,
      setObservability: noop,
      sendImage: { allowedHosts: "" },
      takeover: { onHumanReply: true },
      setTakeover: noop,
      setSendImage: noop,
      attributeContext: { conversation: [], contact: [], task: [] },
      setAttributeContext: noop,
      serviceWindow: {
        enabled: false,
        windowHours: "24",
        templateName: "",
        templateLanguage: "",
        templateParams: "",
        templateContent: "",
      },
      setServiceWindow: noop,
      followUp: { enabled: false, steps: [], pauseWhileAppointment: false },
      setFollowUp: noop,
      redirectSuppressesFollowUp: false,
      onScheduleSaved: noop,
      dirty: false,
      saving: false,
      onSave: noop,
      onDiscard: noop,
      onOpenPlayground: noop,
    };
    return <BehaviorTab {...props} />;
  }
  render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );
  return { teamIds };
}

// The listing has to have LANDED before the absence of a write means anything: at mount there is no
// data yet and every variant looks quiet. Waits on a call the stub always answers, then lets the
// effects that react to it run.
async function settle(): Promise<void> {
  await waitFor(() => {
    expect(document.body.textContent !== null).toBe(true);
  });
  await new Promise((r) => setTimeout(r, 30));
}

describe("contact-auth handoff team, on an agent serving several accounts", () => {
  test("a team recorded in an account the agent still serves is left alone", async () => {
    stubAgentsTeams([ACCOUNT_ONE, ACCOUNT_TWO]);
    const { teamIds } = renderContactAuth("1", "2");
    await settle();
    expect(teamIds.length).toBe(0);
  });

  test("a team recorded in an account the agent no longer serves is cleared", async () => {
    stubAgentsTeams([ACCOUNT_ONE, ACCOUNT_TWO]);
    const { teamIds } = renderContactAuth("1", "9");
    await settle();
    expect(teamIds).toEqual([""]);
  });

  test("a legacy team with no account recorded is cleared once there are several", async () => {
    stubAgentsTeams([ACCOUNT_ONE, ACCOUNT_TWO]);
    const { teamIds } = renderContactAuth("1", "");
    await settle();
    expect(teamIds).toEqual([""]);
  });

  test("a legacy team is kept while the agent serves exactly one account", async () => {
    stubAgentsTeams([ACCOUNT_TWO]);
    const { teamIds } = renderContactAuth("1", "");
    await settle();
    expect(teamIds.length).toBe(0);
  });

  // No inbox bound (or the read failed) says nothing about the target, and must not cost the
  // operator their choice: an agent configured before its first binding would otherwise lose it.
  test("no accounts at all is not evidence, and clears nothing", async () => {
    stubAgentsTeams([]);
    const { teamIds } = renderContactAuth("1", "2");
    await settle();
    expect(teamIds.length).toBe(0);
  });
});

// ── handoff_to_human: the pinned agent or team ───────────────────────────────────────────────

const { NATIVE_TOOL_NAMES, RAG_TOOL_NAMES } = await import(
  "@/graph/tools/catalog"
);

const CATALOG = {
  native: NATIVE_TOOL_NAMES.map((n) => ({ name: n })),
  rag: RAG_TOOL_NAMES.map((n) => ({ name: n })),
  toolDefinitions: [],
  mcpConnections: [],
  integrationInstances: [],
  knowledgeBases: [],
  codeTools: [],
  documentTemplates: [],
};

function renderPinned(targetInstanceId: number | null): {
  modes: string[];
  instanceIds: Array<number | null>;
} {
  const noop = () => undefined;
  const modes: string[] = [];
  const instanceIds: Array<number | null> = [];
  // Stateful for the same reason the contact-auth harness is: a discarded write leaves the editor
  // deciding again on the same stale props.
  function Harness() {
    const [handoff, setHandoff] = useState({
      mode: "pinned",
      target: "team:1",
      targetInstanceId,
      instructions: "",
    });
    return (
      <ToolGrantsEditor
        agentId="1"
        refusals={{
          handoffInstructions: null,
          kanbanInstructions: null,
          attributeInstructions: null,
          labelInstructions: null,
          updateKanbanInstructions: null,
        }}
        catalog={CATALOG as never}
        // No explicit NATIVE row ⇒ every native tool is granted, handoff_to_human included, which is
        // what makes the editor fetch the account listing at all.
        grants={[]}
        onChange={noop}
        onCatalogChange={noop}
        transferWithSummary={false}
        setTransferWithSummary={noop}
        handoff={handoff}
        setHandoff={
          ((update: unknown) => {
            const next =
              typeof update === "function"
                ? (update as (h: typeof handoff) => typeof handoff)(handoff)
                : (update as typeof handoff);
            modes.push(next.mode);
            instanceIds.push(next.targetInstanceId);
            setHandoff(next);
          }) as never
        }
        kanbanInstructions=""
        setKanbanInstructions={noop}
        customAttributeInstructions=""
        setCustomAttributeInstructions={noop}
        labelInstructions=""
        protectedLabels=""
        setProtectedLabels={noop}
        setLabelInstructions={noop}
        updateKanbanTaskInstructions=""
        setUpdateKanbanTaskInstructions={noop}
        mcpTools={{}}
        setMcpTools={noop}
        mcpInstructions={{}}
        setMcpInstructions={noop}
        mcpCollapsed={{}}
        setMcpCollapsed={noop}
        integrationCollapsed={{}}
        setIntegrationCollapsed={noop}
      />
    );
  }
  render(
    <MemoryRouter>
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <Harness />
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
  return { modes, instanceIds };
}

describe("pinned handoff target, on an agent serving several accounts", () => {
  test("a target recorded in an account the agent still serves stays pinned", async () => {
    stubAgentsTeams([ACCOUNT_ONE, ACCOUNT_TWO]);
    const { modes } = renderPinned(2);
    await settle();
    expect(modes.length).toBe(0);
  });

  test("a target recorded in an account the agent no longer serves falls back", async () => {
    stubAgentsTeams([ACCOUNT_ONE, ACCOUNT_TWO]);
    const { modes } = renderPinned(9);
    await settle();
    expect(modes.includes("agent_choice")).toBe(true);
  });

  test("a legacy target with no account recorded falls back once there are several", async () => {
    stubAgentsTeams([ACCOUNT_ONE, ACCOUNT_TWO]);
    const { modes } = renderPinned(null);
    await settle();
    expect(modes.includes("agent_choice")).toBe(true);
  });

  test("a legacy target is kept while the agent serves exactly one account", async () => {
    stubAgentsTeams([ACCOUNT_TWO]);
    const { modes } = renderPinned(null);
    await settle();
    expect(modes.length).toBe(0);
  });

  test("no accounts at all is not evidence, and switches nothing", async () => {
    stubAgentsTeams([]);
    const { modes } = renderPinned(2);
    await settle();
    expect(modes.length).toBe(0);
  });

  // Keeping the target meant the mode menu stops being disabled while `pinned` is the mode in force
  // — and a menu item you can reach is an item that can be CLICKED, including on the value already
  // selected. `Dropdown` fires onChange for the current value like any other (no equality guard in
  // `onSelect`), so the handler ran with `pinnedInstanceId`, which is null wherever the picker cannot
  // offer targets. That null then failed the very check that keeps the target, and the config the
  // operator was looking at was gone: a no-op click erasing the setting it named.
  test("re-picking the mode already in force keeps the target", async () => {
    stubAgentsTeams([ACCOUNT_ONE, ACCOUNT_TWO]);
    const { modes, instanceIds } = renderPinned(2);
    await settle();
    // The handoff config is behind its card's Settings chevron, and it is the FIRST configurable
    // native card on the page (kanban and the attribute/label ones follow it).
    const gears = screen.getAllByLabelText(/^settings$|^configurações$/i);
    fireEvent.click(gears[0] as HTMLElement);
    // The label text belongs to both the FormField's <label> and the picker's own aria-label, so the
    // button is what has to be clicked, not whichever one the query happens to return first.
    const labelled = await screen.findAllByLabelText(
      /who receives the handoff|quem recebe a transferência/i,
    );
    const trigger = labelled.find((el) => el.tagName === "BUTTON");
    fireEvent.keyDown(trigger as HTMLElement, { key: "Enter" });
    // The label also appears on the closed trigger (it IS the current value), so the one to click is
    // the menu item.
    const labels = await screen.findAllByText(
      /^a specific agent or team$|^um agente ou time específico$/i,
    );
    const item = labels
      .map((el) => el.closest('[role="menuitem"]'))
      .find((el): el is HTMLElement => el !== null);
    const menuOpened = item !== undefined;
    if (item) fireEvent.click(item);
    await settle();
    // The click has to have REACHED the handler for the absence of damage to mean anything: an
    // interaction that silently did nothing would satisfy both assertions below on the broken code.
    // Radix opens its menu on keydown, not on a bare click, and the first version of this test
    // passed against the defect precisely because nothing happened.
    expect(menuOpened).toBe(true);
    expect(modes.includes("agent_choice")).toBe(false);
    expect(instanceIds.includes(null)).toBe(false);
  });
});
