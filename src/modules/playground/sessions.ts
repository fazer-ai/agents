import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { getCheckpointer } from "@/graph/checkpointer";
import { DATA_FENCE } from "@/graph/nudge";
import { CONVERSATION_NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import {
  buildPlaygroundTrace,
  collectTraceSources,
  type TraceEntry,
  type TraceSource,
} from "@/graph/trace";

import { NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { listThreadMedia } from "./media";
import { isValidPlaygroundThread } from "./thread";
import { type LoadedTurnNote, listThreadTurnNotes } from "./turn-notes";

// Server-side playground session history. The PlaygroundSession table holds ONLY metadata
// (threadId + title + timestamps, tenant-scoped + RLS); the conversation itself lives in the
// LangGraph checkpointer keyed by threadId — the single source of truth. Reopening a session
// reconstructs the transcript from the checkpointer (no conversation body duplicated in our DB).

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Conversation native tools are always simulated in the playground, so label their results as such
// on reopen too (the mock config isn't persisted, so mocked results show unlabeled on replay).
const SIMULATED_TOOL_NAMES = new Set<string>(CONVERSATION_NATIVE_TOOL_NAMES);

const TITLE_MAX = 80;
const LIST_LIMIT = 30;

function msgType(m: BaseMessage): string {
  const anyM = m as unknown as {
    getType?: () => string;
    _getType?: () => string;
  };
  return anyM.getType?.() ?? anyM._getType?.() ?? "";
}

// The turn's reply = the last AI message with non-empty text in the slice. (We can't use the
// graph's lastAssistantText here: it returns the last message's content regardless of type, so a
// silent follow-up slice — just the system nudge, no AI — would wrongly echo the nudge text.)
function lastAi(messages: BaseMessage[]): { text: string; id?: string } {
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k] as BaseMessage;
    if (msgType(m) === "ai") {
      const txt = contentToText(m.content).trim();
      if (txt) {
        const id = (m as unknown as { id?: unknown }).id;
        return { text: txt, id: typeof id === "string" ? id : undefined };
      }
    }
  }
  return { text: "" };
}

function messageId(m: BaseMessage): string | undefined {
  const id = (m as unknown as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : c && typeof c === "object" && "text" in c
            ? String((c as { text: unknown }).text)
            : "",
      )
      .join("");
  }
  return "";
}

// Inbound audio is fed to the agent wrapped as <mensagem-de-audio>…</mensagem-de-audio> (or an
// "inaudible" marker). Unwrap it back to the bare transcription for display + flag it as audio.
function unwrapAudio(raw: string): { text: string; audio: boolean } {
  const m = raw.match(/^<mensagem-de-audio>([\s\S]*)<\/mensagem-de-audio>$/);
  if (m) return { text: (m[1] ?? "").trim(), audio: true };
  if (raw.startsWith("<mensagem de áudio não audível"))
    return { text: "", audio: true };
  return { text: raw, audio: false };
}

// A playground file turn is rendered as a BARE marker (no inReplyTo/text prefix — the playground
// passes text:"" and no quote): <imagem>…</imagem>, <documento>…</documento>, or a "couldn't
// extract" notice. Recover the kind + extracted content so reopening shows the inline image / file
// chip + description. The content lives only here (checkpointer), never our DB.
function unwrapFileMarker(raw: string): {
  extractKind?: "image" | "document" | "unsupported";
  extracted?: string;
} {
  const img = raw.match(/^<imagem>([\s\S]*)<\/imagem>$/);
  if (img) return { extractKind: "image", extracted: (img[1] ?? "").trim() };
  const doc = raw.match(/^<documento>([\s\S]*)<\/documento>$/);
  if (doc) return { extractKind: "document", extracted: (doc[1] ?? "").trim() };
  if (raw.startsWith("<usuário enviou uma imagem"))
    return { extractKind: "image" };
  if (raw.startsWith("<usuário enviou um arquivo"))
    return { extractKind: "unsupported" };
  return {};
}

