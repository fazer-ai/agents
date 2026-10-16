/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, useEffect } from "react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components/Toast";
import { AuthProvider } from "@/client/contexts/AuthContext";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import {
  guardrailTraceLabel,
  PlaygroundChat,
} from "@/client/pages/agents/PlaygroundChat";
import {
  agentTurn,
  NO_USAGE,
  type PlaygroundTurn,
  usePlaygroundChat,
} from "@/client/pages/agents/usePlaygroundChat";
import { withI18n } from "../utils/i18n";

// Five paths in the hook produce an agent turn (text, file, voice note, follow-up, and the reload
// that rebuilds them from the server). What a suppressed turn looks like is decided in one function,
// so a guardrail that empties a reply reads the same live and after a reload; this is its table.

const t = (_key: string, fallback: string) => fallback;

const base = { trace: [], sources: [] } as unknown as Parameters<
  typeof agentTurn
>[1];

const role = (turn: PlaygroundTurn) => turn.role;

describe("agentTurn", () => {
  test("a suppressed turn is a note carrying the verdict, never an empty bubble", () => {
    const trace = [
      { type: "guardrail", direction: "output", outcome: "suppressed" },
    ] as unknown as Parameters<typeof agentTurn>[1]["trace"];
    const turn = agentTurn(t, { ...base, text: "", suppressed: true, trace });
    expect(role(turn)).toBe("note");
    expect(turn.text).toBe(
      "Nothing would be sent: the guardrail acted on this turn.",
    );
    // The verdict is the whole point of the note: a note without it says nothing happened.
    expect(turn.role === "note" && turn.trace).toBe(trace);
  });

  // NOTE: a hand-over with nothing to say to the customer empties the reply too, and it must not read
  // as a suppression. It says where the case went, from the verdict a reload restores.
  test("an empty hand-over is a note saying the case would go to the team", () => {
    const trace = [
      { type: "guardrail", direction: "output", outcome: "handed-off" },
    ] as unknown as Parameters<typeof agentTurn>[1]["trace"];
    const turn = agentTurn(t, { ...base, text: "", suppressed: true, trace });
    expect(role(turn)).toBe("note");
    expect(turn.text).toBe(
      "Nothing would be sent to the customer: the guardrail would hand the case to the team.",
    );
    expect(
      guardrailTraceLabel(t, {
        direction: "output",
        outcome: "handed-off",
        action: "handoff",
      }),
    ).toBe("blocked, the case would go to the team");
  });

  // The bug it catches: a held turn labelled as a policy block, hiding that no check answered.
  test("a held screening says the check could not run", () => {
    expect(
      guardrailTraceLabel(t, {
        direction: "output",
        outcome: "handed-off",
        held: true,
      }),
    ).toBe(
      "could not be checked, so the reply was held and the case would go to the team",
    );
  });

  test("suppression outranks silence, so a blocked follow-up reads as blocked", () => {
    const turn = agentTurn(t, {
      ...base,
      text: "",
      suppressed: true,
      silent: true,
      followup: true,
    });
    expect(turn.text).toBe(
      "Nothing would be sent: the guardrail acted on this turn.",
    );
  });

  test("a silent follow-up is the agent's own choice, and carries no verdict", () => {
    const turn = agentTurn(t, {
      ...base,
      text: "",
      silent: true,
      followup: true,
    });
    expect(role(turn)).toBe("note");
    expect(turn.text).toBe("Follow-up: the agent chose not to send anything.");
    expect(turn.role === "note" && turn.trace).toBeUndefined();
  });

  test("an ordinary reply is a bubble, with its audio and its follow-up flag", () => {
    const turn = agentTurn(t, {
      ...base,
      text: "Claro!",
      followup: true,
      audioUrl: "blob:tts",
    });
    expect(role(turn)).toBe("assistant");
    expect(turn.text).toBe("Claro!");
    expect(turn.role === "assistant" && turn.followup).toBe(true);
    expect(turn.role === "assistant" && turn.audioUrl).toBe("blob:tts");
  });

  // The placeholder is for a reply the agent genuinely had nothing to put in, which is a different
  // statement from "the guardrail removed it" — the distinction the note above exists to keep.
  test("an empty reply nobody suppressed still reads as the agent's own silence", () => {
    const turn = agentTurn(t, { ...base, text: "" });
    expect(role(turn)).toBe("assistant");
    expect(turn.text).toBe("(no reply)");
  });

  test("a turn with no audio declares no audio, rather than an undefined url", () => {
    const turn = agentTurn(t, { ...base, text: "oi" });
    expect("audioUrl" in turn).toBe(false);
    expect("followup" in turn).toBe(false);
  });
});

