import { describe, expect, test } from "bun:test";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  deliverReply,
  readSplitConfig,
  SPLIT_DEFAULTS,
  splitReply,
  splitReplyParts,
  typingDelayMs,
} from "@/modules/split/service";

const cfg = SPLIT_DEFAULTS;

describe("readSplitConfig", () => {
  test("defaults to enabled", () => {
    expect(readSplitConfig(undefined).enabled).toBe(true);
    expect(readSplitConfig({ split: {} })).toEqual(SPLIT_DEFAULTS);
  });
  test("clamps numeric knobs", () => {
    const c = readSplitConfig({
      split: { enabled: true, maxChars: 5, typingWpm: 99999 },
    });
    expect(c.enabled).toBe(true);
    expect(c.maxChars).toBe(80);
    expect(c.typingWpm).toBe(1000);
  });
});

describe("splitReply", () => {
  test("splits on blank lines into balloons", () => {
    expect(splitReply("Olá!\n\nComo posso ajudar?", cfg)).toEqual([
      "Olá!",
      "Como posso ajudar?",
    ]);
  });
  test("a single paragraph stays one balloon", () => {
    expect(splitReply("uma resposta curta", cfg)).toEqual([
      "uma resposta curta",
    ]);
  });
  test("an over-long paragraph splits on sentences", () => {
    const small = { ...cfg, maxChars: 20 };
    const out = splitReply(
      "Primeira frase. Segunda frase aqui. Terceira.",
      small,
    );
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(40);
  });
  test("caps the balloon count, merging the overflow", () => {
    const many = "a\n\nb\n\nc\n\nd\n\ne\n\nf\n\ng";
    const out = splitReply(many, { ...cfg, maxChunks: 3 });
    expect(out.length).toBe(3);
    expect(out[2]).toContain("g");
  });
});

// THE TEXT DELIVERED IS THE TEXT THE MODEL WROTE. Splitting discards the separators, and two places
// put the text back together — the overflow merge here, and the consolidated retry in `deliverReply`.
// Rejoining with a fixed "\n\n" turns a paragraph the model wrote as ONE into two, which is a silent
// edit of the agent's own words in the direction the customer reads.
describe("splitReplyParts: rejoining does not invent paragraph breaks", () => {
  // 50, not 80: at 80 the paragraph yields two chunks and the SECOND comes from the trailing
  // push, so the mid-loop push never produces a chunk whose separator is asserted — a mutation
  // there survived. Three chunks in one paragraph exercises both pushes.
  const sentenceSplit = { ...SPLIT_DEFAULTS, maxChars: 50 };
  const oneParagraph =
    "Primeira frase bem longa aqui para forçar o corte. Segunda frase do mesmo parágrafo. Terceira frase ainda no mesmo parágrafo.\n\nOutro parágrafo.";

  test("a sentence boundary rejoins with a space, a paragraph break with a break", () => {
    const { chunks, seps } = splitReplyParts(oneParagraph, sentenceSplit);
    expect(chunks.length).toBe(4);
    // Nothing precedes the first; two sentence boundaries inside paragraph 1; then paragraph 2.
    expect(seps).toEqual(["", " ", " ", "\n\n"]);
  });

  test("the parts rejoin into exactly what the model wrote", () => {
    const { chunks, seps } = splitReplyParts(oneParagraph, sentenceSplit);
    const rejoined = chunks.reduce(
      (a, c, k) => (k === 0 ? c : a + seps[k] + c),
      "",
    );
    expect(rejoined).toBe(oneParagraph);
  });

  // The pre-existing half of the same defect, reachable with no failure at all: the overflow merge
  // runs on every reply with more balloons than maxChunks.
  test("the overflow merge does not break a paragraph the model wrote whole", () => {
    const out = splitReply(
      "Frase um bem comprida para forçar o corte. Frase dois igualmente comprida aqui. Frase tres tambem comprida.",
      { ...SPLIT_DEFAULTS, maxChars: 60, maxChunks: 2 },
    );
    expect(out).toEqual([
      "Frase um bem comprida para forçar o corte.",
      "Frase dois igualmente comprida aqui. Frase tres tambem comprida.",
    ]);
  });

  // The reviewer's cases: whitespace that is neither "one space" nor "exactly two newlines". A
  // category-based restore flattens a Markdown list into a sentence and silently rewrites the
  // agent's formatting, which the customer reads.
  test.each([
    [
      "a list item after a sentence",
      "Intro do assunto aqui para ficar longo. \n- item um\n- item dois",
      50,
    ],
    [
      "two spaces between sentences",
      "Primeira frase aqui bem longa mesmo.  Segunda frase depois.",
      40,
    ],
    [
      "three newlines between paragraphs",
      "Primeiro parágrafo.\n\n\nSegundo parágrafo.",
      600,
    ],
  ])("rejoins %s exactly as written", (_name, text, maxChars) => {
    const { chunks, seps } = splitReplyParts(text, {
      ...SPLIT_DEFAULTS,
      maxChars,
    });
    const rejoined = chunks.reduce(
      (a, c, k) => (k === 0 ? c : a + seps[k] + c),
      "",
    );
    expect(rejoined).toBe(text.trim());
  });

  test("real paragraphs still merge as paragraphs", () => {
    const out = splitReply("a\n\nb\n\nc\n\nd", {
      ...SPLIT_DEFAULTS,
      maxChunks: 2,
    });
    expect(out).toEqual(["a", "b\n\nc\n\nd"]);
  });
});

