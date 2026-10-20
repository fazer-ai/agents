import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { contentToText } from "@/graph/message-text";
import {
  customerFacingReply,
  FOLLOWUP_SKIP_SENTINEL,
  followupSilenceChannel,
  inertToolsFor,
  isNudgeSilent,
  proactiveReply,
  SKIP_REPLY_ACK,
  SKIP_REPLY_MARK,
  SKIP_REPLY_TOOL,
  silenceWasChosen,
  skipReplyRan,
  withFollowupSilenceChannel,
  withoutLoneSilenceTool,
} from "@/graph/silence";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { buildNativeTools } from "@/graph/tools/native";
import { dropDuplicateToolNames } from "@/graph/tools/unique-names";
import { unmetPreconditionMessage } from "@/modules/agents/tool-preconditions";

const S = FOLLOWUP_SKIP_SENTINEL;

// Two policies, one strip, and the table is what keeps them from drifting back together. Each row is
// (what the model wrote) → (silent?, what the person gets).
describe("customerFacingReply — the REACTIVE rule", () => {
  const rows: Array<[string, string, boolean, string]> = [
    ["the bare sentinel", S, true, ""],
    ["the sentinel with whitespace", `\n  ${S}  \n`, true, ""],
    ["the sentinel twice", `${S}${S}`, true, ""],
    ["the sentinel twice, spaced", `${S} ${S}`, true, ""],
    // NOTE: The token in a costume: strip it and only quotes are left.
    ["the sentinel in quotes", `"${S}"`, true, ""],
    ["the sentinel in backticks", `\`${S}\``, true, ""],
    ["quotes around repeated sentinels", `"${S}${S}"`, true, ""],
    // ...and the other direction: quotes on a REAL reply are content and survive untouched.
    ["a quoted real reply", `"Olá!"`, false, `"Olá!"`],
    // NOTE: Quotes are tolerated only when the token was actually there: a customer asking
    // what an empty string literal looks like gets `""` back, and that is an answer.
    ["a reply that IS two quote characters", `""`, false, `""`],
    ["a reply that is a quoted empty string", `"''"`, false, `"''"`],
    ["nothing at all", "", true, ""],
    ["only whitespace", "   \n ", true, ""],
    [
      "a real reply",
      "Olá! Como posso ajudar?",
      false,
      "Olá! Como posso ajudar?",
    ],
    // NOTE: The token inside a REAL answer is left alone: editing a substring out of a
    // customer-facing reply is the silent data loss docs/graph.md rejects, and only a legacy
    // transcript can still put it here. Reported, never mutated (see `carriesToken`).
    ["a real reply carrying the token", `${S} Claro.`, false, `${S} Claro.`],
    ["a real reply ending in the token", `Claro. ${S}`, false, `Claro. ${S}`],
    [
      "the token twice inside a reply",
      `${S}Bom${S} dia`,
      false,
      `${S}Bom${S} dia`,
    ],
    // NOTE: The heuristics below belong to the proactive path ONLY. Here a customer is waiting, and these
    // are ordinary short answers, and swallowing one is its own defect.
    ["a bare SKIP", "SKIP", false, "SKIP"],
    [
      "narrated emptiness (en)",
      "(empty — nothing to do yet)",
      false,
      "(empty — nothing to do yet)",
    ],
    ["a parenthetical answer (pt-BR)", "(nada consta)", false, "(nada consta)"],
    ["a parenthetical answer about rates", "(sem juros)", false, "(sem juros)"],
  ];
  for (const [name, raw, silent, text] of rows) {
    test(name, () => {
      const out = customerFacingReply(raw);
      expect(out.silent).toBe(silent);
      expect(out.text).toBe(text);
      // NOTE: The contract the repeated-sentinel case must hold: emptiness and silence are one
      // decision, so a caller can never see silent=false with nothing to send.
      expect(out.silent).toBe(out.text.length === 0);
      // NOTE: ...and the one thing the rules erase on purpose: EVERY kind of silence comes out as `text:
      // ""`, so a caller asking "is there anything in the thread nobody received" needs the raw
      // answer kept separately. It is about the model's words, never about ours.
      expect(out.wroteText).toBe(raw.trim().length > 0);
    });
  }

  // `bySentinel` is what lets a caller tell "the model wrote the token" from "the model wrote
  // nothing", which is the difference between silence worth a line and an ordinary empty turn.
  // A token that survives into a delivered reply is REPORTED, which is what makes not-editing-it
  // honest rather than a leak nobody hears about.
  test("a token riding along in a real reply is flagged, not removed", () => {
    const out = customerFacingReply(`${S} Claro.`);
    expect(out.carriesToken).toBe(true);
    expect(out.silent).toBe(false);
    expect(out.text).toBe(`${S} Claro.`);
    // Silence is not "carrying": there is no reply left to carry anything.
    expect(customerFacingReply(S).carriesToken).toBe(false);
    expect(customerFacingReply("Olá").carriesToken).toBe(false);
  });

  // The pair `wroteText` exists for, spelled out: both are silence, and only one left words behind.
  test("a turn that wrote the token is not a turn that wrote nothing", () => {
    expect(customerFacingReply(S)).toMatchObject({
      silent: true,
      wroteText: true,
    });
    expect(customerFacingReply("")).toMatchObject({
      silent: true,
      wroteText: false,
    });
    expect(proactiveReply(S)).toMatchObject({ silent: true, wroteText: true });
    expect(proactiveReply("(vazio)")).toMatchObject({
      silent: true,
      wroteText: true,
    });
    expect(proactiveReply("  \n ")).toMatchObject({
      silent: true,
      wroteText: false,
    });
  });

  test("silence by token is distinguishable from an empty answer", () => {
    expect(customerFacingReply(S).bySentinel).toBe(true);
    expect(customerFacingReply(`${S}${S}`).bySentinel).toBe(true);
    expect(customerFacingReply(`"${S}"`).bySentinel).toBe(true);
    expect(customerFacingReply("").bySentinel).toBe(false);
    expect(customerFacingReply("   ").bySentinel).toBe(false);
    expect(customerFacingReply("Olá").bySentinel).toBe(false);
  });
});

