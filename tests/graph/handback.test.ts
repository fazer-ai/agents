import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { owesHandbackNote } from "@/graph/handback";
import {
  conversationDividerMessage,
  humanAgentMessage,
  humanHandbackMessage,
  memoryHeadMessage,
} from "@/graph/markers";
import { HANDOFF_DONE_PREFIX } from "@/graph/tools/catalog";

// The pair a real transfer leaves: the call, checkpointed BEFORE the tool runs, and the tool's own
// result, which is the only one of the two that says it happened.
const handoff = () => [
  new AIMessage({
    content: "",
    tool_calls: [{ name: "handoff_to_human", args: {}, id: "1" }],
  }),
  new ToolMessage({
    content: `${HANDOFF_DONE_PREFIX} (status set to open). The bot will stay silent now.`,
    tool_call_id: "1",
    name: "handoff_to_human",
  }),
];
// The same call, refused by an operator's precondition: the conversation stays bot-owned.
const handoffRefused = () => [
  new AIMessage({
    content: "",
    tool_calls: [{ name: "handoff_to_human", args: {}, id: "9" }],
  }),
  new ToolMessage({
    content:
      "`handoff_to_human` was not run: it requires the contact attribute `cpf` to be set, and it is not.",
    tool_call_id: "9",
    name: "handoff_to_human",
  }),
];
const other = () => [
  new AIMessage({
    content: "",
    tool_calls: [{ name: "private_note", args: {}, id: "2" }],
  }),
  new ToolMessage({
    content: "Private note posted (visible to agents, not the customer).",
    tool_call_id: "2",
    name: "private_note",
  }),
];
// AN EXTERNAL TOOL SAYING THE SAME WORDS. Any enabled HTTP, MCP or toolpack tool returns whatever
// text its own server returns, and a CRM whose "escalate" endpoint answers with this sentence is not
// far-fetched at all — while ownership of the Chatwoot conversation never moved.
const impostor = () => [
  new AIMessage({
    content: "",
    tool_calls: [{ name: "mcp__crm__escalate", args: {}, id: "3" }],
  }),
  new ToolMessage({
    content: `${HANDOFF_DONE_PREFIX} in our CRM: ticket #77 assigned to the support queue.`,
    tool_call_id: "3",
    name: "mcp__crm__escalate",
  }),
];