describe("typingDelayMs", () => {
  test("scales with word count and clamps", () => {
    expect(typingDelayMs("uma", cfg)).toBe(cfg.minDelayMs); // tiny → floor
    const long = `${"palavra ".repeat(500)}`;
    expect(typingDelayMs(long, cfg)).toBe(cfg.maxDelayMs); // huge → ceiling
  });
});

describe("deliverReply", () => {
  function stub(rec: { sent: string[]; typing: boolean[] }) {
    return {
      sendMessage: async (_c: number, content: string) => {
        rec.sent.push(content);
        return {};
      },
      toggleTyping: async (_c: number, on: boolean) => {
        rec.typing.push(on);
        return {};
      },
    } as unknown as ChatwootClient;
  }
  const noSleep = async () => {};

  test("disabled → a single send, no typing", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const n = await deliverReply(
      stub(rec),
      1,
      "oi\n\ntudo bem?",
      { ...SPLIT_DEFAULTS, enabled: false },
      noSleep,
    );
    expect(n.delivered).toBe(1);
    expect(rec.sent).toEqual(["oi\n\ntudo bem?"]);
    expect(rec.typing).toEqual([]);
  });

  test("enabled → one send per balloon, with typing toggles", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const n = await deliverReply(
      stub(rec),
      1,
      "Olá!\n\nComo vai?",
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(n.delivered).toBe(2);
    expect(rec.sent).toEqual(["Olá!", "Como vai?"]);
    // typing on before each balloon + a final off
    expect(rec.typing).toEqual([true, true, false]);
  });

  // A split reply is several sends with a typing pause between them, so /reset landing after the
  // first balloon finds a run that already answered its only fence. Asked per balloon, the rest of
  // the message stays unsent — and the count reports what actually landed, not what was planned,
  // because the caller keys "the customer was answered" off that number.
  test("a run called off mid-split stops at the balloon it was on", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    let wanted = true;
    const n = await deliverReply(
      stub(rec),
      1,
      "Olá!\n\nComo vai?\n\nPosso ajudar?",
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
      undefined,
      async () => {
        // Called off from the SECOND balloon on: the first is already out.
        const off = !wanted;
        wanted = false;
        return off;
      },
    );
    expect(n.delivered).toBe(1);
    expect(rec.sent).toEqual(["Olá!"]);
  });
});