describe("proactiveReply — the follow-up rule", () => {
  // Everything the reactive rule says, plus the prose heuristics, because THIS prompt asked the
  // model to produce nothing and models answer that in words.
  const silentRows = [
    S,
    `"${S}"`,
    `${S}${S}`,
    "SKIP",
    "skip",
    "(empty — nothing to do yet)",
    "(vazio: nada a fazer)",
    "",
  ];
  for (const raw of silentRows) {
    test(`silent: ${JSON.stringify(raw)}`, () => {
      const out = proactiveReply(raw);
      expect(out.silent).toBe(true);
      expect(out.text).toBe("");
    });
  }

  // The two rules diverge on a stray token too, and deliberately: this is the path that ASKED for
  // it, so an occurrence here is an artifact of our own instruction rather than a customer's words.
  test("a real follow-up loses a stray token, unlike a reactive reply", () => {
    const out = proactiveReply(`Oi! Vi que seu pagamento venceu. ${S}`);
    expect(out.silent).toBe(false);
    expect(out.text).toBe("Oi! Vi que seu pagamento venceu.");
    expect(out.carriesToken).toBe(false);
    // The reactive rule leaves the same input alone and reports it instead.
    const reactive = customerFacingReply(
      `Oi! Vi que seu pagamento venceu. ${S}`,
    );
    expect(reactive.text).toBe(`Oi! Vi que seu pagamento venceu. ${S}`);
    expect(reactive.carriesToken).toBe(true);
  });

  // The two rules DIVERGE here, and that divergence is the point: the same string is silence for a
  // follow-up nobody asked for and a real answer to a customer who is waiting.
  test("the prose heuristics are proactive-only", () => {
    for (const raw of ["SKIP", "(nada consta)", "(sem juros)"]) {
      expect(proactiveReply(raw).silent).toBe(true);
      expect(customerFacingReply(raw).silent).toBe(false);
    }
  });

  test("isNudgeSilent still answers for the proactive path", () => {
    expect(isNudgeSilent(S)).toBe(true);
    expect(isNudgeSilent("Oi! Vi que seu pagamento venceu.")).toBe(false);
  });
});

