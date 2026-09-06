import logger from "@/api/lib/logger";
import {
  ChatwootApiError,
  type ChatwootClient,
  ChatwootMissingTokenError,
} from "@/modules/chatwoot/client";
import {
  chatwootMessageListLength,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";

// Humanized delivery: split the agent's reply into several balloons and pace them with a typing
// indicator + a proportional delay, instead of dumping one wall of text (the n8n "Quebrar e enviar
// mensagens" behavior). Pure helpers (splitReply / typingDelayMs) + a deliverReply loop that the
// runtime calls for TEXT replies (audio replies are a single voice note). Config is per-agent.

export interface SplitConfig {
  enabled: boolean;
  // Paragraphs longer than this are further split on sentence boundaries.
  maxChars: number;
  // Words-per-minute used to size the typing delay before each balloon.
  typingWpm: number;
  minDelayMs: number;
  maxDelayMs: number;
  // Safety cap on the number of balloons (extra content is merged into the last).
  maxChunks: number;
}

export const SPLIT_DEFAULTS: SplitConfig = {
  // On by default: replying in a few shorter messages with a brief typing pause reads as more
  // human (n8n parity). The added latency is small and bounded by maxDelayMs; opt-out per agent.
  enabled: true,
  maxChars: 600,
  // ~250 wpm: a brisk, natural typing cadence (the pause stays well under maxDelayMs).
  typingWpm: 250,
  minDelayMs: 800,
  maxDelayMs: 8000,
  maxChunks: 6,
};

function clampInt(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.round(v), min), max);
}

export function readSplitConfig(settings: unknown): SplitConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).split
      : undefined;
  if (!s || typeof s !== "object") return { ...SPLIT_DEFAULTS };
  const bag = s as Record<string, unknown>;
  const maxChars = clampInt(bag.maxChars, 80, 4000, SPLIT_DEFAULTS.maxChars);
  return {
    enabled:
      typeof bag.enabled === "boolean" ? bag.enabled : SPLIT_DEFAULTS.enabled,
    maxChars,
    typingWpm: clampInt(bag.typingWpm, 40, 1000, SPLIT_DEFAULTS.typingWpm),
    minDelayMs: clampInt(bag.minDelayMs, 0, 10_000, SPLIT_DEFAULTS.minDelayMs),
    maxDelayMs: clampInt(bag.maxDelayMs, 0, 30_000, SPLIT_DEFAULTS.maxDelayMs),
    maxChunks: clampInt(bag.maxChunks, 1, 12, SPLIT_DEFAULTS.maxChunks),
  };
}

// WHAT STOOD BETWEEN TWO BALLOONS IN THE TEXT THE MODEL WROTE, carried beside the chunks because
// splitting throws it away and two callers have to put the text back together: the overflow merge
// below, and the consolidated retry in `deliverReply`. Rejoining with a fixed "\n\n" delivers a
// paragraph the model wrote as ONE broken into two — a silent edit of the agent's own words, in the
// direction the customer reads.
export interface ReplyParts {
  chunks: string[];
  // `seps[i]` is the EXACT whitespace that preceded `chunks[i]` in the original; `seps[0]` is "".
  // Captured rather than classified: a category ("paragraph break" → "\n\n", "sentence" → " ")
  // restores a plausible delimiter and not the real one, so `"Intro.\n- item"` comes back as
  // `"Intro. - item"` and a Markdown list is flattened into a sentence.
  seps: string[];
}

