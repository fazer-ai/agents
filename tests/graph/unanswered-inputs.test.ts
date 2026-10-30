import { describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ingestedMessages } from "@/graph/ingest";
import {
  burstStartStamp,
  conversationStamp,
  humanAgentMessage,
  nudgeMessage,
  sentAtStamp,
  sourceStamp,
} from "@/graph/markers";
import { type AgentNudge, renderNudge } from "@/graph/nudge";
import { unansweredInputs } from "@/graph/unanswered-inputs";

const AT = new Date("2026-10-20T12:00:00Z");

function customer(
  id: string,
  text: string,
  at: Date = AT,
  conv = 7,
  burst: Date | null = AT,
) {
  return new HumanMessage({
    id,
    content: text,
    additional_kwargs: {
      ...conversationStamp(conv),
      ...sentAtStamp(at),
      ...burstStartStamp(burst),
    },
  });
}

function sourced(id: string, text: string, source: string, at = AT) {
  return new HumanMessage({
    id,
    content: text,
    additional_kwargs: {
      ...conversationStamp(7),
      ...sentAtStamp(at),
      ...sourceStamp(source),
    },
  });
}

function undated(id: string, text: string) {
  return new HumanMessage({
    id,
    content: text,
    additional_kwargs: conversationStamp(7),
  });
}

function ingested(messageId: number, text: string) {
  return ingestedMessages(
    "customer",
    text,
    7,
    false,
    messageId,
    AT,
  )[0] as BaseMessage;
}

function directive(id: string, text = "Faça o follow-up.", source?: string) {
  const m = nudgeMessage(text, 7, source);
  m.id = id;
  return m;
}

function ai(id: string, text = "ok") {
  return new AIMessage({ id, content: text });
}

function calling(id: string) {
  return new AIMessage({
    id,
    content: "",
    tool_calls: [
      { id: `c-${id}`, name: "skip_reply", args: {}, type: "tool_call" },
    ],
  });
}