describe("followupSilenceChannel — what the directive may ASK for", () => {
  const tool = (name: string) => ({ name });

  test("the native one is bound and really there", () => {
    expect(
      followupSilenceChannel({ nativeToolsAllow: undefined }, [
        tool(SKIP_REPLY_TOOL),
      ]),
    ).toBe("tool");
    expect(
      followupSilenceChannel({ nativeToolsAllow: [SKIP_REPLY_TOOL] }, [
        tool(SKIP_REPLY_TOOL),
        tool("private_note"),
      ]),
    ).toBe("tool");
  });

  // NOTE: A grant is not an assembled tool: `withFollowupSilenceChannel` grants generously (it
  // cannot know the MCP server behind the only other source is down), so a turn can be granted the
  // channel and reach the model with nothing bound. The directive must not name it then.
  test("granted but not assembled is the sentinel", () => {
    expect(followupSilenceChannel({ nativeToolsAllow: undefined }, [])).toBe(
      "sentinel",
    );
    expect(
      followupSilenceChannel({ nativeToolsAllow: [SKIP_REPLY_TOOL] }, [
        tool("cep"),
      ]),
    ).toBe("sentinel");
  });

  // The other direction, and the one a name-only check gets wrong: with natives revoked, a custom
  // HTTP tool may legitimately carry this name and really call something. Asking the model to call
  // it to stay quiet fires a side effect on every silent follow-up.
  test("assembled under a REVOKED native is somebody else's tool", () => {
    expect(
      followupSilenceChannel({ nativeToolsAllow: [] }, [tool(SKIP_REPLY_TOOL)]),
    ).toBe("sentinel");
    expect(
      followupSilenceChannel({ nativeToolsAllow: ["private_note"] }, [
        tool(SKIP_REPLY_TOOL),
      ]),
    ).toBe("sentinel");
  });

  // The pair is one obligation: what the grant produces is what the renderer must be able to ask
  // for. Answered against the transform rather than restated, so the two cannot drift apart.
  test("what the grant leaves is what the channel answers", () => {
    const granted = withFollowupSilenceChannel({
      nativeToolsAllow: [],
      httpToolDefs: [{ name: "cep" }],
    });
    expect(
      followupSilenceChannel(granted, [tool(SKIP_REPLY_TOOL), tool("cep")]),
    ).toBe("tool");
    const toolless = withFollowupSilenceChannel({ nativeToolsAllow: [] });
    expect(followupSilenceChannel(toolless, [])).toBe("sentinel");
  });
});