// Split into balloons: by paragraph (blank line), then any over-long paragraph by sentence, then cap
// the count (extra balloons merged into the last). Always returns at least one non-empty chunk.
export function splitReplyParts(text: string, cfg: SplitConfig): ReplyParts {
  const trimmed = text.trim();
  if (!trimmed) return { chunks: [], seps: [] };
  // Both splits use a CAPTURING group, so the delimiters come back interleaved with the pieces and
  // the original can be reassembled exactly. Without the capture the whitespace is consumed and
  // gone, and every rejoin downstream is a guess about what the model wrote.
  const paraParts = trimmed.split(/(\n{2,})/);
  const chunks: string[] = [];
  const seps: string[] = [];
  const push = (chunk: string, sep: string): void => {
    seps.push(chunks.length === 0 ? "" : sep);
    chunks.push(chunk);
  };
  for (let pi = 0; pi < paraParts.length; pi += 2) {
    const p = (paraParts[pi] ?? "").trim();
    // What separated this paragraph from the previous one — the run of newlines the model typed,
    // which is not always exactly two.
    const paraSep = pi === 0 ? "" : (paraParts[pi - 1] ?? "\n\n");
    if (!p) continue;
    if (p.length <= cfg.maxChars) {
      push(p, paraSep);
      continue;
    }
    // Over-long paragraph → accumulate sentences up to maxChars. Everything this loop emits after
    // its first chunk continues the SAME paragraph, so it rejoins with the whitespace that stood
    // between those two sentences — a space, a newline before a list item, whatever it was.
    const sentParts = p.split(/((?<=[.!?…])\s+)/);
    let buf = "";
    let pendingSep = paraSep;
    let bufSep = paraSep;
    for (let si = 0; si < sentParts.length; si += 2) {
      const sentence = sentParts[si] ?? "";
      const before = si === 0 ? "" : (sentParts[si - 1] ?? " ");
      const next = buf ? `${buf}${before}${sentence}` : sentence;
      if (next.length > cfg.maxChars && buf) {
        push(buf, bufSep);
        // The whitespace that stood between the chunk just emitted and the one starting now.
        bufSep = before;
        buf = sentence;
      } else {
        buf = next;
      }
      pendingSep = bufSep;
    }
    if (buf) push(buf, pendingSep);
  }
  if (chunks.length === 0) return { chunks: [trimmed], seps: [""] };
  if (chunks.length <= cfg.maxChunks) return { chunks, seps };
  // Merge the overflow into the last allowed balloon, with the separators the text actually had.
  const keep = cfg.maxChunks - 1;
  const tail = chunks
    .slice(keep)
    .reduce((acc, c, k) => (k === 0 ? c : acc + seps[keep + k] + c), "");
  return {
    chunks: [...chunks.slice(0, keep), tail],
    seps: [...seps.slice(0, keep), seps[keep] ?? ""],
  };
}

// The chunks alone, for every caller that only sends them in order and never rejoins.
export function splitReply(text: string, cfg: SplitConfig): string[] {
  return splitReplyParts(text, cfg).chunks;
}

