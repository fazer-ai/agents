import { describe, expect, test } from "bun:test";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { FlowContext } from "@/modules/flowlog/service";
import {
  chatwootNoteSink,
  type GuardrailDecision,
  guardrailTripped,
  handedOffNote,
  REFUSED_REPLY_NOTE_MAX,
  screenedText,
} from "@/modules/guardrails/gate";
import { applyGuardrailHandoff } from "@/modules/guardrails/handoff";
import { readGuardrailsConfig } from "@/modules/guardrails/settings";
import {
  HANDOFF_DEFAULTS,
  type HandoffConfig,
  pinnedHandoffTarget,
} from "@/modules/handoff/settings";

// Issue #704: the guardrail's `handoff` action. The unit half: how it is configured, what the gate
// hands the caller, what the operator note says, and the transfer itself. The runtime and follow-up
// halves are in tests/graph/runtime.test.ts and tests/graph/nudge.test.ts.

const FLOW = {
  tenantId: 1n,
  conversationId: "1",
  threadId: "1:1:1",
  turnId: "t",
  source: "chatwoot",
} as unknown as FlowContext;

describe("configuring it", () => {
  test("the action is accepted on both directions, and the default line talks about the team", () => {
    const cfg = readGuardrailsConfig({
      guardrails: {
        input: { action: "handoff" },
        output: { action: "handoff" },
      },
    });
    expect(cfg.input.action).toBe("handoff");
    expect(cfg.output.action).toBe("handoff");
    expect(cfg.output.handoffMessage).toContain("equipe");
  });

  test("an empty line is kept empty, and only a missing one takes the default", () => {
    const cfg = readGuardrailsConfig({
      guardrails: {
        input: { action: "handoff", handoffMessage: "   " },
        output: { action: "handoff", handoffMessage: 42 },
      },
    });
    expect(cfg.input.handoffMessage).toBe("");
    expect(cfg.output.handoffMessage).toContain("equipe");
  });
});

describe("what the gate hands the caller", () => {
  test("a hand-over is a trip whose text is the line, or nothing", () => {
    const withLine: GuardrailDecision = { kind: "handed-off", reply: "LINHA" };
    const without: GuardrailDecision = { kind: "handed-off", reply: null };
    expect(guardrailTripped(withLine)).toBe(true);
    expect(screenedText(withLine, "RECUSADA")).toBe("LINHA");
    expect(screenedText(without, "RECUSADA")).toBeNull();
  });

  test("the note tells the reader the case is theirs, and quotes the refused reply on the output side only", () => {
    const out = handedOffNote("HEAD", {
      direction: "output",
      outcome: "handed-off",
      refused: "RESPOSTA-RECUSADA",
    });
    expect(out).toContain("HEAD");
    expect(out).toContain("O caso foi encaminhado para a equipe.");
    expect(out).toContain("RESPOSTA-RECUSADA");
    const inp = handedOffNote("HEAD", {
      direction: "input",
      outcome: "handed-off",
      refused: "MENSAGEM-DO-CLIENTE",
    });
    expect(inp).not.toContain("MENSAGEM-DO-CLIENTE");
    // Any other outcome is the line every trip already wrote.
    expect(
      handedOffNote("HEAD", { direction: "output", outcome: "replaced" }),
    ).toBe("HEAD");
  });

  test("a long refused reply is bounded in the note", () => {
    const note = handedOffNote("HEAD", {
      direction: "output",
      outcome: "handed-off",
      refused: "x".repeat(REFUSED_REPLY_NOTE_MAX * 2),
    });
    expect(note.length).toBeLessThan(REFUSED_REPLY_NOTE_MAX + 200);
  });

  test("the note sink posts a hand-over", async () => {
    const notes: string[] = [];
    const sink = chatwootNoteSink(
      {
        sendPrivateNote: async (_c: number, t: string) => {
          notes.push(t);
          return {};
        },
      } as unknown as ChatwootClient,
      7,
    );
    await sink({
      direction: "output",
      outcome: "handed-off",
      action: "handoff",
      refused: "RECUSADA",
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("RECUSADA");
  });
});

function client(opts: { toggleThrows?: boolean; assignThrows?: boolean }) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      toggleStatus: async (c: number, s: string) => {
        if (opts.toggleThrows) throw new Error("down");
        calls.push(`status:${c}:${s}`);
        return {};
      },
      assignToAgent: async (c: number, id: number) => {
        if (opts.assignThrows) throw new Error("nope");
        calls.push(`agent:${c}:${id}`);
        return {};
      },
      assignTeam: async (c: number, id: number) => {
        if (opts.assignThrows) throw new Error("nope");
        calls.push(`team:${c}:${id}`);
        return {};
      },
    } as unknown as ChatwootClient,
  };
}

const hc = (over: Partial<HandoffConfig>): HandoffConfig => ({
  ...HANDOFF_DEFAULTS,
  ...over,
});

describe("the transfer", () => {
  test("route mode opens the conversation and leaves the rest to Chatwoot's routing", async () => {
    const c = client({});
    const ok = await applyGuardrailHandoff({
      client: c.client,
      conversationId: 9,
      instanceId: 3n,
      handoff: hc({ mode: "route" }),
      direction: "output",
      flow: FLOW,
    });
    expect(ok).toBe(true);
    expect(c.calls).toEqual(["status:9:open"]);
  });

  test("a pinned agent or team is assigned after the status", async () => {
    const a = client({});
    await applyGuardrailHandoff({
      client: a.client,
      conversationId: 9,
      instanceId: 3n,
      handoff: hc({ mode: "pinned", targetAgentId: 11, targetTeamId: 22 }),
      direction: "output",
      flow: FLOW,
    });
    expect(a.calls).toEqual(["status:9:open", "agent:9:11"]);
    const t = client({});
    await applyGuardrailHandoff({
      client: t.client,
      conversationId: 9,
      instanceId: 3n,
      handoff: hc({ mode: "pinned", targetTeamId: 22 }),
      direction: "input",
      flow: FLOW,
    });
    expect(t.calls).toEqual(["status:9:open", "team:9:22"]);
  });

  test("a pin picked in another account is not used here", () => {
    expect(
      pinnedHandoffTarget(
        hc({ mode: "pinned", targetTeamId: 22, targetInstanceId: 4 }),
        3n,
      ),
    ).toBeNull();
    expect(
      pinnedHandoffTarget(
        hc({ mode: "pinned", targetTeamId: 22, targetInstanceId: 3 }),
        3n,
      ),
    ).toEqual({ kind: "team", id: 22 });
    expect(
      pinnedHandoffTarget(hc({ mode: "agent_choice", targetTeamId: 22 }), 3n),
    ).toBeNull();
  });

  test("a status that fails is no transfer, and nothing is assigned", async () => {
    const c = client({ toggleThrows: true });
    const ok = await applyGuardrailHandoff({
      client: c.client,
      conversationId: 9,
      instanceId: 3n,
      handoff: hc({ mode: "pinned", targetTeamId: 22 }),
      direction: "output",
      flow: FLOW,
    });
    expect(ok).toBe(false);
    expect(c.calls).toEqual([]);
  });

  test("an assignment that fails does not undo the transfer", async () => {
    const c = client({ assignThrows: true });
    const ok = await applyGuardrailHandoff({
      client: c.client,
      conversationId: 9,
      instanceId: 3n,
      handoff: hc({ mode: "pinned", targetTeamId: 22 }),
      direction: "output",
      flow: FLOW,
    });
    expect(ok).toBe(true);
    expect(c.calls).toEqual(["status:9:open"]);
  });
});