export interface RebuiltMedia {
  id: string;
  kind: string;
  mime: string;
  fileName: string | null;
}

export interface RebuiltTurn {
  role: "user" | "assistant";
  text: string;
  audio?: boolean;
  followup?: boolean;
  // For a user file turn: the extraction kind + content recovered from the rendered marker (so a
  // reopened session shows the inline image / file chip + the extracted description).
  extractKind?: "image" | "document" | "unsupported";
  extracted?: string;
  // The checkpointer message id this turn maps to (for joining persisted media on reopen).
  messageId?: string;
  // Persisted media attached to this turn (recorded audio / uploaded file / TTS reply).
  media?: RebuiltMedia[];
  // The guardrail removed a reply the agent DID write. Only meaningful on a follow-up, where the
  // client renders a suppression note instead of an empty bubble, because "nothing was sent" and
  // "the agent chose silence" are different statements.
  suppressed?: boolean;
  trace: TraceEntry[];
  sources: TraceSource[];
}

// Walk the full checkpointer message list into display turns. A turn opens on a human message (a
// user turn + the agent reply) or a system message (an injected follow-up nudge → a proactive
// assistant turn; silent follow-ups produce nothing and are skipped). Per-turn traces are rebuilt
// from each slice. Intermediate tool/AI messages belong to the turn's trace, never a separate bubble.
export function rebuildPlaygroundTurns(messages: BaseMessage[]): RebuiltTurn[] {
  const turns: RebuiltTurn[] = [];
  const n = messages.length;
  let i = 0;
  while (i < n) {
    const ty = msgType(messages[i] as BaseMessage);
    if (ty !== "human" && ty !== "system") {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n) {
      const tj = msgType(messages[j] as BaseMessage);
      if (tj === "human" || tj === "system") break;
      j++;
    }
    const slice = messages.slice(i, j);
    const trace = buildPlaygroundTrace(slice, {
      simulatedNames: SIMULATED_TOOL_NAMES,
    });
    const sources = collectTraceSources(trace);
    const reply = lastAi(slice);
    if (ty === "human") {
      const human = messages[i] as BaseMessage;
      const raw = contentToText(human.content);
      // A proactive follow-up is now injected as a HUMAN turn (a SystemMessage would make strict
      // providers reject the call — see graph.ts). renderNudge always embeds DATA_FENCE, which can't
      // be forged from user input, so it cleanly distinguishes a nudge from a real user message.
      if (raw.includes(DATA_FENCE)) {
        if (reply.text)
          turns.push({
            role: "assistant",
            text: reply.text,
            followup: true,
            ...(reply.id ? { messageId: reply.id } : {}),
            trace,
            sources,
          });
        i = j;
        continue;
      }
      const { text, audio } = unwrapAudio(raw);
      // A file turn's marker isn't user-facing text — the inline image / chip carries it, so blank
      // the bubble text and surface the parsed kind + extraction instead.
      const file = audio ? {} : unwrapFileMarker(raw);
      turns.push({
        role: "user",
        text: file.extractKind ? "" : text,
        ...(audio ? { audio: true } : {}),
        ...(file.extractKind ? { extractKind: file.extractKind } : {}),
        ...(file.extracted ? { extracted: file.extracted } : {}),
        ...(messageId(human) ? { messageId: messageId(human) } : {}),
        trace: [],
        sources: [],
      });
      if (reply.text)
        turns.push({
          role: "assistant",
          text: reply.text,
          ...(reply.id ? { messageId: reply.id } : {}),
          trace,
          sources,
        });
    } else if (reply.text) {
      // Legacy: a follow-up persisted as a SystemMessage by an older build → proactive reply
      // (silent follow-ups added nothing → skip).
      turns.push({
        role: "assistant",
        text: reply.text,
        followup: true,
        ...(reply.id ? { messageId: reply.id } : {}),
        trace,
        sources,
      });
    }
    i = j;
  }
  return turns;
}