const CASES: Array<{
  name: string;
  thread: BaseMessage[];
  removed: string[];
  directives: number;
  duplicates: number;
}> = [
  {
    name: "a directive the model answered stays",
    thread: [directive("d1"), ai("a1"), customer("h1", "oi")],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "a directive answered by a tool call (a chosen silence) stays",
    thread: [
      directive("d1"),
      calling("a1"),
      new ToolMessage({ id: "t1", content: "ok", tool_call_id: "c-a1" }),
      customer("h1", "oi"),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "repeated directives with no output between them keep the last copy",
    thread: [directive("d1"), directive("d2"), directive("d3")],
    removed: ["d1", "d2"],
    directives: 2,
    duplicates: 0,
  },
  {
    name: "a failed directive followed by the customer stays: it may carry an event's facts",
    thread: [ai("a0"), directive("d1"), customer("h1", "voltei")],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "copies of a failed directive before the customer's message keep one",
    thread: [
      ai("a0"),
      directive("d1"),
      directive("d2"),
      customer("h1", "voltei"),
    ],
    removed: ["d1"],
    directives: 1,
    duplicates: 0,
  },
  {
    name: "two different events are not copies of each other",
    thread: [
      directive("d1"),
      directive("d2", "Pagamento confirmado."),
      ai("a1"),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "the same directive answered each time is not residue",
    thread: [directive("d1"), ai("a1"), directive("d2"), ai("a2")],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "the same customer input sent twice by a retry keeps the last copy",
    thread: [
      customer("h1", "qual o horário?"),
      customer("h2", "qual o horário?"),
    ],
    removed: ["h1"],
    duplicates: 1,
    directives: 0,
  },
  {
    name: "three copies keep one",
    thread: [customer("h1", "oi"), customer("h2", "oi"), customer("h3", "oi")],
    removed: ["h1", "h2"],
    duplicates: 2,
    directives: 0,
  },
  {
    name: "a failed event nudge between two copies leaves the customer's input last",
    thread: [customer("h1", "oi"), directive("d1"), customer("h2", "oi")],
    removed: ["h1"],
    directives: 0,
    duplicates: 1,
  },
  {
    name: "two events that render the same words are two occasions",
    thread: [
      directive("d1", "Boleto vencido.", "occ:1"),
      directive("d2", "Boleto vencido.", "occ:2"),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "retries of one occasion keep the last, even re-rendered",
    thread: [
      directive("d1", "Boleto vencido.", "occ:1"),
      directive("d2", "Boleto vencido, avise.", "occ:1"),
    ],
    removed: ["d1"],
    directives: 1,
    duplicates: 0,
  },
  {
    name: "a sourced directive and an older unsourced one are not copies",
    thread: [directive("d1"), directive("d2", "Faça o follow-up.", "occ:1")],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "two messages with the same words in the same second are two inputs",
    thread: [
      sourced("h1", "sim", "message:1"),
      sourced("h2", "sim", "message:2"),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "a retry of the turn answering one message keeps the last copy",
    thread: [
      sourced("h1", "sim", "message:1"),
      sourced("h2", "sim", "message:1"),
    ],
    removed: ["h1"],
    directives: 0,
    duplicates: 1,
  },
  {
    name: "the customer repeating the same words later is two messages",
    thread: [
      customer("h1", "oi", new Date("2026-10-20T12:00:00Z")),
      customer("h2", "oi", new Date("2026-10-20T12:05:00Z")),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "a single-message burst's retry copies carry no burst stamp and are still copies",
    thread: [
      customer("h1", "oi", AT, 7, null),
      customer("h2", "oi", AT, 7, null),
    ],
    removed: ["h1"],
    directives: 0,
    duplicates: 1,
  },
  {
    name: "the same words with another burst start are not a copy",
    thread: [
      customer("h1", "oi", AT, 7, null),
      customer("h2", "oi", AT, 7, AT),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "undated inputs are never taken for copies",
    thread: [undated("h1", "oi"), undated("h2", "oi")],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "ingested messages in the same second are two messages",
    thread: [ingested(1, "sim"), ingested(2, "sim")],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "the same words in another conversation are not a copy",
    thread: [customer("h1", "oi", AT, 7), customer("h2", "oi", AT, 8)],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "a message a human agent sent is never a customer copy",
    thread: [
      humanAgentMessage(7, "oi", "g1", AT),
      humanAgentMessage(7, "oi", "g2", AT),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "the same input after a finished answer is a new message, not a copy",
    thread: [customer("h1", "ok"), ai("a1"), customer("h2", "ok")],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
  {
    name: "the same input after a tool step is left alone: a terminal tool ends a turn too",
    thread: [
      customer("h1", "que horas são?"),
      calling("a1"),
      new ToolMessage({ id: "t1", content: "12:00", tool_call_id: "c-a1" }),
      customer("h2", "que horas são?"),
    ],
    removed: [],
    directives: 0,
    duplicates: 0,
  },
];

describe("unansweredInputs", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const out = unansweredInputs(c.thread);
      expect(out.ids).toEqual(c.removed);
      expect(out.directives).toBe(c.directives);
      expect(out.duplicates).toBe(c.duplicates);
    });
  }

  test("a message without an id cannot be removed and is left alone", () => {
    const d = nudgeMessage("Faça o follow-up.", 7);
    expect(unansweredInputs([d, directive("d2")]).ids).toEqual([]);
  });
});

// A directive written before inputs carried a source: the text the renderer produced, with a random
// id and no `fazerSource`. Attempts of one occasion re-render it, so the parts that are not the
// event's data change between them.
function legacy(
  id: string,
  n: AgentNudge,
  opts: { canMessageCustomer?: boolean; conv?: number } = {},
) {
  const m = nudgeMessage(
    renderNudge(n, opts.canMessageCustomer ?? true),
    opts.conv ?? 7,
  );
  m.id = id;
  return m;
}

const inactivity = (idleMin: number, instructions?: string): AgentNudge => ({
  source: "followup",
  kind: "inactivity",
  summary: `The customer has been inactive for about ${idleMin} minutes.`,
  instructions,
  step: 1,
});

const snoozed = (
  idleMin: number,
  conversation: string,
  step = 1,
): AgentNudge => ({
  source: "followup",
  kind: "snoozed",
  framing: "snoozed_reminder",
  summary: `a person asked the customer ${idleMin} minutes ago; no reply yet`,
  text: "Pode me mandar o comprovante?",
  conversation,
  step,
});

const payment = (id: string, summary: string, value = 150): AgentNudge => ({
  source: "asaas",
  kind: "payment",
  status: "RECEIVED",
  value,
  currency: "BRL",
  summary,
  refs: { payment_id: id },
});

const LEGACY: Array<{
  name: string;
  thread: BaseMessage[];
  removed: string[];
}> = [
  {
    name: "attempts of one inactivity follow-up whose idle time grew keep the last",
    thread: [
      ai("a0"),
      legacy("d1", inactivity(40)),
      legacy("d2", inactivity(42)),
      legacy("d3", inactivity(1206)),
    ],
    removed: ["d1", "d2"],
  },
  {
    name: "an attempt rendered after a person took over is still the same follow-up",
    thread: [
      ai("a0"),
      legacy("d1", inactivity(40)),
      legacy("d2", inactivity(55), { canMessageCustomer: false }),
    ],
    removed: ["d1"],
  },
  {
    name: "an attempt rendered after the operator edited the guidance is still the same follow-up",
    thread: [
      ai("a0"),
      legacy("d1", inactivity(40, "Pergunte se ainda tem interesse.")),
      legacy("d2", inactivity(55, "Ofereça o desconto de 10%.")),
    ],
    removed: ["d1"],
  },
  {
    name: "attempts of one snoozed reminder whose wait and transcript grew keep the last",
    thread: [
      ai("a0"),
      legacy("d1", snoozed(30, "agent: Pode me mandar o comprovante?")),
      legacy(
        "d2",
        snoozed(95, "agent: Pode me mandar o comprovante?\ncustomer: já já", 2),
      ),
    ],
    removed: ["d1"],
  },
  {
    name: "a legacy follow-up the model answered stays",
    thread: [
      legacy("d1", inactivity(40)),
      ai("a1"),
      legacy("d2", inactivity(1440)),
    ],
    removed: [],
  },
  {
    name: "two payment events with different ids both keep their facts",
    thread: [
      ai("a0"),
      legacy("d1", payment("pay_1", "Payment received")),
      legacy("d2", payment("pay_2", "Payment received")),
    ],
    removed: [],
  },
  {
    name: "two events whose summaries differ only in a number are not merged",
    thread: [
      ai("a0"),
      legacy("d1", {
        source: "erp",
        kind: "order",
        summary: "Order 1041 shipped",
      }),
      legacy("d2", {
        source: "erp",
        kind: "order",
        summary: "Order 1042 shipped",
      }),
    ],
    removed: [],
  },
  {
    name: "two events with different values are not merged",
    thread: [
      ai("a0"),
      legacy("d1", payment("pay_1", "Payment received", 150)),
      legacy("d2", payment("pay_1", "Payment received", 300)),
    ],
    removed: [],
  },
  {
    name: "the same event text with different event text blocks is not merged",
    thread: [
      ai("a0"),
      legacy("d1", {
        source: "generic",
        kind: "event",
        text: "Pedido 1 aprovado",
      }),
      legacy("d2", {
        source: "generic",
        kind: "event",
        text: "Pedido 2 aprovado",
      }),
    ],
    removed: [],
  },
  {
    name: "an inactivity follow-up and a snoozed reminder are different occasions",
    thread: [
      ai("a0"),
      legacy("d1", inactivity(40)),
      legacy("d2", snoozed(30, "agent: oi")),
    ],
    removed: [],
  },
  {
    name: "the same follow-up on two conversations is not merged",
    thread: [
      ai("a0"),
      legacy("d1", inactivity(40), { conv: 7 }),
      legacy("d2", inactivity(55), { conv: 8 }),
    ],
    removed: [],
  },
  {
    name: "a legacy attempt before a sourced attempt of the same follow-up is a copy",
    thread: [
      ai("a0"),
      legacy("d1", inactivity(40)),
      directive("d2", renderNudge(inactivity(55), true), "job:9:followup"),
    ],
    removed: ["d1"],
  },
  {
    name: "a legacy event before a sourced directive of another event stays",
    thread: [
      ai("a0"),
      legacy("d1", payment("pay_1", "Payment received")),
      directive("d2", renderNudge(inactivity(55), true), "job:9:followup"),
    ],
    removed: [],
  },
  {
    name: "two sourced deliveries that render the same event are two events",
    thread: [
      ai("a0"),
      directive(
        "d1",
        renderNudge(payment("pay_1", "Paid"), true),
        "delivery:1",
      ),
      directive(
        "d2",
        renderNudge(payment("pay_1", "Paid"), true),
        "delivery:2",
      ),
    ],
    removed: [],
  },
  {
    name: "a hand-written directive outside the renderer's shape is matched by its whole text",
    thread: [
      ai("a0"),
      directive("d1", "Faça o follow-up 1."),
      directive("d2", "Faça o follow-up 2."),
    ],
    removed: [],
  },
];

describe("unansweredInputs, directives written before inputs carried a source", () => {
  for (const c of LEGACY) {
    test(c.name, () => {
      const out = unansweredInputs(c.thread);
      expect(out.ids).toEqual(c.removed);
      expect(out.directives).toBe(c.removed.length);
    });
  }
});