describe("withoutLoneSilenceTool — our tool is never the only one", () => {
  const t = (name: string) => ({ name });
  // Ours is bound: the grant left `skip_reply` in the allowlist, so the native wins the name.
  const OURS = { nativeToolsAllow: [SKIP_REPLY_TOOL] };

  // NOTE: A source that is configured and yields nothing (an MCP server that is down) would leave
  // the grant handing a lone function schema to an endpoint running tool-less on the sentinel, and
  // the whole follow-up fails at the provider. Only the assembled list can tell the two apart.
  test("a toolset that is nothing but the channel is a tool-less agent", () => {
    expect(withoutLoneSilenceTool(OURS, [t(SKIP_REPLY_TOOL)])).toEqual([]);
    // An undefined allowlist means every native is granted, so the name is ours there too.
    expect(
      withoutLoneSilenceTool({ nativeToolsAllow: undefined }, [
        t(SKIP_REPLY_TOOL),
      ]),
    ).toEqual([]);
  });

  test("anything else beside it, and it stays", () => {
    expect(
      withoutLoneSilenceTool(OURS, [t(SKIP_REPLY_TOOL), t("cep")]).map(
        (x) => x.name,
      ),
    ).toEqual([SKIP_REPLY_TOOL, "cep"]);
    expect(
      withoutLoneSilenceTool(OURS, [t("cep"), t(SKIP_REPLY_TOOL)]).map(
        (x) => x.name,
      ),
    ).toEqual(["cep", SKIP_REPLY_TOOL]);
  });

  test("a lone tool under another name is not ours to remove", () => {
    expect(withoutLoneSilenceTool(OURS, [t("cep")]).map((x) => x.name)).toEqual(
      ["cep"],
    );
  });

  // NOTE: A NAME is not an identity. With natives revoked the lone tool under that name is the
  // operator's own HTTP tool (the grant refuses to install over it for that reason), and removing it
  // would delete their only tool from every follow-up because it is spelled like ours.
  test("a lone tool that is theirs under OUR name is not ours to remove", () => {
    expect(
      withoutLoneSilenceTool({ nativeToolsAllow: [] }, [
        t(SKIP_REPLY_TOOL),
      ]).map((x) => x.name),
    ).toEqual([SKIP_REPLY_TOOL]);
    expect(
      withoutLoneSilenceTool({ nativeToolsAllow: ["private_note"] }, [
        t(SKIP_REPLY_TOOL),
      ]).map((x) => x.name),
    ).toEqual([SKIP_REPLY_TOOL]);
  });

  test("an empty toolset stays empty", () => {
    expect(withoutLoneSilenceTool(OURS, [])).toEqual([]);
  });

  // The pair, again as one obligation: what the drop leaves is what the directive may ask for.
  test("what the drop leaves is what the channel answers", () => {
    const granted = withFollowupSilenceChannel({
      nativeToolsAllow: [] as string[],
    });
    const built = withoutLoneSilenceTool(granted, [{ name: SKIP_REPLY_TOOL }]);
    expect(followupSilenceChannel(granted, built)).toBe("sentinel");
    const withOther = withoutLoneSilenceTool(granted, [
      { name: SKIP_REPLY_TOOL },
      { name: "cep" },
    ]);
    expect(followupSilenceChannel(granted, withOther)).toBe("tool");
    // ...and the agent whose own tool holds the name reaches the same answer by the other
    // road: the grant fires, so the tool left under this name is OURS, and when it is the whole
    // toolset the drop takes it out, so the directive falls back to the sentinel.
    const theirs = withFollowupSilenceChannel({
      nativeToolsAllow: [] as string[],
      httpToolDefs: [{ name: SKIP_REPLY_TOOL }],
    });
    const kept = withoutLoneSilenceTool(theirs, [{ name: SKIP_REPLY_TOOL }]);
    expect(kept).toHaveLength(0);
    expect(followupSilenceChannel(theirs, kept)).toBe("sentinel");
    // And with anything else beside it the channel is real: same agent, one ordinary tool more.
    const alongside = withoutLoneSilenceTool(theirs, [
      { name: SKIP_REPLY_TOOL },
      { name: "cep" },
    ]);
    expect(followupSilenceChannel(theirs, alongside)).toBe("tool");
  });
});