// Folds the transcript notes over the checkpointer-derived turns (issue #136). Two shapes, and the
// second is why this is not a plain map: a note WITH a message id overrides the reply that message
// produced, while a note without one is a whole turn the thread never received (the input block),
// which has to be placed rather than matched. `anchorMessageId` is the message the thread ended on
// when it happened, so the turn goes right after the one carrying it; a null anchor means the
// thread was empty and it goes first. A note whose anchor no longer resolves still renders, at the
// end, because losing the turn entirely is the failure this exists to prevent.
export function applyTurnNotes(
  turns: RebuiltTurn[],
  notes: LoadedTurnNote[],
): RebuiltTurn[] {
  if (notes.length === 0) return turns;
  const overrides = new Map<string, LoadedTurnNote>();
  const inserts: LoadedTurnNote[] = [];
  for (const n of notes) {
    if (n.messageId) overrides.set(n.messageId, n);
    else inserts.push(n);
  }
  // A turn the thread never received is rebuilt through the SAME renderer as every other turn, from
  // the two messages it would have been. Building it by hand is what lost the audio/file unwrapping
  // and the media join: the marker text rendered as a plain bubble, and there was no message id to
  // hang the recording on. The verdict lands on the last turn of the pair, which is the one the
  // operator reads it against.
  const blockedTurns = (n: LoadedTurnNote): RebuiltTurn[] => {
    const msgs: BaseMessage[] = [
      new HumanMessage({
        content: n.userText ?? "",
        ...(n.userMessageId ? { id: n.userMessageId } : {}),
      }),
    ];
    if (n.reply) msgs.push(new AIMessage({ content: n.reply }));
    const built = rebuildPlaygroundTurns(msgs);
    // A `silent` action leaves no reply, and the renderer drops an empty AI message by design (a
    // follow-up the agent declined adds nothing). Here it has to stay visible: the client discards
    // a user turn's trace, so hanging the verdict there loses it, and the operator is left with a
    // bare message and no sign that anything blocked it.
    if (!n.reply) {
      built.push({
        role: "assistant",
        text: "",
        suppressed: true,
        trace: [...n.guardrails],
        sources: [],
      });
      return built;
    }
    const last = built[built.length - 1];
    if (last) last.trace = [...last.trace, ...n.guardrails];
    return built;
  };
  const out: RebuiltTurn[] = [];
  const placed = new Set<LoadedTurnNote>();
  for (const n of inserts) {
    if (n.anchorMessageId === null) {
      out.push(...blockedTurns(n));
      placed.add(n);
    }
  }
  for (const turn of turns) {
    const note = turn.messageId ? overrides.get(turn.messageId) : undefined;
    if (note && turn.role === "assistant") {
      // Direction IS position: the input screening ran before the graph and the output one after,
      // so appending both would report an execution sequence the turn never had.
      const before = note.guardrails.filter((g) => g.direction === "input");
      const after = note.guardrails.filter((g) => g.direction !== "input");
      out.push({
        ...turn,
        text: note.reply,
        ...(note.guardrails.some((g) => g.outcome === "suppressed")
          ? { suppressed: true }
          : {}),
        trace: [...before, ...turn.trace, ...after],
      });
    } else {
      out.push(turn);
    }
    for (const n of inserts) {
      if (!placed.has(n) && n.anchorMessageId === turn.messageId) {
        out.push(...blockedTurns(n));
        placed.add(n);
      }
    }
  }
  for (const n of inserts) if (!placed.has(n)) out.push(...blockedTurns(n));
  return out;
}

