import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
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
  skipReplyRan,
  withFollowupSilenceChannel,
  withoutLoneSilenceTool,
} from "@/graph/silence";
import { buildNativeTools } from "@/graph/tools/native";
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
    // Review round 2, P2. The token in a costume: strip it and only quotes are left.
    ["the sentinel in quotes", `"${S}"`, true, ""],
    ["the sentinel in backticks", `\`${S}\``, true, ""],
    ["quotes around repeated sentinels", `"${S}${S}"`, true, ""],
    // ...and the other direction: quotes on a REAL reply are content and survive untouched.
    ["a quoted real reply", `"Olá!"`, false, `"Olá!"`],
    // Review round 3. Quotes are tolerated only when the token was actually there: a customer asking
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
    // Review round 4. The token inside a REAL answer is left alone: editing a substring out of a
    // customer-facing reply is the silent data loss docs/graph.md rejects, and the cause fix means
    // only a legacy transcript can still put it here. Reported, never mutated (see `carriesToken`).
    ["a real reply carrying the token", `${S} Claro.`, false, `${S} Claro.`],
    ["a real reply ending in the token", `Claro. ${S}`, false, `Claro. ${S}`],
    [
      "the token twice inside a reply",
      `${S}Bom${S} dia`,
      false,
      `${S}Bom${S} dia`,
    ],
    // The heuristics below belong to the proactive path ONLY. Here a customer is waiting, and these
    // are ordinary short answers — swallowing one is its own defect (review round 1, P2).
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
      // The contract the repeated-sentinel case used to fall through: emptiness and silence are one
      // decision, so a caller can never see silent=false with nothing to send.
      expect(out.silent).toBe(out.text.length === 0);
      // ...and the one thing the rules erase on purpose: EVERY kind of silence comes out as `text:
      // ""`, so a caller asking "is there anything in the thread nobody received" needs the raw
      // answer kept separately (round 15). It is about the model's words, never about ours.
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

  // Round 10. A grant is not an assembled tool: `withFollowupSilenceChannel` grants generously (it
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

  // Round 12, the defect. A source that is configured and yields nothing (an MCP server that is
  // down) left the grant handing a lone function schema to an endpoint that had been running
  // tool-less on the sentinel: the whole follow-up fails at the provider instead of one token
  // leaking. Only the assembled list can tell the two apart.
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

  // Round 14, and the same mistake this whole file keeps correcting: a NAME is not an identity. With
  // natives revoked the lone tool under that name is the operator's own HTTP tool — the grant
  // refuses to install over it for exactly that reason — and removing it would delete their only
  // tool from every follow-up because it happens to be spelled like ours.
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
    // ...and for the agent whose own tool holds the name, the grant never fired, the drop leaves it
    // standing, and the directive falls back to the sentinel it can actually speak.
    const theirs = withFollowupSilenceChannel({
      nativeToolsAllow: [] as string[],
      httpToolDefs: [{ name: SKIP_REPLY_TOOL }],
    });
    const kept = withoutLoneSilenceTool(theirs, [{ name: SKIP_REPLY_TOOL }]);
    expect(kept).toHaveLength(1);
    expect(followupSilenceChannel(theirs, kept)).toBe("sentinel");
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

  // Round 24. The ack is published in this repo, and with natives revoked an operator may bind a
  // custom HTTP tool under this name whose response body they do not control — a third-party API, or
  // a customer's own words echoed back. Read as identity, a body that begins with the ack ends the
  // turn without answering: a denial of the customer's reply, reachable by injection.
  test("a response body that merely SAYS the ack is not the tool", () => {
    expect(skipReplyRan(msg(SKIP_REPLY_TOOL, `${SKIP_REPLY_ACK}. x`))).toBe(
      false,
    );
  });

  // Round 10, the defect that made the name insufficient. `skip_reply` is a native name, so
  // `isGuardableToolName` accepts a precondition on it; unmet, the wrapper returns a NORMAL tool
  // result under the same name telling the model to carry on. Read by name that is silence, and the
  // turn then ends with no text at all — a customer left waiting by the rule meant to make the agent
  // more careful. Unmarked, so it is not the tool either.
  test("a precondition refusal wearing the same name is NOT silence", () => {
    const refusal = unmetPreconditionMessage(SKIP_REPLY_TOOL, {
      kind: "attribute",
      scope: "conversation",
      key: "cpf",
    });
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
      tool_calls: [{ id: "c1", name: SKIP_REPLY_TOOL, args: {} }],
    });
    expect(skipReplyRan(ai as never)).toBe(false);
  });

  // The anti-drift half: the reader recognises what the REAL tool returns, both of its variants, and
  // the mark is something only the tool can set — a response body cannot.
  test("the real tool's own return is recognised, with and without a reason", async () => {
    // `skip_reply` calls nothing, so the ctx it is bound to is never reached — the client below
    // exists only to satisfy the signature, and a call reaching it would be the test's own failure.
    const skip = buildNativeTools({ client: {} as never, conversationId: 1 }, [
      SKIP_REPLY_TOOL,
    ]).find((t) => t.name === SKIP_REPLY_TOOL);
    expect(skip).toBeDefined();
    for (const args of [{}, { reason: "customer only sent 'ok'" }]) {
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

// The fence. The leak (issue #454) was not a wrong rule, it was a rule two of four sites knew, so
// what has to fail here is a site N+1 that takes the model's final text and skips it.
//
// It is anchored on `lastAssistantText`, which is narrower than the invariant, and the gap is
// declared rather than papered over. Anchoring on `contentToText` instead — the helper underneath —
// was tried and accuses eleven sites that are correct: token counting, the turn trace, the memory
// summarizer, and reading the HUMAN message. A scan that accuses everything proves as little as one
// that finds nothing.
//
// WHAT IT DOES NOT COVER, said out loud so it is not left to be discovered:
//   - `playground/sessions.ts` picks the reply with its own `lastAi`, deliberately not this one.
//     Covered by BEHAVIOUR instead, in tests/modules/playground-sessions.test.ts.
//   - `graph/trace.ts` renders the turn trace, which exists to show what the model actually
//     produced, and is meant to stay raw.
//   - `memory/summarize.ts` feeds the transcript to the summarizer. That is how the token reaches
//     permanent memory, which is a recurrence question rather than a leak: it is named in the issue
//     and left to its own change.
describe("every site that reads the model's final text applies a rule", () => {
  // Kept as a predicate over TEXT rather than an inline scan, so the fixture below can prove it
  // rejects the shape the defect had — a fence with no offender in the tree proves nothing about
  // whether it can see one.
  const READERS = /lastAssistantText\(/;
  function unguardedSites(source: string): string[] {
    return source
      .split("\n")
      .filter(
        (l) =>
          READERS.test(l) && !/(customerFacingReply|proactiveReply)\(/.test(l),
      )
      .map((l) => l.trim());
  }

  test("the predicate sees the defect it was written for", () => {
    expect(
      unguardedSites(
        "  const reply = lastAssistantText(result.messages).trim();",
      ),
    ).toHaveLength(1);
    expect(
      unguardedSites(
        "  const drafted = customerFacingReply(lastAssistantText(result.messages));",
      ),
    ).toHaveLength(0);
    expect(
      unguardedSites(
        "  const drafted = proactiveReply(lastAssistantText(result.messages));",
      ),
    ).toHaveLength(0);
  });

  test("no production site reads it unguarded", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") || p.endsWith(".tsx")) files.push(p);
      }
    };
    walk("src");

    const offenders: string[] = [];
    let sites = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!READERS.test(src)) continue;
      // Definitions and import lines name the readers without reading a turn.
      const body = src
        .split("\n")
        .filter(
          (l) =>
            !l.includes("export function lastAssistantText") &&
            !l.trimStart().startsWith("import") &&
            !l.includes("lastAssistantText } from"),
        )
        .join("\n");
      for (const l of unguardedSites(body)) offenders.push(`${f}: ${l}`);
      sites += body
        .split("\n")
        .filter(
          (l) => READERS.test(l) && !l.trimStart().startsWith("//"),
        ).length;
    }
    // A scan that stopped FINDING sites would pass by invisibility, so the count is asserted too:
    // it is allowed to grow, and a drop to zero means the scan broke, not that the tree got safer.
    expect(sites).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });
});