describe("skipReplyRan — the MARK is the identity, not the name and not the text", () => {
  const msg = (name: string, content: string, marked = false): ToolMessage =>
    new ToolMessage({
      content,
      tool_call_id: "c1",
      name,
      ...(marked ? { additional_kwargs: { [SKIP_REPLY_MARK]: true } } : {}),
    });

  test("our no-op reporting that it ran", () => {
    expect(
      skipReplyRan(msg(SKIP_REPLY_TOOL, `${SKIP_REPLY_ACK}. x`, true)),
    ).toBe(true);
  });

  // NOTE: The ack is published in this repo, and with natives revoked an operator may bind a custom
  // HTTP tool under this name whose response body they do not control (a third-party API, or the
  // customer's own words echoed back). Read as identity, a body that begins with the ack ends the
  // turn without answering: a denial of the customer's reply, reachable by injection.
  test("a response body that merely SAYS the ack is not the tool", () => {
    expect(skipReplyRan(msg(SKIP_REPLY_TOOL, `${SKIP_REPLY_ACK}. x`))).toBe(
      false,
    );
  });

  // NOTE: Why the name is insufficient: `skip_reply` is a native name, so `isGuardableToolName`
  // accepts a precondition on it; unmet, the wrapper returns a NORMAL tool result under the same
  // name telling the model to carry on. Read by name that is silence, and the customer is left
  // waiting. Unmarked, so it is not the tool either.
  test("a precondition refusal wearing the same name is NOT silence", () => {
    const refusal = unmetPreconditionMessage(SKIP_REPLY_TOOL, [
      {
        kind: "attribute",
        scope: "conversation",
        key: "cpf",
      },
    ]);
    expect(refusal).toContain(SKIP_REPLY_TOOL);
    expect(skipReplyRan(msg(SKIP_REPLY_TOOL, refusal))).toBe(false);
  });

  test("another tool's result is not silence, marked or not", () => {
    expect(skipReplyRan(msg("private_note", `${SKIP_REPLY_ACK}.`, true))).toBe(
      false,
    );
  });

  test("an AI message that CALLED it is not a result", () => {
    const ai = new AIMessage({
      content: "",
      tool_calls: [
        { id: "c1", name: SKIP_REPLY_TOOL, args: { reason: "acknowledged" } },
      ],
    });
    expect(skipReplyRan(ai as never)).toBe(false);
  });

  // The anti-drift half: the reader recognises what the REAL tool returns, both of its variants, and
  // the mark is something only the tool can set; a response body cannot.
  test("the real tool's own return is recognised, with and without a detail", async () => {
    // `skip_reply` calls nothing, so the ctx it is bound to is never reached: the client below
    // exists only to satisfy the signature, and a call reaching it would be the test's own failure.
    const skip = buildNativeTools({ client: {} as never, conversationId: 1 }, [
      SKIP_REPLY_TOOL,
    ]).find((t) => t.name === SKIP_REPLY_TOOL);
    expect(skip).toBeDefined();
    for (const args of [
      { reason: "acknowledged" },
      { reason: "acknowledged", detail: "a thumbs-up after the answer" },
    ]) {
      // Invoked as a TOOL CALL, which is how the graph invokes it: without one there is no
      // `tool_call_id` to build a ToolMessage around, and the tool degrades to the plain string the
      // same way `failableTool` does.
      const out = (await skip?.invoke({
        type: "tool_call",
        id: "c1",
        name: SKIP_REPLY_TOOL,
        args,
      } as never)) as ToolMessage;
      expect(contentToText(out.content)).toContain(SKIP_REPLY_ACK);
      expect(skipReplyRan(out)).toBe(true);
    }
  });
});

// The FOLLOW-UP SILENCE PROTOCOL, a rule rather than a line: the directive asks the model to call
// `skip_reply`, `skip_reply` is operator-revocable, and TWO paths render that directive.
describe("inertToolsFor", () => {
  // NOTE: The name is not the identity. A native grant wins the name (natives are merged first),
  // and only then may a call under it be read as "did nothing".
  test("the native tool is inert when it is the one bound", () => {
    expect([...inertToolsFor({ nativeToolsAllow: undefined })]).toEqual([
      SKIP_REPLY_TOOL,
    ]);
    expect([...inertToolsFor({ nativeToolsAllow: [SKIP_REPLY_TOOL] })]).toEqual(
      [SKIP_REPLY_TOOL],
    );
  });

  test("nothing is inert once natives are revoked, because a custom tool can hold the name", () => {
    expect([...inertToolsFor({ nativeToolsAllow: [] })]).toEqual([]);
    expect([...inertToolsFor({ nativeToolsAllow: ["private_note"] })]).toEqual(
      [],
    );
  });
});

