import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  applyTurnNotes,
  rebuildPlaygroundTurns,
} from "@/modules/playground/sessions";
import type { LoadedTurnNote } from "@/modules/playground/turn-notes";

// Pure reconstruction of a checkpointer message list into display turns. No DB / no checkpointer.

describe("rebuildPlaygroundTurns", () => {
  test("rebuilds user + assistant turns in order", () => {
    const turns = rebuildPlaygroundTurns([
      new HumanMessage("oi"),
      new AIMessage("Olá!"),
      new HumanMessage("tudo bem?"),
      new AIMessage("Tudo!"),
    ]);
    expect(turns.map((x) => [x.role, x.text])).toEqual([
      ["user", "oi"],
      ["assistant", "Olá!"],
      ["user", "tudo bem?"],
      ["assistant", "Tudo!"],
    ]);
  });

  test("unwraps an audio message and flags it", () => {
    const turns = rebuildPlaygroundTurns([
      new HumanMessage("<mensagem-de-audio>quero agendar</mensagem-de-audio>"),
      new AIMessage("Claro!"),
    ]);
    expect(turns[0]).toMatchObject({
      role: "user",
      text: "quero agendar",
      audio: true,
    });
    expect(turns[1]).toMatchObject({ role: "assistant", text: "Claro!" });
  });

  test("a system nudge yields a follow-up reply; a silent one is skipped", () => {
    const turns = rebuildPlaygroundTurns([
      new HumanMessage("oi"),
      new AIMessage("Olá!"),
      new SystemMessage("nudge…"),
      new AIMessage("Ainda precisa de algo?"),
    ]);
    expect(turns).toHaveLength(3);
    expect(turns[2]).toMatchObject({
      role: "assistant",
      text: "Ainda precisa de algo?",
      followup: true,
    });

    const silent = rebuildPlaygroundTurns([
      new HumanMessage("oi"),
      new AIMessage("Olá!"),
      new SystemMessage("nudge…"),
    ]);
    expect(silent).toHaveLength(2);
  });

  test("exposes the message id of each turn (for joining persisted media)", () => {
    const turns = rebuildPlaygroundTurns([
      new HumanMessage({ content: "oi", id: "h1" }),
      new AIMessage({ content: "Olá!", id: "a1" }),
    ]);
    expect(turns[0]?.messageId).toBe("h1");
    expect(turns[1]?.messageId).toBe("a1");
  });

  test("a tool-calling turn carries its trace on the assistant turn, not the user turn", () => {
    const turns = rebuildPlaygroundTurns([
      new HumanMessage("horário?"),
      new AIMessage({
        content: "",
        tool_calls: [{ name: "search_knowledge", args: {}, id: "c1" }],
      }),
      new ToolMessage({
        content: "abre 9h",
        tool_call_id: "c1",
        name: "search_knowledge",
      }),
      new AIMessage("Abre às 9h."),
    ]);
    expect(turns[0]).toMatchObject({ role: "user", text: "horário?" });
    expect(turns[0]?.trace).toHaveLength(0);
    expect(turns[1]?.role).toBe("assistant");
    expect((turns[1]?.trace.length ?? 0) > 0).toBe(true);
  });
});

