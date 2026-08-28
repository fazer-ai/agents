import logger from "@/api/lib/logger";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { parseChatwootMessages } from "@/modules/chatwoot/messages";
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
        try {
          await client.sendMessage(conversationId, reply);
          return { delivered: 1, failed: false };
        } catch (e) {
          // One send and nothing landed, which is the `delivered: 0` case: reported rather than
          // thrown so this branch and the split one answer the caller the same way, and the caller
          // keeps the single decision about what a total failure means.
          reportFailedSend(flow, conversationId, e);
          return { delivered: 0, failed: true };
        }
      }
      const { chunks, seps } = splitReplyParts(reply, cfg);
      let delivered = 0;
      let failed = false;
      try {
        for (const [i, chunk] of chunks.entries()) {
          await client
            .toggleTyping(conversationId, true)
            .catch(() => undefined);
          await sleep(typingDelayMs(chunk, cfg));
          if (await calledOff()) break;
          try {
            await client.sendMessage(conversationId, chunk);
            delivered += 1;
          } catch (e) {
            reportFailedSend(flow, conversationId, e);
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
            const landed = await chunkAlreadyLanded(
              client,
              conversationId,
              chunk,
            );
            if (landed) delivered += 1;
            // ASKED AGAIN, and after the reconciliation rather than before it. The failed request
            // burned up to 15 seconds and the read above is more I/O, so the answer taken before
            // the first send is about a moment that is long gone — and the rule this file follows
            // (../../graph/nudge.ts) is one ask per stretch of I/O preceding a write, with no I/O
            // between the ask and the write it guards. A `/reset` landing in that stretch is the
            // operator clearing the conversation, so what follows is a stand-down and NOT a failure:
            // reported as one it would put `lastError` back on what they just cleared.
            if (await calledOff()) break;
            // Everything still owed, as ONE message. Not a re-walk of the remaining balloons: a
            // second pass would give the same transient failure the same N windows to land in, and
            // the pacing that makes a reply read as human is worth less than the reply arriving
            // whole. The chunk that failed is included only when the read did not find it.
            const from = landed ? i + 1 : i;
            const owed = chunks
              .slice(from)
              .reduce(
                (acc, c, k) => (k === 0 ? c : acc + seps[from + k] + c),
                "",
              );
            if (!owed) break;
            try {
              await client.sendMessage(conversationId, owed);
              delivered += 1;
            } catch (retryErr) {
              reportFailedSend(flow, conversationId, retryErr);
              failed = true;
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
      return { delivered, failed };
    },
  );
}

// DID THE CHUNK REACH THE CUSTOMER, asked of Chatwoot rather than inferred from the error.
//
// Reading the conversation back is the only thing that separates "the POST never landed" from "the
// POST landed and the response did not come back", and those two need opposite handling: one owes
// the customer a resend, the other owes them silence. Compares CONTENT, because the send that
// failed never returned an id to compare.
//
// Fails CLOSED for the resend, i.e. an unreadable conversation answers "not landed". The two ways
// to be wrong are not symmetric: a false "landed" leaves the customer permanently missing a piece
// of the answer, with nothing to notice it, while a false "not landed" costs one duplicated balloon
// that both the customer and the operator can see. Visible over silent, which is the rule the
// delivery path already follows.
async function chunkAlreadyLanded(
  client: ChatwootClient,
  conversationId: number,
  chunk: string,
): Promise<boolean> {
  try {
    const raw = await client.getMessages(conversationId);
    const wanted = chunk.trim();
    return parseChatwootMessages(raw).some(
      (m) =>
        m.messageType === "outgoing" &&
        m.private !== true &&
        m.content.trim() === wanted,
    );
  } catch (e) {
    logger.warn(
      "split: could not read the conversation back after a failed send (conv=%s): %s",
      String(conversationId),
      e instanceof Error ? e.message : String(e),
    );
    return false;
  }
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