// THE DECISION, on its own and as a table (issue #457). It is derived from the channel rather than
// from a column, so the table IS the specification: every case below is a shape the thread really
// takes, and the previous design needed a stamp in five different writers to answer the same
// question — each of them a place to observe a takeover and forget to record it.
describe("does the turn owe a hand-back note", () => {
  test("an ordinary conversation owes nothing", () => {
    expect(
      owesHandbackNote([
        new HumanMessage("oi"),
        new AIMessage("olá! como posso ajudar?"),
      ]),
    ).toBe(false);
  });

  // The reporter's case: the agent transferred, and whether or not anybody replied the thread still
  // reads as if a person were handling it.
  test("a handoff nobody answered still owes one", () => {
    expect(
      owesHandbackNote([new HumanMessage("quero uma pessoa"), ...handoff()]),
    ).toBe(true);
  });

  test("a person answering the customer owes one", () => {
    expect(
      owesHandbackNote([
        new HumanMessage("oi"),
        humanAgentMessage(42, "Oi, aqui é a Ana."),
      ]),
    ).toBe(true);
  });

  // IDEMPOTENT WITH NO BOOKKEEPING, which is the whole reason this reads backwards: the note sitting
  // after the evidence is what says the announcement already happened.
  test("a note already after the evidence owes nothing", () => {
    expect(
      owesHandbackNote([
        ...handoff(),
        humanAgentMessage(42, "Oi, aqui é a Ana."),
        humanHandbackMessage(42),
        new HumanMessage("e aí?"),
      ]),
    ).toBe(false);
  });

  // And a SECOND stretch after that note is evidence again — the same conversation can go back and
  // forth all day.
  test("a second stretch after a note owes another one", () => {
    expect(
      owesHandbackNote([
        ...handoff(),
        humanHandbackMessage(42),
        new HumanMessage("obrigado"),
        ...handoff(),
      ]),
    ).toBe(true);
  });

  // The name IS the identity of a native tool, so nothing else counts as a transfer.
  test("another tool call is not a handoff", () => {
    expect(owesHandbackNote([new HumanMessage("oi"), ...other()])).toBe(false);
  });

  // An operator who assigns the conversation in Chatwoot and never writes leaves no evidence — and
  // leaves the model no reason to believe a person is handling it, so there is nothing to announce.
  test("messages that say nothing about a person handling it owe nothing", () => {
    expect(
      owesHandbackNote([
        conversationDividerMessage(42),
        new HumanMessage("oi"),
        new AIMessage("olá!"),
      ]),
    ).toBe(false);
  });

  // A TRANSFER THAT DID NOT HAPPEN HAS NO END TO ANNOUNCE. The call is in the thread either way —
  // it is checkpointed before the tool runs — so a decision keyed on the call would state, on the
  // next turn, that a human attendance ended when the conversation never left the bot.
  test("a handoff the preconditions refused owes nothing", () => {
    expect(
      owesHandbackNote([
        new HumanMessage("quero uma pessoa"),
        ...handoffRefused(),
      ]),
    ).toBe(false);
  });

  // THE PREFIX IS NOT AN IDENTITY, the tool NAME is: a native's name is unrenameable and
  // unnamespaced, and `dropDuplicateToolNames` puts natives first, so no other source can take it.
  // Matching on the sentence alone lets any enabled tool announce a hand-back for a conversation
  // nobody ever took, and the model would then be told a human attendance ended while it is still
  // the only one answering.
  test("another tool's result opening with the same sentence is not a handoff", () => {
    expect(
      owesHandbackNote([
        new HumanMessage("quero abrir um chamado"),
        ...impostor(),
      ]),
    ).toBe(false);
  });

  // And the identity alone is not enough either, which is the same argument in the other direction:
  // the tool node stamps the name on a FAILED call too (`status: "error"`), and a handoff that threw
  // left the conversation with the bot.
  test("the handoff tool's own error result owes nothing", () => {
    expect(
      owesHandbackNote([
        new HumanMessage("quero uma pessoa"),
        new AIMessage({
          content: "",
          tool_calls: [{ name: "handoff_to_human", args: {}, id: "4" }],
        }),
        new ToolMessage({
          content: "Error: Chatwoot returned 502\n Please fix your mistakes.",
          tool_call_id: "4",
          name: "handoff_to_human",
        }),
      ]),
    ).toBe(false);
  });

  // COMPACTION CARRIES THE EVIDENCE (issue #457, review round 8). A conversation resolved while a
  // person still held it is summarized away — handoff result, human messages and all — and the raw
  // form the two cases above read is simply gone. The head that replaced it says what the stretch
  // ended in, so the first turn after the thread resumes still owes the note.
  test("a memory head that replaced a human stretch owes one", () => {
    expect(
      owesHandbackNote([
        memoryHeadMessage("<memoria>…</memoria>", undefined, true),
        new HumanMessage("oi de novo"),
      ]),
    ).toBe(true);
  });

  // And an ordinary head says nothing about a human attendance, which is what keeps the case above
  // about the stretch rather than about compaction.
  test("a memory head from an ordinary attendance owes nothing", () => {
    expect(
      owesHandbackNote([
        memoryHeadMessage("<memoria>…</memoria>"),
        new HumanMessage("oi de novo"),
      ]),
    ).toBe(false);
  });

  // The head is at the FRONT, so anything after it decides first: a note written since then means
  // this was already announced.
  test("a note after the head closes it", () => {
    expect(
      owesHandbackNote([
        memoryHeadMessage("<memoria>…</memoria>", undefined, true),
        humanHandbackMessage(42),
        new HumanMessage("oi de novo"),
      ]),
    ).toBe(false);
  });

  test("an empty thread owes nothing", () => {
    expect(owesHandbackNote([])).toBe(false);
  });
});