// Issue #136: the transcript and the agent's memory are two stores, and this is the fold. Tabled
// rather than exercised through a turn, because placement is the decision and a DB-backed test
// would only prove the wiring.
describe("applyTurnNotes", () => {
  const note = (over: Partial<LoadedTurnNote> = {}): LoadedTurnNote => ({
    messageId: null,
    anchorMessageId: null,
    userMessageId: null,
    userText: null,
    reply: "",
    guardrails: [],
    createdAt: new Date(),
    ...over,
  });
  const turn = (
    role: "user" | "assistant",
    text: string,
    messageId?: string,
  ) => ({
    role,
    text,
    ...(messageId ? { messageId } : {}),
    trace: [],
    sources: [],
  });
  const shape = (ts: ReturnType<typeof applyTurnNotes>) =>
    ts.map((t) => `${t.role}:${t.text}`);

  test("no notes leaves the turns untouched", () => {
    const ts = [turn("user", "oi"), turn("assistant", "olá", "a1")];
    expect(applyTurnNotes(ts, [])).toEqual(ts);
  });

  test("a note with a message id replaces that reply and carries its verdict", () => {
    const out = applyTurnNotes(
      [turn("user", "oi"), turn("assistant", "cru", "a1")],
      [
        note({
          messageId: "a1",
          reply: "TEMPLATE",
          guardrails: [
            { type: "guardrail", direction: "output", outcome: "replaced" },
          ],
        }),
      ],
    );
    expect(shape(out)).toEqual(["user:oi", "assistant:TEMPLATE"]);
    expect(out[1]?.trace).toHaveLength(1);
  });

  // The blocked turn is not in the thread at all, so placement is the whole job.
  test("a thread-less note lands right after its anchor", () => {
    const out = applyTurnNotes(
      [
        turn("user", "primeira"),
        turn("assistant", "resposta", "a1"),
        turn("user", "segunda"),
        turn("assistant", "outra", "a2"),
      ],
      [note({ anchorMessageId: "a1", userText: "bloqueada", reply: "T" })],
    );
    expect(shape(out)).toEqual([
      "user:primeira",
      "assistant:resposta",
      "user:bloqueada",
      "assistant:T",
      "user:segunda",
      "assistant:outra",
    ]);
  });

  test("a null anchor means the thread was empty, so it goes first", () => {
    const out = applyTurnNotes(
      [turn("user", "depois"), turn("assistant", "r", "a1")],
      [note({ anchorMessageId: null, userText: "bloqueada", reply: "T" })],
    );
    expect(shape(out).slice(0, 2)).toEqual(["user:bloqueada", "assistant:T"]);
  });

  // Losing the turn entirely is the failure this exists to prevent, so an anchor that no longer
  // resolves still renders rather than being dropped.
  // The blocked turn goes through the SAME renderer as every other one, so the audio marker is
  // unwrapped and the media id survives. Built by hand, it rendered "<mensagem-de-audio>…" as plain
  // user text and had nothing for the recording to hang off.
  test("a blocked audio turn is unwrapped and keeps its message id", () => {
    const out = applyTurnNotes(
      [],
      [
        note({
          anchorMessageId: null,
          userMessageId: "h1",
          userText: "<mensagem-de-audio>bom dia</mensagem-de-audio>",
          reply: "T",
        }),
      ],
    );
    expect(out[0]).toMatchObject({
      role: "user",
      text: "bom dia",
      audio: true,
      messageId: "h1",
    });
    expect(out[0]?.text).not.toContain("mensagem-de-audio");
  });

  // Direction is position: the input screening ran before the graph and the output one after.
  test("an input verdict is restored ahead of the graph's own entries", () => {
    const withTrace = {
      ...turn("assistant", "cru", "a1"),
      trace: [
        { type: "tool_call" as const, id: "c1", name: "calculator", args: {} },
      ],
    };
    const out = applyTurnNotes(
      [turn("user", "oi"), withTrace],
      [
        note({
          messageId: "a1",
          reply: "T",
          guardrails: [
            { type: "guardrail", direction: "input", outcome: "clean" },
            { type: "guardrail", direction: "output", outcome: "replaced" },
          ],
        }),
      ],
    );
    expect(out[1]?.trace.map((e) => e.type)).toEqual([
      "guardrail",
      "tool_call",
      "guardrail",
    ]);
  });

  // "Nothing was sent" and "the agent chose silence" are different statements, and the reload has
  // to keep them apart the way the live turn does.
  test("a suppressed follow-up is flagged so the reload can say why", () => {
    const out = applyTurnNotes(
      [{ ...turn("assistant", "escrita", "a1"), followup: true }],
      [
        note({
          messageId: "a1",
          reply: "",
          guardrails: [
            { type: "guardrail", direction: "output", outcome: "suppressed" },
          ],
        }),
      ],
    );
    expect(out[0]?.suppressed).toBe(true);
  });

  // A `silent` input action leaves no reply, and the renderer drops an empty AI message by design.
  // Without a turn to carry it the verdict lands on the user turn, whose trace the client discards,
  // so the operator gets a bare message and no sign that anything blocked it.
  test("a blocked turn with no reply still leaves a visible, explained turn", () => {
    const out = applyTurnNotes(
      [],
      [
        note({
          anchorMessageId: null,
          userText: "fale do concorrente",
          reply: "",
          guardrails: [
            { type: "guardrail", direction: "input", outcome: "suppressed" },
          ],
        }),
      ],
    );
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: "assistant", suppressed: true });
    expect(out[1]?.trace).toHaveLength(1);
  });

  // The agent answering with nothing is what makes an override's own message id unusable: the
  // rebuild drops an empty AI message, so the note keyed to it matched no turn and the verdict
  // vanished on reload. Same question the anchor asks ("does the transcript still show this id?"),
  // asked at the other end, which is why both go through one placement now.
  test("a note whose reply the rebuild dropped renders after the message it judged", () => {
    const out = applyTurnNotes(
      [
        turn("user", "primeira", "h1"),
        turn("user", "segunda", "h2"),
        turn("assistant", "resposta", "a2"),
      ],
      [
        note({
          messageId: "a1",
          userMessageId: "h1",
          reply: "",
          guardrails: [
            {
              type: "guardrail",
              direction: "input",
              outcome: "unavailable",
            },
          ],
        }),
      ],
    );
    expect(shape(out)).toEqual([
      "user:primeira",
      "assistant:",
      "user:segunda",
      "assistant:resposta",
    ]);
    expect(out[1]?.trace).toEqual([
      { type: "guardrail", direction: "input", outcome: "unavailable" },
    ]);
    // The agent said nothing; the guardrail did not take anything away. Reading suppression off the
    // empty text rather than off the verdict would report a moderation that never happened.
    expect(out[1]?.suppressed).toBeUndefined();
  });

  test("...and reports suppression when that is what the verdict says", () => {
    const out = applyTurnNotes(
      [turn("user", "oi", "h1")],
      [
        note({
          messageId: "a1",
          userMessageId: "h1",
          reply: "",
          guardrails: [
            {
              type: "guardrail",
              direction: "output",
              outcome: "suppressed",
            },
          ],
        }),
      ],
    );
    expect(out[1]).toMatchObject({ role: "assistant", suppressed: true });
  });

  test("a dropped reply with no user message to follow lands at the end", () => {
    const out = applyTurnNotes(
      [turn("user", "oi", "h1"), turn("assistant", "r", "a1")],
      [note({ messageId: "gone", userMessageId: null, reply: "T" })],
    );
    expect(shape(out)).toEqual(["user:oi", "assistant:r", "assistant:T"]);
  });

  test("an unresolvable anchor still renders, at the end", () => {
    const out = applyTurnNotes(
      [turn("user", "oi"), turn("assistant", "r", "a1")],
      [note({ anchorMessageId: "gone", userText: "bloqueada", reply: "T" })],
    );
    expect(shape(out)).toEqual([
      "user:oi",
      "assistant:r",
      "user:bloqueada",
      "assistant:T",
    ]);
  });
});