// The table above proves the FUNCTION. The hook is asked the rest: every path that receives a reply
// (text, follow-up, file, voice note, and the reload of a saved session) is fed the same answers, and
// each turn it appends reads as the function says it should.
const SUPPRESSED_TRACE = [
  { type: "guardrail", direction: "output", outcome: "suppressed" },
];
const SUPPRESSED = "Nothing would be sent: the guardrail acted on this turn.";

// The server's answer to every reply endpoint, and to the reload of the thread.
type Answer = { reply: string; suppressed: boolean; silent?: boolean };

function stubPlayground(answer: () => Answer) {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      "http://localhost",
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname.replace("/api/v1/agents/41/playground", "");
    const a = answer();
    const turn = {
      threadId: "th1",
      reply: a.reply,
      suppressed: a.suppressed,
      silent: a.silent ?? false,
      closesOnly: false,
      trace: a.suppressed ? SUPPRESSED_TRACE : [],
      sources: [],
      usage: NO_USAGE,
      timing: null,
    };
    if (method === "POST" && path === "/threads")
      return json({ threadId: "th1" });
    if (method === "POST" && path === "/audio/transcribe") {
      return json({ transcription: "oi" });
    }
    if (method === "POST" && path === "/file/extract") {
      return json({
        threadId: "th1",
        kind: "document",
        extracted: "texto",
        usage: NO_USAGE,
        timing: null,
        turnId: "r1",
      });
    }
    if (
      method === "POST" &&
      ["", "/followup", "/file", "/audio"].includes(path)
    ) {
      return json(turn);
    }
    if (method === "GET" && path === "/sessions/th1") {
      return json({
        usage: NO_USAGE,
        turns: [
          { role: "user", text: "oi" },
          {
            role: "assistant",
            text: a.reply,
            suppressed: a.suppressed,
            followup: false,
            trace: turn.trace,
            sources: [],
          },
        ],
      });
    }
    if (method === "GET" && path === "/sessions") return json({ sessions: [] });
    return json({});
  }) as unknown as typeof fetch;
}

// A microphone that records one chunk and stops when told.
class FakeRecorder {
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voz"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

const realFetch = globalThis.fetch;
const realRecorder = globalThis.MediaRecorder;
const realMedia = navigator.mediaDevices;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  globalThis.MediaRecorder = realRecorder;
  Object.defineProperty(navigator, "mediaDevices", {
    value: realMedia,
    configurable: true,
  });
});

type Chat = ReturnType<typeof usePlaygroundChat>;
const PATHS: Record<string, (chat: () => Chat) => Promise<void>> = {
  text: async (chat) => {
    act(() => chat().setInput("oi"));
    await act(() => chat().send());
  },
  followup: async (chat) => {
    // A follow-up needs a conversation to follow: one text turn first.
    act(() => chat().setInput("oi"));
    await act(() => chat().send());
    await act(() => chat().simulateFollowup());
  },
  file: async (chat) => {
    await act(() =>
      chat().sendFile(
        new File(["pdf"], "doc.pdf", { type: "application/pdf" }),
      ),
    );
  },
  voice: async (chat) => {
    globalThis.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder;
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: async () => ({ getTracks: () => [] }),
      },
      configurable: true,
    });
    await act(() => chat().startRecording());
    await act(async () => chat().stopRecording());
  },
  reload: async (chat) => {
    await act(() => chat().loadSession("th1"));
  },
};

async function lastTurn(path: string, answer: Answer) {
  stubPlayground(() => answer);
  const { result } = renderHook(() => usePlaygroundChat("41", false), {
    wrapper: ({ children }) => withI18n(children),
  });
  const chat = () => result.current;
  await (PATHS[path] as (c: () => Chat) => Promise<void>)(chat);
  await waitFor(() => {
    const last = chat().turns.at(-1);
    if (!last || last.role === "user") throw new Error("no reply yet");
  });
  const last = chat().turns.at(-1) as { role: string; text: string };
  return { role: last.role, text: last.text };
}

describe("agentTurn is the only place an agent turn is built", () => {
  for (const path of Object.keys(PATHS)) {
    test(`${path}: a suppressed turn is the guardrail's note, not an empty bubble`, async () => {
      expect(await lastTurn(path, { reply: "", suppressed: true })).toEqual({
        role: "note",
        text: SUPPRESSED,
      });
    });

    test(`${path}: an empty reply nobody suppressed reads as the agent's own silence`, async () => {
      expect(await lastTurn(path, { reply: "", suppressed: false })).toEqual({
        role: "assistant",
        text: "(no reply)",
      });
    });
  }

  test("followup: a silent follow-up says the agent chose not to send", async () => {
    expect(
      await lastTurn("followup", {
        reply: "",
        suppressed: false,
        silent: true,
      }),
    ).toEqual({
      role: "note",
      text: "Follow-up: the agent chose not to send anything.",
    });
  });
});