// The FOLLOW-UP SILENCE PROTOCOL, which is where round 3 landed and why it is a rule rather than a
// line: the directive asks the model to call `skip_reply`, `skip_reply` is operator-revocable, and
// there are TWO paths that render that directive. Round 2 changed the protocol in one of them.
describe("inertToolsFor", () => {
  // Round 8: the name is not the identity. A native grant wins the name (natives are merged first),
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

  // Review round 12. Granting used to be gated on whether any source was CONFIGURED, which is not
  // the same question as whether any tool gets BUILT. The gate is gone: this grants, and the
  // assembled list decides (`withoutLoneSilenceTool`).
  test("natives revoked is no longer a reason to withhold the channel", () => {
    expect(
      withFollowupSilenceChannel({ nativeToolsAllow: [] as string[] })
        .nativeToolsAllow,
    ).toEqual([SKIP_REPLY_TOOL]);
  });

  // ...with one exception, and it is about somebody else's property. `toolDefinitionCreateSchema`
  // reserves no native name, and `dropDuplicateToolNames` puts natives FIRST — so granting ours to
  // an agent that runs a custom HTTP tool under this name would evict theirs from every follow-up.
  test("an operator's own tool keeps the name, and the agent keeps the sentinel", () => {
    const cfg = {
      nativeToolsAllow: [] as string[],
      httpToolDefs: [{ name: SKIP_REPLY_TOOL }],
    };
    expect(withFollowupSilenceChannel(cfg)).toBe(cfg);
  });

  // Round 15. The guard fired on the NAME alone, including when the native was granted — and then
  // natives win the name anyway, so it protected nothing and skipped the precondition cleanup below
  // it, leaving a fail-closed guard on the very call the directive depends on.
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
  // directive depends on, so the follow-up would answer with text instead — the leak by a third road.
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
        nativeToolsAllow: ["private_note", "assign_label"],
      }).nativeToolsAllow,
    ).toEqual(["private_note", "assign_label", SKIP_REPLY_TOOL]);
  });

  test("the fence wants the channel ARGUMENT too, not just the grant", () => {
    const CHANNEL = /(?<![A-Za-z])followupSilenceChannel\(/;
    expect(CHANNEL.test("renderNudge(nudge, true)")).toBe(false);
    // The shape round 10 removed: a renderer deciding the channel from the native allowlist by
    // hand. It passes an argument and is still wrong, so the fence has to want THIS function and
    // not merely a third argument.
    expect(
      CHANNEL.test(
        'renderNudge(n, true, x?.length === 0 ? "sentinel" : "tool")',
      ),
    ).toBe(false);
    expect(
      CHANNEL.test("renderNudge(n, true, followupSilenceChannel(cfg, tools))"),
    ).toBe(true);
    // ...and the grant is a DIFFERENT function whose name ends the same way. A fence that matched it
    // would pass on a renderer that grants the tool and never names the channel.
    expect(CHANNEL.test("  const c = withFollowupSilenceChannel(cfg);")).toBe(
      false,
    );
  });

  test("the fence wants the CALL, not the import", () => {
    const CALL = /withFollowupSilenceChannel\(/;
    const importOnly =
      'import { withFollowupSilenceChannel } from "@/graph/silence";';
    expect(
      CALL.test(
        importOnly
          .split("\n")
          .filter((l) => !l.trimStart().startsWith("import"))
          .join("\n"),
      ),
    ).toBe(false);
    expect(CALL.test("  const c = withFollowupSilenceChannel(cfg);")).toBe(
      true,
    );
  });

  // The fence for the invariant itself. Round 3 found the playground because the protocol lives in
  // TWO places: whoever renders the directive owes the channel. A third renderer must fail here.
  test("every renderer of the follow-up directive grants the channel", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk("src");

    const renderers = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /renderNudge\(/.test(
        src
          .split("\n")
          .filter(
            (l) =>
              !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"),
          )
          .join("\n"),
      );
    });
    // Positive control: a fence that stopped FINDING renderers proves nothing about the ones it
    // would have to check.
    expect(renderers.length).toBeGreaterThanOrEqual(2);
    const CALL = /withFollowupSilenceChannel\(/;
    for (const f of renderers) {
      const body = readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("import"))
        .join("\n");
      expect([f, CALL.test(body)]).toEqual([f, true]);
      // ...AND it must CHOOSE the channel through the shared rule, not inherit the default and not
      // re-derive it. Round 7 taught the grant to both renderers and left the directive's third
      // argument in production only, so the playground told a tool-less agent to call a tool that
      // was not bound — the same miss, one argument over; round 10 then found that argument reading
      // `nativeToolsAllow` alone, which is the config rather than the toolset. The fence covers the
      // pair because they are one obligation, and it wants the function so a hand-rolled ternary
      // cannot satisfy it.
      expect([f, /(?<![A-Za-z])followupSilenceChannel\(/.test(body)]).toEqual([
        f,
        true,
      ]);
    }
  });
});