describe("withFollowupSilenceChannel", () => {
  test("adds the channel to an allowlist that revoked it", () => {
    expect(
      withFollowupSilenceChannel({ nativeToolsAllow: ["private_note"] })
        .nativeToolsAllow,
    ).toEqual(["private_note", SKIP_REPLY_TOOL]);
  });

  test("leaves an allowlist that already has it untouched", () => {
    const allow = ["private_note", SKIP_REPLY_TOOL];
    expect(
      withFollowupSilenceChannel({ nativeToolsAllow: allow }).nativeToolsAllow,
    ).toBe(allow);
  });

  // NOTE: Whether any source is CONFIGURED is not whether any tool gets BUILT, so granting is not
  // gated on it: this grants, and the assembled list decides (`withoutLoneSilenceTool`).
  test("natives revoked is no longer a reason to withhold the channel", () => {
    expect(
      withFollowupSilenceChannel({ nativeToolsAllow: [] as string[] })
        .nativeToolsAllow,
    ).toEqual([SKIP_REPLY_TOOL]);
  });

  // NOTE: The grant also fires for an agent with a custom HTTP tool under this name. The `reserved`
  // argument makes a native name unavailable to every other source EVEN WHEN THE NATIVE IS NOT
  // BUILT, so their tool is dropped at assembly either way, and standing down would only leave the
  // follow-up with no silence channel at all. Both halves are asserted: the assembly really drops
  // their tool, so the grant costs them nothing.
  test("the collision already cost the operator the tool, so it no longer costs the channel", () => {
    const cfg = {
      nativeToolsAllow: [] as string[],
      httpToolDefs: [{ name: SKIP_REPLY_TOOL }],
    };
    expect(withFollowupSilenceChannel(cfg).nativeToolsAllow).toEqual([
      SKIP_REPLY_TOOL,
    ]);
    // …and with natives revoked their tool is dropped whatever the grant does.
    const noneBuilt = new Set<string>();
    const { tools, dropped } = dropDuplicateToolNames(
      [{ name: SKIP_REPLY_TOOL } as never],
      NATIVE_TOOL_NAMES.filter((n) => !noneBuilt.has(n)),
    );
    expect(tools).toEqual([]);
    expect(dropped).toEqual([SKIP_REPLY_TOOL]);
  });

  // NOTE: A refusal that returns EARLY must not skip the precondition cleanup below it, or a
  // fail-closed guard stays on the very call the directive depends on, for exactly the agent that
  // also has no channel. The granted case below is the other door into the same shape.
  test("and the precondition cleanup that the refusal skipped now runs for that agent", () => {
    const out = withFollowupSilenceChannel({
      nativeToolsAllow: [] as string[],
      httpToolDefs: [{ name: SKIP_REPLY_TOOL }],
      toolPreconditions: {
        [SKIP_REPLY_TOOL]: { kind: "attribute", key: "cpf" },
        handoff_to_human: { kind: "attribute", key: "url" },
      } as Record<string, unknown>,
    });
    expect(out.toolPreconditions).toEqual({
      handoff_to_human: { kind: "attribute", key: "url" },
    });
  });

  // NOTE: A guard on the NAME alone, when the native is granted, protects nothing (natives win the
  // name) and would skip the precondition cleanup, leaving a fail-closed guard on the very call the
  // directive depends on.
  test("with the native already granted, theirs never wins and cleanup still runs", () => {
    const out = withFollowupSilenceChannel({
      nativeToolsAllow: [SKIP_REPLY_TOOL, "private_note"],
      httpToolDefs: [{ name: SKIP_REPLY_TOOL }],
      toolPreconditions: {
        [SKIP_REPLY_TOOL]: { kind: "attribute", key: "cpf" },
      } as Record<string, unknown>,
    });
    expect(out.toolPreconditions).toEqual({});
    expect(out.nativeToolsAllow).toEqual([SKIP_REPLY_TOOL, "private_note"]);
  });

  test("a custom tool under any OTHER name is no obstacle", () => {
    expect(
      withFollowupSilenceChannel({
        nativeToolsAllow: [] as string[],
        httpToolDefs: [{ name: "cep" }],
      }).nativeToolsAllow,
    ).toEqual([SKIP_REPLY_TOOL]);
  });

  // Granting is only half. A precondition on the tool is fail-closed and refuses the very call the
  // directive depends on, so the follow-up would answer with text instead: the leak by a third road.
  test("it also drops a precondition standing on the channel", () => {
    const preconditions: Record<string, unknown> = {
      [SKIP_REPLY_TOOL]: { kind: "attribute", key: "x" },
      handoff_to_human: { kind: "attribute", key: "article_url" },
    };
    const out = withFollowupSilenceChannel({
      nativeToolsAllow: [SKIP_REPLY_TOOL],
      toolPreconditions: preconditions,
    });
    expect(out.toolPreconditions).toEqual({
      handoff_to_human: { kind: "attribute", key: "article_url" },
    });
  });

  test("it leaves an agent with no preconditions alone", () => {
    const cfg = { nativeToolsAllow: undefined, toolPreconditions: {} };
    expect(withFollowupSilenceChannel(cfg).toolPreconditions).toEqual({});
  });

  test("it revokes nothing else", () => {
    expect(
      withFollowupSilenceChannel({
        nativeToolsAllow: ["private_note", "set_labels"],
      }).nativeToolsAllow,
    ).toEqual(["private_note", "set_labels", SKIP_REPLY_TOOL]);
  });
});