// ── Partial delivery (issue #429) ────────────────────────────────────────────
//
// A split reply is N sends with a typing pause between them, so a transient Chatwoot failure has N-1
// windows to land INSIDE the reply — and the window is as wide as the reply is long, because
// `typingDelayMs` is deliberately proportional to the chunk. What that leaves is not a failed send:
// it is a customer holding the first half of an answer.
//
// The unit of delivery is the REPLY, not the balloon, and the asymmetry is what a failure costs:
//
//   nothing landed  A real turn failure. Reported as `failed` with `delivered: 0` so the caller
//                   throws, the operator is told, and the recovery (#295) re-runs the turn — safe
//                   precisely because the customer received nothing to duplicate.
//   something landed  Never a throw. Throwing discards `delivered` (the count that exists to say
//                   what the customer received) and hands the whole reply back to the recovery,
//                   which re-runs the turn and sends the balloons that already landed a second time.
//
// The remainder is retried ONCE, consolidated into a single send, which is the same rule read from
// the customer's side: they get the whole answer instead of a truncated one, and no balloon that
// already arrived is sent again. Per-chunk durable state would be the alternative and buys nothing
// here — the chunks are still in memory in this very process.
describe("deliverReply: a balloon that fails mid-reply", () => {
  // Personifies a Chatwoot that STORES what it accepted and can be read back, because the failure
  // path now asks it whether the rejected chunk landed. A stub without `getMessages` would send
  // every test in this block through the reconciliation's catch instead of through the
  // reconciliation, and they would pass without ever exercising it.
  // Personifies a Chatwoot that STORES what it accepted, ASSIGNS ids, and can be read back — the
  // three properties the failure path depends on. A stub returning `{}` from `sendMessage` leaves
  // the boundary unable to advance, and one without `getMessages` sends every test here through the
  // reconciliation's catch: both are green for the wrong reason.
  function failingStub(
    rec: { sent: string[]; typing: boolean[] },
    failOn: (content: string, n: number) => boolean,
    opts: {
      // The far side accepted it and the response never came back: stored, but reported as a
      // failure to us. The case the type of the error cannot distinguish.
      storeOnFailure?: (n: number) => boolean;
      // The read-back itself fails.
      readFails?: boolean;
      // What the conversation ALREADY holds, from before this reply. Ids below the boundary.
      history?: string[];
      calls?: { getMessages: number };
    } = {},
  ) {
    let n = 0;
    let nextId = 100;
    // What Chatwoot HOLDS, which is not the same as what the client believes it sent.
    const stored: Array<{ id: number; content: string }> = (
      opts.history ?? []
    ).map((content) => ({ id: nextId++, content }));
    return {
      sendMessage: async (_c: number, content: string) => {
        n += 1;
        const id = nextId++;
        if (failOn(content, n)) {
          if (opts.storeOnFailure?.(n)) stored.push({ id, content });
          throw new Error("chatwoot 502");
        }
        rec.sent.push(content);
        stored.push({ id, content });
        // Chatwoot answers a create with the row it made; the boundary reads the id off it.
        return { id };
      },
      getMessages: async () => {
        if (opts.calls) opts.calls.getMessages += 1;
        if (opts.readFails) throw new Error("chatwoot 500");
        return {
          payload: stored.map((m) => ({
            id: m.id,
            content: m.content,
            message_type: 1,
            private: false,
          })),
        };
      },
      toggleTyping: async (_c: number, on: boolean) => {
        rec.typing.push(on);
        return {};
      },
    } as unknown as ChatwootClient;
  }
  const noSleep = async () => {};
  const three = "Olá!\n\nComo vai?\n\nPosso ajudar?";

  test("does not throw when a balloon already landed, and reports what did", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n === 2),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // The whole answer reached the customer: balloon 1, then the remainder consolidated.
    expect(out.delivered).toBe(2);
    expect(out.failed).toBe(false);
    expect(rec.sent).toEqual(["Olá!", "Como vai?\n\nPosso ajudar?"]);
  });

  // The delivery-side half: the remainder rejoins with the separators the text actually had, so a
  // failure inside a single long paragraph does not hand the customer two paragraphs.
  test("the consolidated retry does not invent a paragraph break", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const oneParagraph =
      "Primeira frase bem longa aqui para forçar o corte. Segunda frase do mesmo parágrafo. Terceira frase ainda no mesmo parágrafo.";
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n === 2),
      1,
      oneParagraph,
      // 50 puts three chunks in the paragraph, so the retry JOINS two of them. At 80 the remainder
      // is a single chunk and the join has nothing to join — a mutation of it survived.
      { ...SPLIT_DEFAULTS, enabled: true, maxChars: 50 },
      noSleep,
    );
    expect(out.failed).toBe(false);
    expect(rec.sent).toHaveLength(2);
    // Two sends, and putting them back together gives the paragraph the model wrote.
    expect(rec.sent.join(" ")).toBe(oneParagraph);
    for (const s of rec.sent) expect(s).not.toContain("\n\n");
  });

  test("never re-sends a balloon the customer already has", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n === 3),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(out.delivered).toBe(3);
    expect(rec.sent).toEqual(["Olá!", "Como vai?", "Posso ajudar?"]);
    // The first two are in the conversation exactly once each.
    expect(rec.sent.filter((s) => s === "Olá!")).toHaveLength(1);
    expect(rec.sent.filter((s) => s === "Como vai?")).toHaveLength(1);
  });

  // A REJECTED SEND IS NOT AN UNDELIVERED ONE. The request has a 15s deadline, so a timeout — or a
  // response body that could not be read — rejects here with the message already written on the far
  // side. Retrying blindly would be this PR's own defect one layer down, and likelier: an overloaded
  // Chatwoot is exactly when both the timeout and the retry happen. The error's type cannot settle
  // it (a 502 is a proxy that may or may not have forwarded), so the conversation is read back.
  test("a send that failed but LANDED is not sent again", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const calls = { getMessages: 0 };
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n === 2, {
        // Balloon 2 reaches Chatwoot and the response is lost.
        storeOnFailure: (n) => n === 2,
        calls,
      }),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // Two reads: the boundary before the first send, and the reconciliation after the failure.
    expect(calls.getMessages).toBe(2);
    // Balloon 2 is NOT in the retry — the customer has it already. Only balloon 3 is owed.
    expect(rec.sent).toEqual(["Olá!", "Posso ajudar?"]);
    // And it still counts: two landed by send, one by the far side accepting it.
    expect(out).toEqual({ delivered: 3, failed: false });
  });

  test("a send that failed and did NOT land is included in the retry", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const calls = { getMessages: 0 };
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n === 2, { calls }),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(calls.getMessages).toBe(2);
    expect(rec.sent).toEqual(["Olá!", "Como vai?\n\nPosso ajudar?"]);
    expect(out).toEqual({ delivered: 2, failed: false });
  });

  // CONTENT IS NOT AN IDENTITY, and a conversation legitimately holds the same words twice. Matching
  // any occurrence reports a chunk that genuinely did not land as delivered, drops it from what is
  // owed, and truncates the reply while the turn reports `posted` — silently, which is the outcome
  // this whole change exists to avoid. The boundary is what makes the match mean "this send".
  test("an identical OLDER message does not answer for a send that failed", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n === 1, {
        // The customer was greeted with the same words in an earlier reply.
        history: ["Olá!"],
      }),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // The whole reply is still owed: the old "Olá!" predates the boundary and proves nothing.
    expect(rec.sent).toEqual(["Olá!\n\nComo vai?\n\nPosso ajudar?"]);
    expect(out).toEqual({ delivered: 1, failed: false });
  });

  // The same hazard from inside one reply: two balloons with identical text. The boundary advances
  // past each message we create, so the first cannot answer for the second.
  test("an identical EARLIER balloon of this same reply does not answer for a later one", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n === 2),
      1,
      "Certo!\n\nCerto!\n\nJá te retorno.",
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // Balloon 1 landed; balloon 2 is identical to it and did NOT land, so it is still owed.
    expect(rec.sent).toEqual(["Certo!", "Certo!\n\nJá te retorno."]);
    expect(out).toEqual({ delivered: 2, failed: false });
  });

  // A CONFIRMATION IS ALSO A BOUNDARY, and this is the case that proves it: `A / B / B`, where the
  // middle B lands under a rejection and the final B then genuinely does not land. With the boundary
  // left at A, the second read-back sees the middle B sitting past it and reports the final chunk as
  // delivered — a silently truncated reply, arriving through the very mechanism added to prevent one.
  test("a chunk confirmed by read-back moves the boundary past itself", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n >= 2, {
        // Send 2 (the middle B) is accepted despite being reported as failed; send 3 (the
        // consolidated retry, which is the final B) is rejected and never lands.
        storeOnFailure: (n) => n === 2,
      }),
      1,
      "Certo!\n\nJá te retorno.\n\nJá te retorno.",
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // Two landed: "Certo!" by send, the middle "Já te retorno." by read-back. The third never did,
    // and must be reported as missing rather than matched against its own twin.
    expect(out).toEqual({ delivered: 2, failed: true });
  });

  // TWO messages past the boundary carrying the same text, which the boundary alone cannot rule out:
  // it advances past what WE write, and a human writing from the console mid-reply is not us. Taking
  // the oldest match then leaves the newer one — the human's — available to answer for a later
  // balloon that never landed, reporting a truncated reply as complete.
  test("with two identical messages past the boundary, the newest is this send's", async () => {
    const sent: string[] = [];
    let n = 0;
    let nextId = 100;
    const stored: Array<{ id: number; content: string }> = [
      { id: nextId++, content: "antigo" },
    ];
    const client = {
      sendMessage: async (_c: number, content: string) => {
        n += 1;
        const id = nextId++;
        if (n === 2) {
          // Our balloon lands and the response is lost...
          stored.push({ id, content });
          // ...and an operator types the very same words from the console right after it.
          stored.push({ id: nextId++, content });
          throw new Error("chatwoot 502");
        }
        if (n === 3) throw new Error("chatwoot 502");
        sent.push(content);
        stored.push({ id, content });
        return { id };
      },
      getMessages: async () => ({
        payload: stored.map((m) => ({
          id: m.id,
          content: m.content,
          message_type: 1,
          private: false,
        })),
      }),
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;

    const out = await deliverReply(
      client,
      1,
      "Olá!\n\nComo vai?\n\nComo vai?",
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // Balloon 1 sent, balloon 2 confirmed by read-back, balloon 3 genuinely lost — and the human's
    // copy must not be mistaken for it.
    expect(out).toEqual({ delivered: 2, failed: true });
  });

  // The consolidated retry is a send like any other: it carries the same 15s deadline, so a
  // rejection is just as ambiguous. Reporting `failed` with nothing else delivered is what makes
  // the caller throw, which runs the whole turn again and posts a second copy of a reply the
  // customer already has.
  test("the consolidated retry reconciles too, instead of declaring failure", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const out = await deliverReply(
      // Every send is reported as failed, and the SECOND one (the consolidated retry) is
      // nonetheless accepted by Chatwoot.
      failingStub(rec, () => true, { storeOnFailure: (n) => n === 2 }),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // The reply is with the customer, so this is not a failed turn — and the caller must not throw.
    expect(out.failed).toBe(false);
    expect(out.delivered).toBe(1);
  });

  // Fails CLOSED for the resend. The two ways to be wrong are not symmetric: a false "landed"
  // leaves the customer permanently missing part of the answer with nothing to notice it, while a
  // false "not landed" costs one duplicated balloon that both they and the operator can see.
  test("an unreadable conversation resends rather than assuming delivery", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n === 2, {
        storeOnFailure: () => true,
        readFails: true,
      }),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(rec.sent).toEqual(["Olá!", "Como vai?\n\nPosso ajudar?"]);
    expect(out.failed).toBe(false);
  });

  // NO BOUNDARY AT ALL, which needs both of its sources to fail at once: the pre-send read AND the
  // id of a successful send (the first balloon is the one that failed, so there is none). Only then
  // is `after` null — which is why the case above, where balloon 1 landed, never reaches this rule:
  // its id had already established the boundary despite the read failing.
  //
  // Without a boundary the reconciliation cannot tell this send's message from an older twin, so it
  // must not claim delivery. Fails closed: resend.
  test("no boundary at all still resends rather than assuming delivery", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n === 1, {
        // The first send lands on the far side and is reported as failed to us...
        storeOnFailure: (n) => n === 1,
        // ...and the conversation cannot be read, before or after.
        readFails: true,
      }),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // The duplicate is the accepted cost: visible to the customer and the operator, where the other
    // error (claiming delivery) is a silently truncated reply.
    expect(rec.sent).toEqual(["Olá!\n\nComo vai?\n\nPosso ajudar?"]);
    expect(out).toEqual({ delivered: 1, failed: false });
  });

  // The failed request burned up to 15s and the read-back is more I/O, so the fence answered before
  // the first send is about a moment long gone. A /reset landing in that stretch is the operator
  // clearing the conversation: what follows is a stand-down, NOT a failure — reported as one it
  // would put `lastError` back on what they had just cleared.
  test("a run called off during the failed send does not post the remainder", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    let asks = 0;
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n === 2),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
      undefined,
      async () => {
        asks += 1;
        // Live for balloons 1 and 2; the command commits while the failed send is in flight.
        return asks > 2;
      },
    );
    // The remainder never went out, and standing down is not a failure.
    expect(rec.sent).toEqual(["Olá!"]);
    expect(out).toEqual({ delivered: 1, failed: false });
  });

  test("the remainder is retried ONCE: a second failure stops, it does not walk the rest", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n >= 2),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(out.delivered).toBe(1);
    expect(out.failed).toBe(true);
    expect(rec.sent).toEqual(["Olá!"]);
  });

  test("nothing landed → failed with delivered 0, for the caller to throw on", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const out = await deliverReply(
      failingStub(rec, () => true),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(out.delivered).toBe(0);
    expect(out.failed).toBe(true);
    expect(rec.sent).toEqual([]);
  });

  test("the typing indicator is cleared even when every send fails", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    await deliverReply(
      failingStub(rec, () => true),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // Left on, the customer watches an agent "type" a reply that is never coming.
    expect(rec.typing.at(-1)).toBe(false);
  });

  test("split disabled: the single send failing is a failed delivery, not a throw", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const out = await deliverReply(
      failingStub(rec, () => true),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: false },
      noSleep,
    );
    expect(out).toEqual({ delivered: 0, failed: true });
  });

  // `calledOff` is the operator clearing the conversation, not a failure — the same distinction
  // `deliverPendingAttachments` draws between a revocation and a failed send. Reported as a failure,
  // a /reset landing mid-split would put `lastError` back on the conversation it had just cleared.
  test("a called-off run is not a failure", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    let wanted = true;
    const out = await deliverReply(
      failingStub(rec, () => false),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
      undefined,
      async () => {
        const off = !wanted;
        wanted = false;
        return off;
      },
    );
    expect(out).toEqual({ delivered: 1, failed: false });
  });
});