// Two independent fields (direction and action) decide the sentence, so a nested ternary that
// answers one of them with a constant tells the operator "the configured reply" on text the judge
// itself wrote.
describe("guardrailTraceLabel", () => {
  const t = (_k: string, fallback: string) => fallback;

  const rows: {
    name: string;
    entry: Parameters<typeof guardrailTraceLabel>[1];
    says: string;
  }[] = [
    {
      name: "approved",
      entry: { direction: "output", outcome: "clean" },
      says: "approved",
    },
    {
      name: "unscreened input",
      entry: { direction: "input", outcome: "unavailable" },
      says: "the message reached the agent unchecked",
    },
    {
      name: "unscreened output",
      entry: { direction: "output", outcome: "unavailable" },
      says: "the reply went out unscreened",
    },
    {
      name: "suppressed",
      entry: { direction: "output", outcome: "suppressed", action: "silent" },
      says: "nothing would be sent",
    },
    {
      name: "replaced by the template",
      entry: { direction: "output", outcome: "replaced", action: "template" },
      says: "the configured reply",
    },
    {
      name: "replaced by text the judge wrote",
      entry: { direction: "output", outcome: "replaced", action: "generated" },
      says: "a reply the guardrail wrote",
    },
    // `action` is absent on a report that predates it being recorded. The configured reply is the
    // safe half of the pair: it describes what an operator can go and read.
    {
      name: "replaced with no action recorded",
      entry: { direction: "output", outcome: "replaced" },
      says: "the configured reply",
    },
  ];

  for (const row of rows) {
    test(row.name, () => {
      expect(guardrailTraceLabel(t, row.entry)).toContain(row.says);
    });
  }

  // The template arm and the generated arm are DIFFERENT sentences. Asserting `toContain` on each
  // separately would still pass if both returned the generated one.
  test("the two replacement sentences are not the same sentence", () => {
    const template = guardrailTraceLabel(t, {
      direction: "output",
      outcome: "replaced",
      action: "template",
    });
    const generated = guardrailTraceLabel(t, {
      direction: "output",
      outcome: "replaced",
      action: "generated",
    });
    expect(template).not.toBe(generated);
  });

  // The row the operator reads is the function's sentence, verdict by verdict: a reopened session
  // whose turn the guardrail emptied, drawn by the real playground.
  test("the row does not write any of these sentences itself", async () => {
    const verdicts = rows.map((r) => ({ type: "guardrail", ...r.entry }));
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://localhost").pathname;
      const body =
        path === "/api/v1/agents/41/playground/sessions/th1"
          ? {
              usage: NO_USAGE,
              turns: [
                { role: "user", text: "oi" },
                {
                  role: "assistant",
                  text: "",
                  suppressed: true,
                  followup: false,
                  trace: verdicts,
                  sources: [],
                },
              ],
            }
          : path === "/api/auth/me"
            ? { user: { id: "1", email: "a@b.c", role: "ADMIN" } }
            : { sessions: [] };
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    function Reopened() {
      const chat = usePlaygroundChat("41", false);
      // biome-ignore lint/correctness/useExhaustiveDependencies: reopened once, on mount
      useEffect(() => {
        void chat.loadSession("th1");
      }, []);
      return createElement(PlaygroundChat, {
        chat,
        agentId: "41",
        missingConfig: [],
        capabilities: {
          audioInput: false,
          audioReply: false,
          fileInput: false,
          guardrails: true,
        },
        toolsDirty: false,
        showSidebar: false,
      });
    }
    render(
      withI18n(
        createElement(
          MemoryRouter,
          null,
          createElement(
            ThemeProvider,
            null,
            createElement(
              AuthProvider,
              null,
              createElement(
                ToastProvider,
                null,
                createElement(
                  TooltipPrimitive.Provider,
                  null,
                  createElement(Reopened),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await screen.findAllByText(/^Guardrail on the/);
    const shown = [
      ...document.querySelectorAll("span.font-normal.text-text-muted"),
    ].map((el) => el.textContent);
    expect(shown).toEqual(
      verdicts.map((v) =>
        guardrailTraceLabel(t, v as Parameters<typeof guardrailTraceLabel>[1]),
      ),
    );
  });
});