// Upsert the session metadata after a turn. Best-effort: a history-write hiccup must never break the
// reply. The title is set once (on create, from the first turn) and only bumped afterwards.
export async function upsertPlaygroundSession(
  base: PrismaClient,
  tenantId: bigint,
  agentId: bigint,
  threadId: string,
  titleHint: string,
): Promise<void> {
  if (!isValidPlaygroundThread(threadId, tenantId, agentId)) return;
  const title = titleHint.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
  try {
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.playgroundSession.upsert({
        where: { tenantId_threadId: { tenantId, threadId } },
        create: { tenantId, agentId, threadId, title },
        update: { updatedAt: new Date() },
      }),
    );
  } catch (e) {
    logger.warn(
      "playground: session upsert failed: %s",
      e instanceof Error ? e.message : String(e),
    );
  }
}

export interface PlaygroundSessionMeta {
  threadId: string;
  title: string;
  updatedAt: string;
}

export async function listPlaygroundSessions(
  tenantId: bigint,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<PlaygroundSessionMeta[]> {
  const rows = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.playgroundSession.findMany({
      where: { agentId },
      orderBy: { updatedAt: "desc" },
      take: LIST_LIMIT,
      select: { threadId: true, title: true, updatedAt: true },
    }),
  );
  return rows.map((r) => ({
    threadId: r.threadId,
    title: r.title,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

// Reconstruct a past session's transcript. The session row existing in OUR tenant-scoped table is
// the authorization that this thread belongs to the tenant; the thread shape is re-validated too,
// since the checkpointer is not under RLS (the thread prefix is its fence).
export async function getPlaygroundSessionTurns(
  tenantId: bigint,
  agentId: bigint,
  threadId: string,
  base: PrismaClient = basePrisma,
): Promise<RebuiltTurn[]> {
  if (!isValidPlaygroundThread(threadId, tenantId, agentId)) {
    throw new NotFoundError("session not found", "errors.sessionNotFound");
  }
  const exists = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.playgroundSession.findUnique({
      where: { tenantId_threadId: { tenantId, threadId } },
      select: { id: true },
    }),
  );
  if (!exists) {
    throw new NotFoundError("session not found", "errors.sessionNotFound");
  }
  const checkpointer = await getCheckpointer();
  const tuple = await checkpointer.getTuple({
    configurable: { thread_id: threadId },
  });
  const channel = tuple?.checkpoint?.channel_values as
    | { messages?: unknown }
    | undefined;
  const messages = Array.isArray(channel?.messages)
    ? (channel.messages as BaseMessage[])
    : [];
  const turns = applyTurnNotes(
    rebuildPlaygroundTurns(messages),
    await listThreadTurnNotes(base, tenantId, threadId),
  );

  // Join persisted media onto the turns by message id (best-effort replay — if the checkpointer
  // didn't round-trip the message id, the media simply isn't re-attached, never an error).
  const media = await listThreadMedia(tenantId, threadId, base);
  if (media.length > 0) {
    const byMessage = new Map<string, RebuiltMedia[]>();
    for (const m of media) {
      const list = byMessage.get(m.messageId) ?? [];
      list.push({ id: m.id, kind: m.kind, mime: m.mime, fileName: m.fileName });
      byMessage.set(m.messageId, list);
    }
    for (const turn of turns) {
      if (turn.messageId) {
        const attached = byMessage.get(turn.messageId);
        if (attached) turn.media = attached;
      }
    }
  }
  return turns;
}

// Remove a session from history. Only our metadata row is deleted; the checkpointer thread is left
// to LangGraph (it becomes unreachable from the UI, which is sufficient for a test surface).
export async function deletePlaygroundSession(
  tenantId: bigint,
  agentId: bigint,
  threadId: string,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, sysCtx(tenantId), async (db) => {
    // The transcript notes go with it. Left behind they would be orphans, and pruned separately
    // they would put a still-reloadable session back to the raw reply (issue #136).
    await db.playgroundTurnNote.deleteMany({ where: { agentId, threadId } });
    await db.playgroundSession.deleteMany({ where: { agentId, threadId } });
  });
}