export function typingDelayMs(chunk: string, cfg: SplitConfig): number {
  const words = chunk.split(/\s+/).filter(Boolean).length;
  const ms = (words / cfg.typingWpm) * 60_000;
  return Math.min(Math.max(Math.round(ms), cfg.minDelayMs), cfg.maxDelayMs);
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// WHAT REACHED THE CUSTOMER, which is not a single bit — the same three-answers rule
// `deliverPendingAttachments` follows (../../graph/runtime.ts), for the same reason: "nothing was
// delivered" answers more than one question and the caller acts differently on each.
export interface ReplyDelivery {
  // How many messages actually landed in the conversation. The caller keys "the customer was
  // answered" off this, and the console holds a "delivering" indicator until it arrives.
  delivered: number;
  // A send failed AND the remainder's one retry failed too, so part of the reply is missing. A run
  // called off mid-split is NOT this: nothing was attempted after the fence, by decision — reported
  // as a failure, a /reset landing between two balloons would put `lastError` back on the
  // conversation it had just cleared.
  failed: boolean;
  // AT LEAST ONE SEND CANNOT BE ACCOUNTED FOR: it was rejected, and Chatwoot could not be asked
  // whether it landed. It may be in the conversation and it may not, and the caller has to know the
  // difference from a clean `failed` (issue #499).
  //
  // What rides on it is whether the TURN may run again. `delivered: 0, failed: true` makes
  // `runLoadedTurn` throw, and a throw is what eventually puts the ledger row `DEAD` and hands it to
  // the delivery recovery, which re-runs the whole turn — model, tools and all — half an hour later
  // (../chatwoot/recover-delivery.ts states this as a property of its design). That is right when
  // nothing landed and we KNOW it: the customer is owed an answer. It is wrong when we do not know,
  // because the side effects the turn already committed would fire a second time over a message
  // that may well have arrived. The report has to carry which of the two it is.
  unproven: boolean;
}

// Sends the reply, split + paced when enabled. Typing toggles are best-effort (admin-token, may be
// unsupported on a channel) and never block the send. The sleep is injectable for tests.
//
// THE UNIT OF DELIVERY IS THE REPLY, NOT THE BALLOON (issue #429), and it is the split that makes
// the question exist: a one-balloon reply either lands or does not, while N sends separated by a
// typing pause give a transient Chatwoot failure N-1 windows to land INSIDE the answer — and the
// window is as wide as the reply is long, because `typingDelayMs` is deliberately proportional to
// the chunk. What that leaves is not a failed send. It is a customer holding half an answer.
//
// So a failure past the first landed balloon NEVER throws, and the asymmetry is the whole design:
//
//   nothing landed   A real turn failure, reported as `failed` with `delivered: 0`. The caller
//                    throws on it, the operator is told, and the recovery (#295) re-runs the turn —
//                    safe precisely because the customer received nothing that could duplicate.
//   something landed  A throw here discards `delivered`, the count that exists to report what the
//                    customer received, and hands the whole reply back to the recovery, which runs
//                    the turn again: the balloons that already arrived are sent a SECOND time and
//                    every side-effecting tool the turn chose runs again. Returning instead settles
//                    the ledger row as answered, which is what closes that path.
//
// The remainder is retried ONCE, consolidated into a single send, and that is the same rule read
// from the customer's side: they get the whole answer rather than a truncated one, and no balloon
// they already have is sent again. Per-chunk durable state was the alternative and buys nothing
// here — the chunks are still in memory in this very process, so the only thing it would add is
// resuming after a process death, which is the recovery's job and not this loop's.
export async function deliverReply(
  client: ChatwootClient,
  conversationId: number,
  reply: string,
  cfg: SplitConfig,
  sleep: (ms: number) => Promise<void> = realSleep,
  flow?: FlowContext,
  // Asked before EACH balloon. A split reply is several sends with a typing pause between them, so
  // one answer taken before the loop covers only the first: a run called off after balloon two would
  // keep typing the rest into a conversation the operator was told had been cleared. Returns how
  // many actually landed, so the caller still reports what the customer received.
  calledOff: () => Promise<boolean> = async () => false,
  // THE NEWEST MESSAGE THAT EXISTED BEFORE THIS REPLY, when the caller knows one — the customer
  // message this turn is answering (issue #499). Anything this reply writes is newer than it, so it
  // is the point past which the read-back stops looking.
  //
  // Without it, the FIRST send failing has nothing to stop at: a conversation with a hundred
  // messages of history fills all five pages with rows that were there before, and the walk runs out
  // of pages and answers `unknown` — which now means the chunk is dropped and the reply never
  // arrives. It costs no read, unlike the pre-send `readBoundary` this replaces: the caller already
  // holds the id.
  anchor: number | null = null,
): Promise<ReplyDelivery> {
  return withFlowStage(
    flow,
    "split",
    {
      detail: { enabled: cfg.enabled },
      // The numbers only exist once the loop returned, and they are the line an operator reads to
      // find out why a customer got half an answer — the stage no longer throws, so without this it
      // would report `ok` and say nothing about it.
      detailOf: (out) => ({ delivered: out.delivered, failed: out.failed }),
    },
    async () => {
      if (!cfg.enabled) {
        const sendId = crypto.randomUUID();
        try {
          await client.sendMessage(conversationId, reply, { sendId });
          return { delivered: 1, failed: false, unproven: false };
        } catch (e) {
          // ASKED HERE TOO. There is no remainder to salvage on this path, so nothing is ever
          // resent — but the answer still decides whether the TURN may run again, and that question
          // does not depend on how many balloons the reply was split into. A rejection nobody
          // checked used to be reported as unaccounted for, which settles the burst and retires the
          // delivery on a reply that may never have been written.
          const verdict = await accountForRejectedSend(
            client,
            conversationId,
            sendId,
            // The caller's anchor is all there is here: nothing has been sent on this path before
            // now, so no completed send can supply one.
            anchor,
            e,
            flow,
          );
          if (verdict.known && verdict.id !== null) {
            return { delivered: 1, failed: false, unproven: false };
          }
          return { delivered: 0, failed: true, unproven: !verdict.known };
        }
      }
      const { chunks, seps } = splitReplyParts(reply, cfg);
      let delivered = 0;
      let failed = false;
      let unproven = false;
      // HOW FAR BACK A READ-BACK HAS TO LOOK, and nothing more. It is fed only by sends that
      // returned an id, so it costs no read of its own — which is the whole difference from what
      // stood here before (issue #499). A dedicated `readBoundary` used to run on the SUCCESSFUL
      // path to establish it, bounded by the typing pause because an unbounded read would tax every
      // reply that never fails; and that budget (1680ms for the reply in conversation 1445) is the
      // first thing an overloaded Chatwoot misses. When it did, the reconciliation answered "not
      // landed" without reading anything, and the retry sent the reply again.
      //
      // Now identity decides and this only bounds cost: null simply means the read-back pages to
      // its own ceiling instead of stopping early. Correctness no longer depends on it.
      let boundary: number | null = anchor;
      // THE ONE PLACE A DELIVERY IS RECORDED, because there are four ways to learn of one — a send
      // that returned, a rejected send the read-back found, and the same two for the consolidated
      // retry — and each is also a new boundary. Two of them used to count without moving it, which
      // left a stale value answering the next read: with chunks `A / B / B`, the middle `B` landing
      // under a rejection made the FINAL `B` match it and report as delivered when it never was.
      //
      // NOTE: on the two retry call sites the advance has no reader — the retry is the last act of
      // the loop and `break` follows it — and the mutation that drops the id there kills no test,
      // measured. They pass it anyway because the value here is that "delivered" has ONE spelling:
      // a confirmer that has to remember the boundary separately is the confirmer that forgets, and
      // this loop has already grown two of them.
      const noteDelivered = (id: number | null): void => {
        delivered += 1;
        if (id !== null && (boundary === null || id > boundary)) boundary = id;
      };
      try {
        for (const [i, chunk] of chunks.entries()) {
          // Asked BEFORE the typing indicator as well as before the send (issue #209 review,
          // round 9): the indicator is customer-facing too, and a run called off during the
          // previous balloon's send would otherwise show it once more before standing down. The
          // first balloon is covered by the caller's own ask, one statement before this loop.
          if (i > 0 && (await calledOff())) break;
          await client
            .toggleTyping(conversationId, true)
            .catch(() => undefined);
          await sleep(typingDelayMs(chunk, cfg));
          if (await calledOff()) break;
          // NAMED BEFORE IT LEAVES, because a name is only useful if it exists on the attempt that
          // fails: the send that times out never returns anything, so the id has to travel out with
          // the request rather than come back with the response.
          const sendId = crypto.randomUUID();
          try {
            const res = await client.sendMessage(conversationId, chunk, {
              sendId,
            });
            noteDelivered(createdMessageId(res));
          } catch (e) {
            // A REJECTED SEND DOES NOT MEAN AN UNDELIVERED ONE. The request has a 15s deadline
            // (`AbortSignal.timeout` in ../chatwoot/client.ts), and a timeout — or a response whose
            // body could not be read — rejects here with the message already written on the far
            // side. Retrying that blindly is the duplication this whole change exists to prevent,
            // just moved one layer down and made likelier: an overloaded Chatwoot is exactly when
            // both the timeout and the retry happen.
            //
            // The type of the error cannot settle it either. A 502 comes from a proxy that may or
            // may not have forwarded the request, and a 500 is Chatwoot failing at an unknown point
            // in its own transaction. So this asks the only party that knows: it READS the
            // conversation back and looks for the chunk. Costly, and only on a path that is already
            // the exception.
            const verdict = await accountForRejectedSend(
              client,
              conversationId,
              sendId,
              boundary,
              e,
              flow,
            );
            if (verdict.known && verdict.id !== null) noteDelivered(verdict.id);
            // ASKED AGAIN, and after the reconciliation rather than before it. The failed request
            // burned up to 15 seconds and the read above is more I/O, so the answer taken before
            // the first send is about a moment that is long gone — and the rule this file follows
            // (../../graph/nudge.ts) is one ask per stretch of I/O preceding a write, with no I/O
            // between the ask and the write it guards. A `/reset` landing in that stretch is the
            // operator clearing the conversation, so what follows is a stand-down and NOT a failure:
            // reported as one it would put `lastError` back on what they just cleared.
            if (await calledOff()) break;
            // WHAT THE CHUNK ITSELF IS OWED, decided by which of the three answers came back, and
            // the middle one is the whole of issue #499:
            //
            //   landed    → the customer has it. Not resent, and counted as delivered.
            //   absent    → read far enough back to be sure it is not there. Resent, because
            //               nothing can be duplicated by sending a message that does not exist.
            //   unknown   → the conversation could not be read. LEFT OUT, and the reply comes up
            //               short and says so.
            //
            // The base tree spelled `absent` and `unknown` the same way and resent on both. That is
            // the duplicate two customers received: an overloaded Chatwoot loses the POST's
            // response and the read-back in one go, so the case that cannot be told apart is
            // precisely the case that arises.
            //
            // Resending on `unknown` was defended on the two errors being asymmetric — a resend
            // "costs one duplicated balloon the customer and the operator can both see". Measured,
            // the operator sees nothing: the loop reported `delivered: 1, failed: false` while the
            // customer read the reply twice. A gap, by contrast, IS reported: `failed` is the
            // partial badge on the conversation, and `lastError` when nothing landed at all.
            // Between an invisible duplicate and a visible gap, the gap wins.
            //
            // Everything still owed goes as ONE message. Not a re-walk of the remaining balloons: a
            // second pass would give the same transient failure the same N windows to land in, and
            // the pacing that makes a reply read as human is worth less than the reply arriving
            // whole.
            if (!verdict.known) {
              failed = true;
              unproven = true;
            }
            const from = verdict.known && verdict.id === null ? i : i + 1;
            const owed = chunks
              .slice(from)
              .reduce(
                (acc, c, k) => (k === 0 ? c : acc + seps[from + k] + c),
                "",
              );
            if (!owed) break;
            // The retry is a send like any other, so it names itself like any other: it carries the
            // same 15s deadline and can be rejected after being accepted in exactly the same way.
            const retrySendId = crypto.randomUUID();
            try {
              noteDelivered(
                createdMessageId(
                  await client.sendMessage(conversationId, owed, {
                    sendId: retrySendId,
                  }),
                ),
              );
            } catch (retryErr) {
              // THE SAME QUESTION, asked of the same party. This send has the deadline the first one
              // had, so a rejection here is just as ambiguous — and reporting `failed` with nothing
              // else delivered is what makes `runLoadedTurn` throw, which runs the whole turn again
              // and posts a second copy of a reply the customer already has. The reconciliation is
              // not a property of the first attempt; it belongs to every send that can be rejected
              // after being accepted.
              const retryVerdict = await accountForRejectedSend(
                client,
                conversationId,
                retrySendId,
                boundary,
                retryErr,
                flow,
              );
              if (retryVerdict.known && retryVerdict.id !== null) {
                noteDelivered(retryVerdict.id);
                // ASKED ONE LAST TIME, and for the third stretch of I/O in this catch: the retry
                // itself and its read-back. The rule is the same one the ask above follows
                // (../../graph/nudge.ts) and the LAST stretch is the one that was missing — with
                // nothing delivered, `failed` is what makes the caller throw, and a throw after a
                // `/reset` puts `lastError` back on the conversation the operator had just cleared.
                // Standing down is not a failure, here as everywhere else in this loop.
              } else if (!(await calledOff())) {
                failed = true;
                // Same rule as the balloon above, for the retry's own read-back: only a proven
                // absence leaves the report clean enough for the turn to be run again.
                if (!retryVerdict.known) unproven = true;
              }
            }
            break;
          }
        }
      } finally {
        // In a `finally` because the loop above can now leave by a failure as well as by the fence.
        // Skipped, the customer watches the agent "type" a reply that is never coming — and the
        // indicator is per conversation, so nothing later clears it either.
        await client.toggleTyping(conversationId, false).catch(() => undefined);
      }
      return { delivered, failed, unproven };
    },
  );
}

// DID THE CHUNK REACH THE CUSTOMER, asked of Chatwoot rather than inferred from the error.
//
// Reading the conversation back is the only thing that separates "the POST never landed" from "the
// POST landed and the response did not come back", and those two need opposite handling: one owes
// the customer a resend, the other owes them silence.
//
// IT ASKS FOR A NAME, NOT FOR WORDS. The send carries its own id out with the request
// (`CHATWOOT_SEND_ID_KEY`, ../chatwoot/constants.ts) and the fork echoes it back on the read, so
// this looks for THAT message rather than for a message that says the same thing.
//
// Content used to be all there was, because a send that fails never returns an id — and content is
// not an identity: a conversation legitimately holds the same words twice, an earlier "Olá!" or the
// balloon this very reply sent two sends ago. Repairing that took a boundary, the boundary took a
// read of its own on the SUCCESSFUL path, and that read had to be kept short so it would not tax
// every reply that never fails. An overloaded Chatwoot misses a short read, and an overloaded
// Chatwoot is the whole population of this function's callers: the proof failed exactly when it was
// needed, and the resend that followed is the duplicate two customers received (issue #499).
//
// `after` survives as a COST bound and nothing else — it is the oldest id worth paging back to, fed
// only by sends that already returned one. Null means page to the ceiling, not "cannot prove".
//
// Fails CLOSED, and what that now means is the opposite of what it meant: an unreadable
// conversation answers "not landed", and the caller LEAVES THAT CHUNK OUT of the retry rather than
// putting it back in. The reply comes up short and says so, instead of arriving twice and
// reporting success.
// The whole read-back, across however many pages it takes, costs what ONE `getMessages` already
// cost: the per-request deadline is what is left of this budget, so a conversation that needs three
// pages is not three times the wait. Beyond it the answer is unknown, which leaves the chunk out.
const READBACK_BUDGET_MS = 10_000;
// A ceiling on the pathological case rather than a real expectation. The window this reads against
// is between a rejected POST and the very next statement, so filling one page takes ~20 inbound
// messages in that instant; five pages is a hundred, and past that the conversation is not one this
// reconciliation can say anything useful about.
const READBACK_MAX_PAGES = 5;
// Chatwoot's page size for a conversation's messages, read the same way `debounce/handler.ts` reads
// it: a page that comes back shorter is the conversation's first, so nothing older can be hiding
// behind it.
const CHATWOOT_MESSAGES_PAGE = 20;

// THREE ANSWERS, NOT TWO, and collapsing the last two is the defect (issue #499). "I read the
// conversation and this message is not there" and "I could not read the conversation" are opposite
// facts that the base tree both spelled `null`, and the caller treated both as "resend".
//
// This repo already states the rule elsewhere in this very file's history — no rows is UNKNOWN, not
// zero — and this is the site where it was not applied.
type LandedVerdict =
  // Chatwoot holds it. The id comes back because it is also the oldest point a later read-back on
  // this same reply needs to page to.
  | { known: true; id: number }
  // Chatwoot was read, far enough back to be sure, and does not hold it. Nothing landed, so
  // resending it is safe and is what the customer is owed.
  | { known: true; id: null }
  // The conversation could not be read, or not read far enough. The message may or may not be
  // there, and this is the ONE case where the send is neither confirmed nor safe to repeat.
  | { known: false };

// STATUSES CHATWOOT ANSWERS WITHOUT HAVING WRITTEN A MESSAGE. Authentication and authorization are
// decided before the controller runs, and 404 and 422 are the route and the payload being refused —
// in none of them does a row exist on the far side.
//
// 5xx is deliberately NOT here, and neither is 429. A 500 is Chatwoot failing at an unknown point in
// its own transaction and a 502 is a proxy that may or may not have forwarded the request, which is
// the whole reason this function exists; a 429 can be answered by a proxy after the write. The list
// is what is definitively pre-create, never what is merely likely.
const PRE_CREATE_STATUSES = new Set([400, 401, 403, 404, 405, 422]);

function isPreCreateStatus(status: number): boolean {
  return PRE_CREATE_STATUSES.has(status);
}

// WHAT A REJECTED SEND MEANS, asked in ONE place so the two delivery paths cannot answer it
// differently (issue #499). Splitting on or off, the question is the same — did those words reach
// the customer? — and the path with no remainder to salvage used to skip it entirely, reporting
// every rejection as unaccounted for.
async function accountForRejectedSend(
  client: ChatwootClient,
  conversationId: number,
  sendId: string,
  after: number | null,
  err: unknown,
  flow: FlowContext | undefined,
): Promise<LandedVerdict> {
  reportFailedSend(flow, conversationId, err);
  // A REJECTION THAT COULD NOT HAVE CREATED A MESSAGE IS A PROVEN ABSENCE, not an ambiguous one.
  // Ambiguity has one source: the request may have been served before the response was lost. Two
  // families cannot have been.
  //
  // Reading either as unknown is expensive now that unknown means "do not resend": the turn reports
  // `posted-partial`, settles the burst and retires the delivery as answered, with nothing sent and
  // nothing ever retrying. A credential that expired would silently stop answering customers.
  if (err instanceof ChatwootMissingTokenError)
    return { known: true, id: null };
  if (err instanceof ChatwootApiError && isPreCreateStatus(err.status))
    return { known: true, id: null };
  return findLandedMessage(client, conversationId, sendId, after);
}

async function findLandedMessage(
  client: ChatwootClient,
  conversationId: number,
  sendId: string,
  after: number | null,
): Promise<LandedVerdict> {
  const deadline = Date.now() + READBACK_BUDGET_MS;
  let before: number | undefined;
  try {
    for (let page = 0; page < READBACK_MAX_PAGES; page += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { known: false };
      const raw = await client.getMessages(
        conversationId,
        before === undefined ? undefined : { before },
        remaining,
      );
      // HOW MANY MESSAGES CAME BACK, asked of the response rather than of the parsed rows, because
      // the parser folds three different answers into one empty array: a page that really is empty,
      // a body that was not a list at all, and a full page whose rows were all unreadable. Only the
      // first is an answer; the other two are a degraded read.
      const carried = chatwootMessageListLength(raw);
      const rows = parseChatwootMessages(raw);
      // FOUND IS FOUND, and it is asked FIRST — before anything about the page's quality. The id was
      // minted for this send alone, so a row carrying it IS the message, whatever its neighbours
      // are: a page that also holds one entry this build could not read still proves delivery if the
      // one we are looking for is on it. Asking about the page first would report a rejected-but-
      // delivered send as unaccounted for, badge and all.
      //
      // No boundary, no `private`, no `message_type`: those were narrowing a match on CONTENT, and a
      // name cannot be worn by somebody else's message.
      const hit = rows.find((m) => m.sendId === sendId);
      if (hit !== undefined) return { known: true, id: hit.id };
      // ABSENCE, THOUGH, MAY ONLY REST ON A PAGE THAT WAS READ WHOLE — the rule three review rounds
      // arrived at one case at a time: a body that is not a list, a page whose rows were all
      // unreadable, a page where only SOME rows were. They are not three cases. An entry this build
      // could not name is an entry that might be the message, so a page holding even one of them
      // rules nothing out. `null` needs no arm of its own: a response that was not a list can never
      // equal a row count, and a mutation battery is what showed spelling it out was a dominated
      // term rather than a second rule.
      const readWhole = rows.length === carried;
      if (!readWhole) return { known: false };
      // A PAGE SHORTER THAN CHATWOOT'S IS THE TOP OF THE HISTORY, which is how absence gets proved
      // without walking to an empty page. `debounce/handler.ts` reads the endpoint the same way
      // ("a page shorter than Chatwoot's is the conversation's first"). Asking for one more page
      // costs a request that can FAIL, and a failure there would turn a proved absence into
      // `unknown` — the chunk dropped from a reply that was genuinely owed.
      //
      // An empty FIRST page is the exception, and stays unknown: a conversation we have just written
      // to cannot really be empty, so nothing there is a degraded read. It is the same verdict
      // `recoverDelivery` reaches on its own anchored read, for the same reason.
      if (rows.length === 0 && before === undefined) return { known: false };
      if (rows.length < CHATWOOT_MESSAGES_PAGE)
        return { known: true, id: null };
      const oldest = rows.reduce(
        (min, m) => (m.id < min ? m.id : min),
        rows[0]?.id ?? 0,
      );
      // FAR ENOUGH BACK TO BE SURE, which is what turns silence into an answer. Chatwoot answers
      // with the newest ~20, so a conversation that moved more than a page between the timed-out
      // POST and this read pushes our message off it, and "absent from the newest twenty" is not
      // absence. Two things end the walk with certainty: reaching a send this same loop already
      // completed, since nothing older can carry an id minted after it, or running out of history
      // altogether (the empty page above).
      if (after !== null && oldest <= after) return { known: true, id: null };
      before = oldest;
    }
    // Out of pages without ever reaching a point that proves absence.
    return { known: false };
  } catch (e) {
    logger.warn(
      "split: could not read the conversation back after a failed send (conv=%s): %s",
      String(conversationId),
      e instanceof Error ? e.message : String(e),
    );
    return { known: false };
  }
}

// The id Chatwoot assigned to a message we just created, so the boundary can advance past a balloon
// this very reply sent. Without it, two identical balloons in one reply make the first answer for
// the second.
function createdMessageId(res: unknown): number | null {
  if (typeof res !== "object" || res === null) return null;
  const id = (res as { id?: unknown }).id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

// A send that did not get through, on the one path that no longer reports it by throwing. Warn and
// not error: whether the turn failed is decided by what landed overall, and the caller is the only
// one that can see that.
function reportFailedSend(
  flow: FlowContext | undefined,
  conversationId: number,
  e: unknown,
): void {
  const msg = e instanceof Error ? e.message : String(e);
  logger.warn(
    "split: balloon send failed (conv=%s): %s",
    String(conversationId),
    msg,
  );
  if (flow)
    emitFlowEvent(flow, {
      stage: "split",
      level: "warn",
      status: "error",
      detail: { outcome: "send_failed" },
      errorMessage: msg,
    });
}
