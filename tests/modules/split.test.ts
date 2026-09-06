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
      // Defaults to the customer message the agent is replying to: a conversation a turn answers is
      // never empty, and an empty one now reads as "no boundary" (unknown), which would send these
      // tests down the cannot-prove-delivery path instead of the one they mean to exercise.
      history?: string[];
      calls?: { getMessages: number };
      // How many messages one `getMessages` answers with. Chatwoot pages the newest ~20; the default
      // here is "everything", which is what every test written before pagination assumed.
      pageSize?: number;
      // Messages that arrive right after a send is stored — the conversation moving on while the
      // client is still deciding what happened to its own request.
      noiseOnFailure?: number;
    } = {},
  ) {
    let n = 0;
    let nextId = 100;
    // What Chatwoot HOLDS, which is not the same as what the client believes it sent. The name the
    // send gave itself travels with the row, the way the fork stores `content_attributes`.
    const stored: Array<{
      id: number;
      content: string;
      sendId: string | null;
    }> = (opts.history ?? ["oi"]).map((content) => ({
      id: nextId++,
      content,
      sendId: null,
    }));
    return {
      sendMessage: async (
        _c: number,
        content: string,
        o?: { sendId?: string },
      ) => {
        n += 1;
        const id = nextId++;
        const sendId = o?.sendId ?? null;
        if (failOn(content, n)) {
          if (opts.storeOnFailure?.(n)) stored.push({ id, content, sendId });
          for (let k = 0; k < (opts.noiseOnFailure ?? 0); k += 1) {
            stored.push({ id: nextId++, content: `ruído ${k}`, sendId: null });
          }
          throw new Error("chatwoot 502");
        }
        rec.sent.push(content);
        stored.push({ id, content, sendId });
        // Chatwoot answers a create with the row it made; the boundary reads the id off it.
        return { id };
      },
      getMessages: async (_c: number, o?: { before?: number }) => {
        if (opts.calls) opts.calls.getMessages += 1;
        if (opts.readFails) throw new Error("chatwoot 500");
        // Anchored and paged the way the REST endpoint is: `before` excludes the anchor and the
        // answer is the newest `pageSize` of what remains.
        const upTo =
          o?.before === undefined
            ? stored
            : stored.filter((m) => m.id < (o.before as number));
        const rows = upTo.slice(-(opts.pageSize ?? upTo.length));
        return {
          payload: rows.map((m) => ({
            id: m.id,
            content: m.content,
            message_type: 1,
            private: false,
            content_attributes:
              m.sendId === null ? {} : { fazer_ai_send_id: m.sendId },
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

  // THE READ-BACK HAS TO REACH THE BOUNDARY, or its silence is not an answer.
  //
  // Chatwoot answers `GET /messages` with the newest ~20. A POST that timed out AFTER committing,
  // on a conversation that then moved more than a page, leaves the balloon we are looking for off
  // that page — and "absent from the newest twenty" read as "never landed" puts the chunk straight
  // back into the consolidated retry. That is this module's own duplication, one page deeper, and
  // it is the failure mode the whole reconciliation exists to prevent.
  //
  // 25 messages arrive between the commit and the read, against a page of 20, so the landed
  // "Como vai?" is only reachable by paging backward past the boundary.
  test("the read-back pages back to the boundary before calling a send missing", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const calls = { getMessages: 0 };
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n === 2, {
        storeOnFailure: (n) => n === 2,
        noiseOnFailure: 25,
        pageSize: 20,
        calls,
      }),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // The customer holds balloon 1, the balloon whose response was lost, and the remainder — each
    // exactly once. Re-sending "Como vai?" here is the defect: it is already in the conversation.
    expect(rec.sent).toEqual(["Olá!", "Posso ajudar?"]);
    expect(out.failed).toBe(false);
    expect(out.delivered).toBe(3);
    // Exactly two pages: the newest twenty (all noise) and the one holding the landed balloon.
    // There is no third read — the pre-send boundary read is gone (issue #499), so a reply that
    // never fails now pays nothing at all, and a reply that does pays only for the pages it walks.
    // Counted because stopping at a completed send is a COST rule and has no other witness: the id
    // match already makes an older message unable to answer, so a loop that kept paging would
    // return the same verdict and only spend reads.
    expect(calls.getMessages).toBe(2);
  });

  // The other side of that rule, so the pagination cannot be "always page until something matches":
  // a send that genuinely did NOT land still has to be re-sent, and the page it is missing from has
  // to be one that reaches the boundary. Same 25 messages, same page size, nothing stored.
  test("a send that truly failed is still re-sent after paging back", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n === 2, {
        noiseOnFailure: 25,
        pageSize: 20,
      }),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(rec.sent).toEqual(["Olá!", "Como vai?\n\nPosso ajudar?"]);
    expect(out.failed).toBe(false);
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

  // THE SUCCESSFUL PATH READS NOTHING, which is the cost half of issue #499.
  //
  // A dedicated pre-send read used to run on EVERY reply to establish a boundary, because a match
  // on content needed one to mean "this send". It had to be kept short so it would not tax replies
  // that never fail (measured then: 2181ms added to a successful three-balloon reply unbounded,
  // 34ms bounded) — and that short budget is exactly what an overloaded Chatwoot misses, which is
  // how the proof came to fail precisely when it was needed.
  //
  // A send that names itself needs no boundary, so the read is gone rather than tuned: a reply that
  // succeeds now pays zero reads, and there is no budget left to be too small.
  test("a reply that does not fail reads the conversation zero times", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const calls = { getMessages: 0 };
    const out = await deliverReply(
      failingStub(rec, () => false, { calls }),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true, minDelayMs: 1234 },
      noSleep,
    );
    expect(calls.getMessages).toBe(0);
    expect(out).toEqual({ delivered: 3, failed: false });
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
    // ONE read, the reconciliation after the failure. The successful path reads nothing.
    expect(calls.getMessages).toBe(1);
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
    expect(calls.getMessages).toBe(1);
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

  // THE LAST STRETCH OF I/O, which the earlier recheck does not cover: the consolidated retry and
  // its own read-back. With nothing delivered, `failed` is what makes the caller throw, and a throw
  // after a /reset puts `lastError` back on the conversation the operator had just cleared.
  test("a run called off during the consolidated retry is not a failure", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    let asks = 0;
    const out = await deliverReply(
      // Everything fails and nothing lands, so the retry's reconciliation finds nothing either.
      failingStub(rec, () => true),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
      undefined,
      async () => {
        asks += 1;
        // Live through the first balloon and through the post-failure recheck; the command commits
        // while the consolidated retry is in flight.
        return asks > 2;
      },
    );
    expect(rec.sent).toEqual([]);
    // Nothing delivered, and standing down is NOT a failure — so the caller does not throw.
    expect(out).toEqual({ delivered: 0, failed: false });
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
  test("a person's identical message cannot answer for our send", async () => {
    const sent: string[] = [];
    let n = 0;
    let nextId = 100;
    const stored: Array<{
      id: number;
      content: string;
      sendId: string | null;
    }> = [{ id: nextId++, content: "antigo", sendId: null }];
    const client = {
      sendMessage: async (
        _c: number,
        content: string,
        o?: { sendId?: string },
      ) => {
        n += 1;
        const id = nextId++;
        if (n === 2) {
          // Our balloon lands and the response is lost...
          stored.push({ id, content, sendId: o?.sendId ?? null });
          // ...and an operator types the very same words from the console right after it. A person
          // typing in Chatwoot writes no `content_attributes`, so their copy carries no name.
          stored.push({ id: nextId++, content, sendId: null });
          throw new Error("chatwoot 502");
        }
        if (n === 3) throw new Error("chatwoot 502");
        sent.push(content);
        stored.push({ id, content, sendId: o?.sendId ?? null });
        return { id };
      },
      getMessages: async () => ({
        payload: stored.map((m) => ({
          id: m.id,
          content: m.content,
          message_type: 1,
          private: false,
          content_attributes:
            m.sendId === null ? {} : { fazer_ai_send_id: m.sendId },
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

  // AN UNREADABLE CONVERSATION IS `unknown`, AND UNKNOWN IS NOT ABSENT — the distinction issue #499
  // is about. The balloon was written on the far side and the read that would prove it fails,
  // which is one event and not two: the overloaded Chatwoot that loses the POST's response is the
  // one that cannot answer the read either.
  //
  // The base tree resent on this, and that is the duplicate two customers received. What it leaves
  // instead is a gap, and a gap is reported — `failed` is the partial badge on the conversation,
  // where the duplicate was reported as plain success.
  test("an unreadable conversation leaves the chunk out instead of risking a duplicate", async () => {
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
    // Balloon 2 is not in the retry: it may already be there. Balloon 3 was never attempted, so it
    // is owed for certain and still goes.
    expect(rec.sent).toEqual(["Olá!", "Posso ajudar?"]);
    expect(out).toEqual({ delivered: 2, failed: true });
  });

  // A READ THAT SUCCEEDS AND SAYS NOTHING is unknown, and the three shapes of "nothing" that a
  // successful HTTP call can carry all reduce to the same empty list. Reading that as absence would
  // resend a balloon that may be sitting in the conversation.
  test.each([
    ["an empty page", { payload: [] }],
    ["a response with no payload", {}],
    ["a null body", null],
  ])(
    "a read-back answering %s leaves the chunk out rather than resending it",
    async (_label, body) => {
      const rec = { sent: [] as string[], typing: [] as boolean[] };
      let n = 0;
      const client = {
        sendMessage: async (_c: number, content: string) => {
          n += 1;
          if (n === 1) throw new Error("chatwoot 502");
          rec.sent.push(content);
          return { id: 900 + n };
        },
        getMessages: async () => body,
        toggleTyping: async () => ({}),
      } as unknown as ChatwootClient;

      const out = await deliverReply(
        client,
        1,
        three,
        { ...SPLIT_DEFAULTS, enabled: true },
        noSleep,
      );
      // Balloon 1 is unaccounted for and stays out. The two that were never attempted still go, as
      // one consolidated send.
      expect(rec.sent).toEqual(["Como vai?\n\nPosso ajudar?"]);
      expect(out).toEqual({ delivered: 1, failed: true });
    },
  );

  // THE FIRST BALLOON FAILING, which is the exact shape of both production incidents (issue #499):
  // nothing has been sent yet, so there is no completed send to page back to, and on the base tree
  // there was no boundary either — `findLandedMessage` answered "not landed" without reading
  // anything, and the retry put the WHOLE reply back on the wire.
  //
  // Here the read fails too, so the verdict is honestly unknown, and the chunk stays out.
  test("the first balloon, unprovable, is not put back on the wire", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const out = await deliverReply(
      failingStub(rec, (_c, n) => n === 1, {
        // The first send lands on the far side and is reported as failed to us...
        storeOnFailure: (n) => n === 1,
        // ...and the conversation cannot be read either.
        readFails: true,
      }),
      1,
      three,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // Never `["Olá!\n\nComo vai?\n\nPosso ajudar?"]`, which is the whole reply a second time.
    expect(rec.sent).toEqual(["Como vai?\n\nPosso ajudar?"]);
    expect(out).toEqual({ delivered: 1, failed: true });
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

// A DELIVERY PROVES ITSELF BY NAME, NOT BY TEXT (issue #499).
//
// Two production duplicates (conversations 1382 and 1445, 18s and 18.5s apart) came from the same
// place: the POST hit its 15s deadline with the message already written on the far side, the
// read-back could not prove it, and the consolidated retry sent the whole reply again. On a
// one-balloon reply that retry is not a remainder at all — it is the answer, a second time.
//
// The reconciliation could not prove it because it was looking for TEXT, which is not an identity:
// it needed a boundary to tell one occurrence from another, the boundary needed its own read, and
// that read is bounded by the typing pause (1680ms for the reply in 1445) — so the overloaded
// Chatwoot that caused the timeout is the one that also loses the proof. Measured, on the base
// tree: either half of the proof failing is enough to duplicate, and the loop reports
// `delivered: 1, failed: false` while it happens.
//
// The send now carries an id of its own in `content_attributes`, so the read-back asks for THAT
// message rather than for those words.
describe("deliverReply: a send that proves itself by name (issue #499)", () => {
  // Personifies the fork as measured against it (chatwoot-pro, `Messages::MessageBuilder`):
  // `content_attributes` given to the create is persisted verbatim and comes back on the read.
  function identityStub(o: {
    // The far side accepted and STORED it, and only the response was lost — the shape the error
    // type cannot distinguish from a write that never happened.
    failOn: (n: number) => boolean;
    // Every read fails, which is the same overloaded Chatwoot that made the POST time out.
    readFails?: boolean;
    // Only the PRE-SEND read fails — the one the base tree makes to establish a boundary, whose
    // budget is the typing pause (1680ms for the reply in conversation 1445, against 10s for the
    // read-back that follows a failure). It is the half that breaks first under the load that
    // causes the timeout, and on the base tree its failure ALONE duplicates the reply:
    // `findLandedMessage` had no boundary, so it answered "not landed" without reading anything.
    // This tree makes no such read, so this option leaves it with nothing to fail.
    boundaryReadFails?: boolean;
    history?: string[];
  }) {
    let n = 0;
    let nextId = 100;
    const stored: Array<{
      id: number;
      content: string;
      sendId: string | null;
    }> = (o.history ?? ["oi"]).map((content) => ({
      id: nextId++,
      content,
      sendId: null,
    }));
    const client = {
      sendMessage: async (
        _c: number,
        content: string,
        opts?: { sendId?: string },
      ) => {
        n += 1;
        const id = nextId++;
        stored.push({ id, content, sendId: opts?.sendId ?? null });
        if (o.failOn(n)) throw new Error("chatwoot timeout");
        return { id };
      },
      getMessages: async (_c: number, q?: { before?: number }) => {
        if (o.readFails) throw new Error("chatwoot 500");
        // The PRE-SEND read, told apart by the only thing that distinguishes it: nothing has been
        // sent yet. On the base tree that is `readBoundary`; on this one there is no such read at
        // all, which is the point of the test that uses this.
        if (n === 0 && o.boundaryReadFails) {
          throw new Error("chatwoot 500 (boundary read)");
        }
        const upTo =
          q?.before === undefined
            ? stored
            : stored.filter((m) => m.id < (q.before as number));
        return {
          payload: upTo.map((m) => ({
            id: m.id,
            content: m.content,
            message_type: 1,
            private: false,
            content_attributes:
              m.sendId === null ? {} : { fazer_ai_send_id: m.sendId },
          })),
        };
      },
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;
    // WHAT THE CUSTOMER READS, which is the only thing this issue is about. Counted over what the
    // far side HOLDS, not over what the client believes it sent: the whole defect is the gap
    // between those two.
    const timesRead = (text: string): number =>
      stored.filter((m) => m.content.includes(text.trim())).length;
    return { client, stored, timesRead };
  }
  const noSleep = async () => {};
  const ONE = "Qual faixa de investimento você tá pensando?";

  // The issue itself. Every read fails, so the identity cannot be checked either — and the answer
  // to "I cannot prove it" must not be to send the whole reply a second time.
  test("a one-balloon reply is never sent twice, even when nothing can be proved", async () => {
    const s = identityStub({ failOn: (n) => n === 1, readFails: true });
    const out = await deliverReply(
      s.client,
      1,
      ONE,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(s.timesRead(ONE)).toBe(1);
    // Nothing could be proved, so the turn is told so: `runLoadedTurn` throws on this pair, which
    // is what writes `lastError` and the private note. The measured alternative was reporting
    // success while the customer read it twice.
    expect(out).toEqual({ delivered: 0, failed: true });
  });

  // The half that used to be missing: with no boundary at all (the FIRST send is the one that
  // failed), the base tree returned "not landed" without reading anything. The id is readable with
  // no boundary, so this now proves the delivery and sends nothing.
  test("the first send proves itself when the boundary read is the thing that failed", async () => {
    const s = identityStub({ failOn: (n) => n === 1, boundaryReadFails: true });
    const out = await deliverReply(
      s.client,
      1,
      ONE,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(s.timesRead(ONE)).toBe(1);
    expect(out).toEqual({ delivered: 1, failed: false });
  });

  // WHY AN ID AND NOT THE TEXT, on the one balloon where the text can never decide: the first.
  // Nothing has been sent yet, so the only boundary is the one the failed read was supposed to
  // bring — and a reply that says the same thing twice cannot be told apart without it. The base
  // tree resends both balloons here, so the customer reads the word a third time.
  test("two balloons of the same text cannot answer for each other", async () => {
    const s = identityStub({ failOn: (n) => n === 1, boundaryReadFails: true });
    const out = await deliverReply(
      s.client,
      1,
      "Certo!\n\nCerto!",
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // Exactly two: the one whose response was lost, proved by its id, and the second sent normally.
    expect(s.timesRead("Certo!")).toBe(2);
    expect(out).toEqual({ delivered: 2, failed: false });
  });

  // OUT OF PAGES IS UNKNOWN, NOT ABSENT. The walk has a ceiling, and reaching it means the message
  // was never found NOR ruled out — a conversation that moved faster than the read could page back.
  // Treating that as absence is the same collapse the whole issue is about, one exit deeper.
  test("running out of pages is unknown, not proof that nothing landed", async () => {
    const nextId = 100;
    const attempted: string[] = [];
    // Always a full page of strangers, so the walk never runs out of history and never matches.
    const client = {
      sendMessage: async (_c: number, content: string) => {
        attempted.push(content);
        throw new Error("chatwoot timeout");
      },
      getMessages: async (_c: number, q?: { before?: number }) => {
        const top = q?.before ?? nextId + 1000;
        return {
          payload: Array.from({ length: 20 }, (_v, k) => ({
            id: top - 1 - k,
            content: "conversa que andou",
            message_type: 1,
            private: false,
            content_attributes: {},
          })),
        };
      },
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;
    const out = await deliverReply(
      client,
      1,
      ONE,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // ONE attempt. Read as absence, the ceiling would put the reply back on the wire — which is
    // the duplicate, reached through the exit rather than through the read.
    expect(attempted).toEqual([ONE]);
    expect(out).toEqual({ delivered: 0, failed: true });
  });

  // THE CONSOLIDATED RETRY IS A SEND LIKE ANY OTHER, so it can also end unknown — and an unknown
  // retry is not a delivered one. Counting it would tell the caller the customer has an answer
  // nobody can show, which is `posted` on a conversation that may hold nothing.
  test("a retry that cannot be proved is not counted as delivered", async () => {
    const s = identityStub({ failOn: () => true, readFails: true });
    const out = await deliverReply(
      s.client,
      1,
      "Olá!\n\nComo vai?",
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // Balloon 1 unprovable and left out; the remainder sent and also unprovable.
    expect(out).toEqual({ delivered: 0, failed: true });
    expect(s.timesRead("Como vai?")).toBe(1);
  });

  // A DEGRADED LATER PAGE IS UNKNOWN, NOT THE TOP OF THE HISTORY. Reaching the end of the history is
  // what lets a read prove absence with no boundary to stop at, and the signature for it — an empty
  // list — is also what a body that is not a list at all, and a page whose rows are all unreadable,
  // both reduce to once parsed. Reading either as the end resends a chunk that may be sitting on
  // that very page: the same collapse this function exists to undo, one page deeper.
  //
  // The first read is already unknown on any empty answer, so the walk has to get PAST it: the
  // newest page carries strangers, and the degraded response is the one behind them.
  test.each([
    ["a body that is not a list", {}],
    ["a null body", null],
    ["a page whose rows are all unreadable", { payload: [{ nope: 1 }, {}] }],
    // The one that turned three shapes into one rule: a page that MOSTLY parsed. The entry that did
    // not could be the message being looked for, and a cursor taken from the rows that did parse
    // would walk straight past it.
    [
      "a page where only some rows are readable",
      {
        payload: [
          { id: 8999, content: "legível", message_type: 1, private: false },
          { nope: 1 },
        ],
      },
    ],
  ])(
    "a later page answering %s is unknown, not the end of the history",
    async (_label, second) => {
      const attempted: string[] = [];
      let page = 0;
      const client = {
        sendMessage: async (_c: number, content: string) => {
          attempted.push(content);
          throw new Error("chatwoot timeout");
        },
        getMessages: async (_c: number, q?: { before?: number }) => {
          page += 1;
          if (page > 1) return second;
          const top = q?.before ?? 9000;
          return {
            payload: Array.from({ length: 20 }, (_v, k) => ({
              id: top - 1 - k,
              content: "conversa que andou",
              message_type: 1,
              private: false,
              content_attributes: {},
            })),
          };
        },
        toggleTyping: async () => ({}),
      } as unknown as ChatwootClient;
      const out = await deliverReply(
        client,
        1,
        ONE,
        { ...SPLIT_DEFAULTS, enabled: true },
        noSleep,
      );
      // One attempt. Read as the end of the history, this would put the reply back on the wire.
      expect(attempted).toEqual([ONE]);
      expect(out).toEqual({ delivered: 0, failed: true });
    },
  );

  // THE CASE THAT MADE THE RULE, spelled out on its own because the table above cannot reach it: it
  // needs a boundary, and a boundary only exists once a send has succeeded. Balloon 1 lands and
  // gives one; balloon 2 times out with the message written; the read-back comes back with a page
  // whose readable rows reach BACK PAST that boundary — and one row it could not read, which is our
  // message. Proving absence off that page drops the chunk into the retry and duplicates it.
  test("an unreadable row on a page that reaches the boundary still blocks the proof", async () => {
    const sent: string[] = [];
    let n = 0;
    let nextId = 500;
    let firstSendId: number | null = null;
    const client = {
      sendMessage: async (_c: number, content: string) => {
        n += 1;
        const id = nextId++;
        if (n === 2) throw new Error("chatwoot timeout"); // escrita feita, resposta perdida
        sent.push(content);
        if (n === 1) firstSendId = id;
        return { id };
      },
      // Everything readable is OLDER than balloon 1, so the page reaches the boundary; the message
      // we are asking about is the entry that could not be read.
      getMessages: async () => ({
        payload: [
          { nope: "a mensagem que estamos procurando, ilegível" },
          {
            id: (firstSendId as number) - 1,
            content: "oi",
            message_type: 0,
            private: false,
          },
        ],
      }),
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;
    const out = await deliverReply(
      client,
      1,
      "Olá!\n\nComo vai?\n\nPosso ajudar?",
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // Balloon 2 must NOT be in the retry: it may be the row nothing could read.
    expect(sent).toEqual(["Olá!", "Posso ajudar?"]);
    expect(out).toEqual({ delivered: 2, failed: true });
  });

  // The other side of that rule, so "degraded" cannot become "every empty page": a WELL-FORMED empty
  // list on a later page IS the top of the history. Without this the walk could never prove absence
  // with no boundary, and a send that genuinely failed on the first balloon would never be resent.
  test("a well-formed empty later page is the end of the history, and the chunk is resent", async () => {
    const attempted: string[] = [];
    let page = 0;
    const client = {
      sendMessage: async (_c: number, content: string) => {
        attempted.push(content);
        if (attempted.length === 1) throw new Error("chatwoot timeout");
        return { id: 1 };
      },
      getMessages: async (_c: number, q?: { before?: number }) => {
        page += 1;
        if (page > 1) return { payload: [] };
        const top = q?.before ?? 9000;
        return {
          payload: Array.from({ length: 20 }, (_v, k) => ({
            id: top - 1 - k,
            content: "conversa que andou",
            message_type: 1,
            private: false,
            content_attributes: {},
          })),
        };
      },
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;
    const out = await deliverReply(
      client,
      1,
      ONE,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    // Proved absent, so the reply is owed and goes again — nothing can be duplicated by sending a
    // message that is not there.
    expect(attempted).toEqual([ONE, ONE]);
    expect(out).toEqual({ delivered: 1, failed: false });
  });

  // A SPENT BUDGET IS UNKNOWN TOO, and this is the exit an overloaded Chatwoot actually takes: the
  // read does answer, just too slowly to walk far enough. Read as absence it resends, which is the
  // duplicate of issue #499 reached through the clock instead of through an error.
  //
  // Ten seconds of real time, because the budget is a wall-clock constant and nothing in this path
  // takes an injectable one. Paid once, for the exit that the incident's own conditions produce.
  test("a budget spent mid-walk is unknown, not proof that nothing landed", async () => {
    const attempted: string[] = [];
    let page = 0;
    const client = {
      sendMessage: async (_c: number, content: string) => {
        attempted.push(content);
        throw new Error("chatwoot timeout");
      },
      getMessages: async (_c: number, q?: { before?: number }) => {
        page += 1;
        // The FIRST page eats the whole budget, so the second is entered with nothing left.
        if (page === 1) await new Promise((r) => setTimeout(r, 10_050));
        const top = q?.before ?? 9000;
        return {
          payload: Array.from({ length: 20 }, (_v, k) => ({
            id: top - 1 - k,
            content: "conversa que andou",
            message_type: 1,
            private: false,
            content_attributes: {},
          })),
        };
      },
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;
    const out = await deliverReply(
      client,
      1,
      ONE,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(attempted).toEqual([ONE]);
    expect(out).toEqual({ delivered: 0, failed: true });
  }, 20_000);

  // THE READ-BACK'S BUDGET IS SHARED ACROSS ITS PAGES, so a conversation that needs three of them
  // is not three times the wait: each page is handed what is LEFT of one deadline, never a fresh
  // one. Asserted on the timeouts the client receives, because that is where the sharing shows.
  test("every page of a read-back spends the same one budget", async () => {
    const timeouts: number[] = [];
    const nextId = 500;
    const client = {
      sendMessage: async () => {
        throw new Error("chatwoot timeout");
      },
      getMessages: async (_c: number, q?: { before?: number }, ms?: number) => {
        if (ms !== undefined) timeouts.push(ms);
        // Real wall clock, and the reason the assertion below can be strict: pages that return in
        // the same millisecond spend nothing, and a shared budget is indistinguishable from a fresh
        // one until time actually passes.
        await new Promise((r) => setTimeout(r, 2));
        const top = q?.before ?? nextId + 1000;
        return {
          payload: Array.from({ length: 20 }, (_v, k) => ({
            id: top - 1 - k,
            content: "conversa que andou",
            message_type: 1,
            private: false,
            content_attributes: {},
          })),
        };
      },
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;
    await deliverReply(
      client,
      1,
      ONE,
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(timeouts.length).toBeGreaterThan(1);
    // Strictly decreasing: a fresh deadline per page would hand out the same number every time.
    for (let k = 1; k < timeouts.length; k += 1) {
      expect(timeouts[k] as number).toBeLessThan(timeouts[k - 1] as number);
    }
    expect(timeouts[0] as number).toBeLessThanOrEqual(10_000);
  });

  // THE CHUNK THAT COULD NOT BE PROVED IS NEVER RESENT. It is the one message that may already be
  // on the far side, so including it is the duplication; everything after it is owed for certain.
  test("an unprovable chunk is left out of the retry, and the rest still goes", async () => {
    const s = identityStub({ failOn: (n) => n === 2, readFails: true });
    const out = await deliverReply(
      s.client,
      1,
      "Olá!\n\nComo vai?\n\nPosso ajudar?",
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(s.timesRead("Como vai?")).toBe(1);
    expect(s.timesRead("Posso ajudar?")).toBe(1);
    // Balloon 1 and the consolidated remainder. `failed` because balloon 2 is unaccounted for, and
    // that is what puts the partial badge on the conversation.
    expect(out).toEqual({ delivered: 2, failed: true });
  });
});
