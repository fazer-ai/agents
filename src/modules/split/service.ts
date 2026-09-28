import logger from "@/api/lib/logger";
import {
  ChatwootApiError,
  type ChatwootClient,
  ChatwootMissingTokenError,
} from "@/modules/chatwoot/client";
import { literalForChatwoot } from "@/modules/chatwoot/liquid";
import {
  chatwootMessageListLength,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";
import { noteLandedMessage } from "@/modules/chatwoot/record-sends";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import {
  attachSignature,
  type SignatureFrequency,
  type SignaturePosition,
  type SignatureSeparator,
} from "@/modules/signature/service";

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

// What stood between two balloons in the model's text, carried beside the chunks because both the
// overflow merge and the consolidated retry rejoin it: a fixed "\n\n" would split one of the
// model's paragraphs in two.
export interface ReplyParts {
  chunks: string[];
  // `seps[i]` is the EXACT whitespace that preceded `chunks[i]` in the original; `seps[0]` is "".
  // Captured rather than classified: a category restores a plausible delimiter, not the real one,
  // and flattens `"Intro.\n- item"` into `"Intro. - item"`.
  seps: string[];
}

// Split into balloons: by paragraph (blank line), then any over-long paragraph by sentence, then cap
// the count (extra balloons merged into the last). Always returns at least one non-empty chunk.
export function splitReplyParts(text: string, cfg: SplitConfig): ReplyParts {
  const trimmed = text.trim();
  if (!trimmed) return { chunks: [], seps: [] };
  // NOTE: capturing groups keep the delimiters, so the original can be reassembled exactly.
  const paraParts = trimmed.split(/(\n{2,})/);
  const chunks: string[] = [];
  const seps: string[] = [];
  const push = (chunk: string, sep: string): void => {
    seps.push(chunks.length === 0 ? "" : sep);
    chunks.push(chunk);
  };
  for (let pi = 0; pi < paraParts.length; pi += 2) {
    const p = (paraParts[pi] ?? "").trim();
    // NOTE: the run of newlines the model typed, not always exactly two.
    const paraSep = pi === 0 ? "" : (paraParts[pi - 1] ?? "\n\n");
    if (!p) continue;
    if (p.length <= cfg.maxChars) {
      push(p, paraSep);
      continue;
    }
    // NOTE: over-long paragraph: accumulate sentences up to maxChars. Later chunks continue the same
    // paragraph, so they rejoin with the whitespace that stood between those sentences.
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

// What reached the customer, in three answers, following the rule `deliverPendingAttachments`
// follows (../../graph/runtime.ts): "nothing was delivered" answers more than one question.
export interface ReplyDelivery {
  // How many messages actually landed in the conversation. The caller keys "the customer was
  // answered" off this, and the console holds a "delivering" indicator until it arrives.
  delivered: number;
  // A send failed and the remainder's one retry failed too. A run called off mid-split is not this:
  // reported as a failure, a /reset between balloons would put `lastError` back on a cleared conversation.
  failed: boolean;
  // A rejected send that Chatwoot could not be asked about: it may or may not have landed. Decides
  // whether the turn may run again: `delivered: 0, failed` without this makes `runLoadedTurn` throw,
  // and the recovery re-runs the whole turn, which is only safe when nothing landed and we know it.
  unproven: boolean;
}

// Sends the reply, split + paced when enabled. Typing toggles are best-effort (admin-token, may be
// unsupported on a channel) and never block the send. The sleep is injectable for tests.
//
// The unit of delivery is the reply: a failure after a balloon landed never throws, since a throw
// would hand the reply to the recovery and resend what the customer already has, side-effecting
// tools included. The remainder is retried once, consolidated into a single send. See docs/split.md.
// No per-balloon durable state: the chunks are still in memory in this process, so all it would add
// is resuming after a process death, which is the recovery's job, not this loop's.
export async function deliverReply(
  client: ChatwootClient,
  conversationId: number,
  reply: string,
  cfg: SplitConfig,
  sleep: (ms: number) => Promise<void> = realSleep,
  flow?: FlowContext,
  // Asked before each balloon: one answer before the loop covers only the first. Returns how many
  // landed, so the caller still reports what the customer received.
  calledOff: () => Promise<boolean> = async () => false,
  // The newest message that existed before this reply (the customer message it answers), when the
  // caller knows one. It bounds the read-back at no cost; without it a long history can exhaust the
  // page ceiling and a first-send failure answers `unknown`.
  anchor: number | null = null,
  // The operator's signature, attached after the cut and never before: both separators contain the
  // "\n\n" `splitReplyParts` cuts on. Null when there is none, or on an audio reply.
  signature: {
    text: string;
    position: SignaturePosition;
    separator: SignatureSeparator;
    frequency: SignatureFrequency;
  } | null = null,
  // False when the text is the operator's (a guardrail's template or hand-over message standing in
  // for the reply): it keeps Chatwoot's Liquid. The model's text is escaped.
  modelText = true,
): Promise<ReplyDelivery> {
  const literal = modelText ? literalForChatwoot : (text: string) => text;
  return withFlowStage(
    flow,
    "split",
    {
      detail: { enabled: cfg.enabled },
      // NOTE: the stage does not throw on a partial delivery, so without these numbers it reads `ok`.
      detailOf: (out) => ({ delivered: out.delivered, failed: out.failed }),
    },
    async () => {
      if (!cfg.enabled) {
        const sendId = crypto.randomUUID();
        // NOTE: the same function on a one-element array: split off is one chunk, not a second rule.
        // NOTE: the model's text is escaped for Chatwoot's Liquid and the signature is not.
        const [single = literal(reply)] = signature
          ? attachSignature(
              [reply],
              signature.text,
              signature,
              undefined,
              literal,
            )
          : [literal(reply)];
        try {
          await client.sendMessage(conversationId, single, { sendId });
          return { delivered: 1, failed: false, unproven: false };
        } catch (e) {
          // NOTE: nothing is resent on this path, but the verdict still decides whether the turn may run
          // again, which does not depend on how many balloons the reply had.
          const verdict = await accountForRejectedSend(
            client,
            conversationId,
            sendId,
            // NOTE: nothing has been sent on this path yet, so the caller's anchor is the only boundary.
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
      const { chunks: rawChunks, seps } = splitReplyParts(reply, cfg);
      // NOTE: `seps` stays aligned because attaching never changes the count. Each balloon is escaped for
      // Chatwoot's Liquid after the cut, so the cut never lands inside an escape, and the signature is
      // attached as the operator wrote it.
      const chunks = signature
        ? attachSignature(rawChunks, signature.text, signature, reply, literal)
        : rawChunks.map(literal);
      let delivered = 0;
      let failed = false;
      let unproven = false;
      // NOTE: how far back a read-back has to look, fed only by sends that returned an id. It bounds cost
      // only: identity decides, and null just means paging to the ceiling. A pre-send read to establish
      // it would tax every reply, and a short one is exactly what an overloaded Chatwoot misses.
      let boundary: number | null = anchor;
      // NOTE: the one place a delivery is recorded, and each delivery is also a new boundary. A confirmer
      // that counts without advancing it leaves a stale boundary: with chunks `A / B / B`, a middle `B`
      // found under a rejection would make the final `B` match it. The retry call sites have no later
      // reader but use it anyway, so "delivered" has one spelling.
      const noteDelivered = (id: number | null): void => {
        delivered += 1;
        if (id !== null && (boundary === null || id > boundary)) boundary = id;
      };
      try {
        for (const [i, chunk] of chunks.entries()) {
          // NOTE: asked before the typing indicator too, since it is customer-facing. The first balloon is
          // covered by the caller's own ask just before this loop.
          if (i > 0 && (await calledOff())) break;
          await client
            .toggleTyping(conversationId, true)
            .catch(() => undefined);
          await sleep(typingDelayMs(chunk, cfg));
          if (await calledOff()) break;
          // NOTE: minted before the request, because the send that times out never returns anything.
          const sendId = crypto.randomUUID();
          try {
            const res = await client.sendMessage(conversationId, chunk, {
              sendId,
            });
            noteDelivered(createdMessageId(res));
          } catch (e) {
            // NOTE: a rejected send is not an undelivered one. The 15s deadline (../chatwoot/client.ts) can
            // reject with the message already written, and neither a 502 nor a 500 says whether it was. So
            // this reads the conversation back and looks for the chunk; blindly retrying would duplicate.
            const verdict = await accountForRejectedSend(
              client,
              conversationId,
              sendId,
              boundary,
              e,
              flow,
            );
            if (verdict.known && verdict.id !== null) noteDelivered(verdict.id);
            // NOTE: asked again after the reconciliation: the failed request and the read are I/O, so the
            // earlier answer is stale (one ask per stretch of I/O before a write, as in ../../graph/nudge.ts).
            // A /reset here is a stand-down, not a failure.
            if (await calledOff()) break;
            // NOTE: landed: counted, not resent. Absent: resent, since nothing can duplicate. Unknown: left out
            // and reported `failed`, because the Chatwoot that loses the POST's response also fails the read,
            // and an invisible duplicate is worse than a visible gap. What is owed goes as ONE message: a
            // re-walk would give the same transient failure the same N windows.
            if (!verdict.known) {
              failed = true;
              unproven = true;
            }
            const from = verdict.known && verdict.id === null ? i : i + 1;
            // NOTE: built from the raw balloons and signed once; with `frequency: "all"` joining the signed
            // chunks would put the badge several times inside one message.
            const owedRaw = rawChunks
              .slice(from)
              .reduce(
                (acc, c, k) => (k === 0 ? c : acc + seps[from + k] + c),
                "",
              );
            if (!owedRaw) break;
            // NOTE: the retry is signed iff the balloons it replaces were, the one rule that cannot disagree
            // with the balloon pass (a conditional on frequency would re-sign a model copy the merge made
            // inexact). It also covers `once`: a landed top-signed first balloon is not among them.
            const owedWasSigned = rawChunks
              .slice(from)
              .some((raw, k) => chunks[from + k] !== literal(raw));
            const owed =
              signature && owedWasSigned
                ? (attachSignature(
                    [owedRaw],
                    signature.text,
                    signature,
                    // NOTE: whether the turn is signed was answered by the balloons; this asks only whether this
                    // message already carries a copy.
                    owedRaw,
                    literal,
                  )[0] ?? literal(owedRaw))
                : literal(owedRaw);
            // NOTE: same 15s deadline, so it can be rejected after being accepted like any other send.
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
              // NOTE: just as ambiguous as the first rejection, and a bare `failed` would make `runLoadedTurn`
              // throw and re-run a turn whose reply the customer may already have.
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
                // NOTE: fence asked once more after the retry's own I/O: with nothing delivered, `failed` makes
                // the caller throw, and after a /reset that would restore `lastError` on a cleared conversation.
              } else if (!(await calledOff())) {
                failed = true;
                // NOTE: only a proven absence leaves the report clean enough for the turn to run again.
                if (!retryVerdict.known) unproven = true;
              }
            }
            break;
          }
        }
      } finally {
        // NOTE: in a `finally` because the loop can leave by a failure too; the indicator is per
        // conversation and nothing later would clear it.
        await client.toggleTyping(conversationId, false).catch(() => undefined);
      }
      return { delivered, failed, unproven };
    },
  );
}

// Did the chunk reach the customer, asked of Chatwoot by the send's own id (`CHATWOOT_SEND_ID_KEY`,
// echoed by the fork) rather than by content, which is not an identity: a conversation can hold the
// same words twice. `after` is only a cost bound (null pages to the ceiling). Fails closed: an
// unreadable conversation answers unknown, and the caller leaves that chunk out rather than risk a
// duplicate.
//
// The whole read-back costs what one `getMessages` does: each request's deadline is what is left of
// this budget. Beyond it the answer is unknown.
const READBACK_BUDGET_MS = 10_000;
// A ceiling on the pathological case: filling one page in the instant after a rejected POST takes
// ~20 inbound messages, so five pages is a hundred.
const READBACK_MAX_PAGES = 5;
// Chatwoot's page size, read as `debounce/handler.ts` reads it: a shorter page is the conversation's
// first, so nothing older can hide behind it.
const CHATWOOT_MESSAGES_PAGE = 20;

// Three answers, not two: "read and not there" and "could not read" are opposite facts, and only the
// first makes a resend safe. No rows is unknown, not zero.
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

// Statuses Chatwoot answers without having written a message (auth, route, payload refused). 5xx and
// 429 are deliberately absent: a 500 fails at an unknown point, a 502 proxy may have forwarded, and a
// 429 can come from a proxy after the write. Only what is definitively pre-create belongs here.
const PRE_CREATE_STATUSES = new Set([400, 401, 403, 404, 405, 422]);

function isPreCreateStatus(status: number): boolean {
  return PRE_CREATE_STATUSES.has(status);
}

// What a rejected send means, asked in one place so both delivery paths answer it the same way.
async function accountForRejectedSend(
  client: ChatwootClient,
  conversationId: number,
  sendId: string,
  after: number | null,
  err: unknown,
  flow: FlowContext | undefined,
): Promise<LandedVerdict> {
  reportFailedSend(flow, conversationId, err);
  // NOTE: a rejection that could not have created a message is a proven absence. Reading it as
  // unknown would stop resending: an expired credential would silently stop answering customers.
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
      // NOTE: counted on the response, not the parsed rows: the parser folds an empty page, a non-list
      // body and a page of unreadable rows into the same empty array.
      const carried = chatwootMessageListLength(raw);
      const rows = parseChatwootMessages(raw);
      // NOTE: found is asked first, before the page's quality: the id was minted for this send alone, so
      // a row carrying it is the message whatever its neighbours are.
      const hit = rows.find((m) => m.sendId === sendId);
      if (hit !== undefined) {
        // NOTE: still a message the turn created, and the turn's closing line names it.
        if (typeof hit.id === "number") noteLandedMessage(client, hit.id);
        return { known: true, id: hit.id };
      }
      // NOTE: absence may only rest on a page read whole: an entry this build could not parse might be
      // the message. A non-list response never equals a row count, so it needs no arm of its own.
      const readWhole = rows.length === carried;
      if (!readWhole) return { known: false };
      // NOTE: a page shorter than Chatwoot's is the top of the history, which proves absence without a
      // further request that could fail. An empty first page stays unknown: a conversation just written
      // to cannot really be empty (same verdict as `recoverDelivery`).
      if (rows.length === 0 && before === undefined) return { known: false };
      if (rows.length < CHATWOOT_MESSAGES_PAGE)
        return { known: true, id: null };
      const oldest = rows.reduce(
        (min, m) => (m.id < min ? m.id : min),
        rows[0]?.id ?? 0,
      );
      // NOTE: Chatwoot answers with the newest ~20, so absence from one page is not absence. Reaching
      // `after` (a send this loop completed) ends the walk with certainty: nothing older carries our id.
      if (after !== null && oldest <= after) return { known: true, id: null };
      before = oldest;
    }
    // NOTE: out of pages without reaching a point that proves absence.
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

// The id Chatwoot assigned to a message we just created, so the boundary advances past it.
function createdMessageId(res: unknown): number | null {
  if (typeof res !== "object" || res === null) return null;
  const id = (res as { id?: unknown }).id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

// A send that did not get through, reported without throwing. Warn, not error: whether the turn
// failed depends on what landed overall, which only the caller sees.
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