describe("silenceWasChosen — the decision belongs to THIS turn", () => {
  const marked = (name = SKIP_REPLY_TOOL): ToolMessage =>
    new ToolMessage({
      content: `${SKIP_REPLY_ACK}.`,
      tool_call_id: "c1",
      name,
      additional_kwargs: { [SKIP_REPLY_MARK]: true },
    });
  const plain = (name: string): ToolMessage =>
    new ToolMessage({ content: "ok", tool_call_id: "c2", name });

  test("the tool ran since the customer wrote: the silence was chosen", () => {
    expect(
      silenceWasChosen([
        new HumanMessage("obrigado!"),
        new AIMessage({
          content: "",
          tool_calls: [
            {
              id: "c1",
              name: SKIP_REPLY_TOOL,
              args: { reason: "acknowledged" },
            },
          ],
        }),
        marked(),
      ]),
    ).toBe(true);
  });

  test("a completion that merely came back empty chose nothing", () => {
    expect(
      silenceWasChosen([
        new HumanMessage("mandei os dados, CPF e número do pedido"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "c2", name: "set_labels", args: {} }],
        }),
        plain("set_labels"),
        new AIMessage(""),
      ]),
    ).toBe(false);
  });

  // THE BOUND, and the reason this function exists instead of a bare `some(skipReplyRan)`. The graph
  // state is checkpointed per contact-inbox, so the history handed to the runtime holds every earlier
  // turn — here, the customer's "ok" answered with the tool. Read unbounded, that decision would
  // authorise closing the conversation on today's turn, which nobody chose.
  test("a decision from an EARLIER turn does not carry into this one", () => {
    expect(
      silenceWasChosen([
        new HumanMessage("ok"),
        marked(),
        new HumanMessage("estou esperando o e-mail de vocês desde ontem"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "c2", name: "set_labels", args: {} }],
        }),
        plain("set_labels"),
      ]),
    ).toBe(false);
  });

  // Same polarity as `skipReplyRan`: an operator precondition on `skip_reply` returns an ordinary
  // result under that very name saying the call did NOT run. Read by name it would buy the close of
  // a conversation nobody answered.
  test("a refusal wearing the tool's name is not a decision", () => {
    const refusal = new ToolMessage({
      content: unmetPreconditionMessage(SKIP_REPLY_TOOL, [
        {
          kind: "attribute",
          scope: "conversation",
          key: "cpf",
        },
      ]),
      tool_call_id: "c1",
      name: SKIP_REPLY_TOOL,
    });
    expect(silenceWasChosen([new HumanMessage("oi"), refusal])).toBe(false);
  });

  test("no history at all is not a decision", () => {
    expect(silenceWasChosen([])).toBe(false);
  });
});
