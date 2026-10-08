import logger from "@/api/lib/logger";
import { withKeyedQueue } from "@/lib/locks";
import { withDeadline } from "@/lib/outbound";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { redactEndpoint } from "@/modules/audit/projection";
import type { AdditionalContactField } from "@/modules/chatwoot/contact-fields";
import {
  CHATWOOT_AUTH_HEADER,
  CHATWOOT_REPLY_BY_OPERATOR_KEY,
  CHATWOOT_REPLY_TEXT_KEY,
  CHATWOOT_SEND_ID_KEY,
} from "./constants";

// Chatwoot Application API client with the dual-identity profiles: the bot token runs the gate loop
// (sends, assignment, status, custom attributes), the admin token reads history and does everything
// outside the fork's BOT_ACCESSIBLE_ENDPOINTS. Which call uses which token: the "two profiles"
// client section of docs/chatwoot.md. Auth header is CHATWOOT_AUTH_HEADER (see constants.ts); paths
// use the display_id. The tenant-configured baseUrl is validated once at construction (anti-SSRF,
// https-only): the host is fixed for every call and the path is our code. The DNS-rebinding caveat
// from src/lib/ssrf.ts applies.

const REQUEST_TIMEOUT_MS = 15_000;

// Cap a downloaded attachment (voice note) so a hostile/huge file cannot exhaust memory. WhatsApp
// voice notes are small; 25 MB is generous headroom.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// A shorter ceiling for interactive reads (the conversation-detail UI). The default 15s is fine for
// background/agent calls, but an operator clicking a conversation must not hang 15s when Chatwoot is
// slow/unreachable — fail fast so the caller can degrade gracefully (serve metadata + a retry).
const INTERACTIVE_TIMEOUT_MS = 10_000;

// Chatwoot fires `message_created` (with the attachment's data_url already in the payload) BEFORE
// ActiveStorage finishes writing the file, so an immediate GET on a fresh voice note can lose the race
// and get a 404. On a disk-backed instance the blob row commits ~400ms before the file lands, and the
// eager-media download fires ~70ms after the webhook. These delays cover that window with headroom
// while staying well inside a typical debounce window.
// Only 404 is retried (missing file); every other status is a real error and fails immediately.
const ATTACHMENT_RETRY_DELAYS_MS = [250, 750, 1500];

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class ChatwootApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  // The auth failure's reason, verbatim, when Chatwoot named one (see `authFailureDetail`). Kept as
  // a field and not only inside the message because a caller has to be able to tell WHICH refusal it
  // got: "this endpoint is not open to bots" and "this token is no good" are both 401 and mean
  // opposite things.
  readonly reason?: string;
  constructor(status: number, endpoint: string, detail?: string) {
    // NOTE: `detail` is ONLY ever an auth failure's reason (see authFailureDetail) — the response body
    // of any other status carries customer PII / message content and must never reach this message.
    super(
      detail
        ? `Chatwoot API ${status} for ${endpoint}: ${detail}`
        : `Chatwoot API ${status} for ${endpoint}`,
    );
    this.name = "ChatwootApiError";
    this.status = status;
    this.endpoint = endpoint;
    this.reason = detail;
  }
}

// A conditional toggle Chatwoot refused because the conversation no longer held the expected status.
// Nothing changed at the source: the caller's decision is stale, not failed.
export class ChatwootStatusConflictError extends Error {
  readonly conversationId: number;
  constructor(conversationId: number) {
    super(`conversation ${conversationId} no longer holds the expected status`);
    this.name = "ChatwootStatusConflictError";
    this.conversationId = conversationId;
  }
}

// Raised INSTEAD of dialing Chatwoot when the client holds no token for the call it was asked to
// make. Distinct from ChatwootApiError on purpose: nothing was sent, so there is no status, and the
// fault is local (a caller that built the client without the token) rather than remote.
export class ChatwootMissingTokenError extends Error {
  readonly endpoint: string;
  constructor(endpoint: string) {
    super(`Chatwoot client has no token for ${endpoint}`);
    this.name = "ChatwootMissingTokenError";
    this.endpoint = endpoint;
  }
}

// Chatwoot's `render_unauthorized` answers 401 `{error: message}` both for a bad token and for an
// endpoint outside BOT_ACCESSIBLE_ENDPOINTS, so the status alone cannot tell them apart. The body is
// read only in `authFailureDetail`, and a reason is named only when it matches KNOWN_AUTH_REASONS:
// the base URL is tenant-configured, a proxy in front of it can answer any JSON (customer data
// included), and that text would reach shared logs. This is the ONE refusal that means "this server
// does not open this endpoint to bots", as opposed to "this bot's token is no good"; the label write
// below answers it differently, and only this one.
export const BOT_ENDPOINT_NOT_AUTHORIZED =
  "Access to this endpoint is not authorized for bots";

const KNOWN_AUTH_REASONS: ReadonlySet<string> = new Set([
  // access_token_auth_helper.rb: the token is blank or matches no user.
  "Invalid Access Token",
  // access_token_auth_helper.rb: the endpoint is outside BOT_ACCESSIBLE_ENDPOINTS.
  BOT_ENDPOINT_NOT_AUTHORIZED,
  // ensure_current_account_helper.rb: the bot belongs to another account.
  "Bot is not authorized to access this account",
  // accounts/base_controller.rb, on a 403.
  "API access is not enabled for this account",
]);

async function authFailureDetail(res: Response): Promise<string | undefined> {
  if (res.status !== 401 && res.status !== 403) return undefined;
  try {
    const text = (await res.text()).trim();
    if (!text) return undefined;
    let message: string;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const field = parsed?.error ?? parsed?.message;
      if (typeof field !== "string") return undefined;
      message = field;
    } catch {
      // NOTE: a body that does not parse did not come from Chatwoot's renderer at all.
      return "unrecognized reason (an intermediary, not Chatwoot?)";
    }
    return KNOWN_AUTH_REASONS.has(message) ? message : "unrecognized reason";
  } catch {
    return undefined;
  }
}

export interface ChatwootClientConfig {
  baseUrl: string;
  accountId: number;
  adminToken: string;
  botToken: string;
  // A client that cannot speak to the customer, for a monitoring agent that runs the ordinary graph.
  // Enforced at the transport, not per method (the method added next week is not on a list), and the
  // boundary is what the customer perceives, not "a sender": see CUSTOMER_FACING_PATHS. A backstop,
  // not the mechanism: the observe path never delivers a reply, so reaching this refusal is a defect
  // and throws.
  mute?: boolean;
  // A deadline for the whole client. Aborting a turn stops the caller waiting, not a tool handler
  // already inside its own writes, and each request has its own timeout; without this, a watcher's
  // retry could run beside a turn still mutating the conversation. Enforced in the same wrapper as
  // the mute (a per-method guard is a list the next write is not on). Once it fires the client is
  // done, reads included, because nobody is left to answer.
  expiresOn?: AbortSignal;
}

// Thrown when a client whose deadline has passed is asked for anything. Its own class, not folded
// into the muted one: the two say different things to whoever reads the trail — "this agent never
// speaks to customers" against "this turn's time was up".
export class ChatwootExpiredError extends Error {
  constructor(endpoint: string) {
    super(
      `Chatwoot ${endpoint} refused: this turn's deadline passed, so nothing more is written for it.`,
    );
    this.name = "ChatwootExpiredError";
  }
}

// Thrown by a muted client when something tries to post a customer-visible message. Named so a
// caller can tell it from a Chatwoot rejection: nothing left this process.
export class ChatwootMutedError extends Error {
  constructor(endpoint: string) {
    super(
      `Chatwoot ${endpoint} refused: this client belongs to a monitoring agent, which never posts to the customer. Private notes are allowed.`,
    );
    this.name = "ChatwootMutedError";
  }
}

// Thrown by a queued write whose caller withdrew the run while the write waited its turn. Named so
// the tool can answer the model with a sentence instead of an integration failure: nothing left this
// process, and nothing is wrong with Chatwoot.
export class ChatwootCalledOffError extends Error {
  constructor(endpoint: string) {
    super(
      `Chatwoot ${endpoint} was not sent: the run was called off while this write waited its turn.`,
    );
    this.name = "ChatwootCalledOffError";
  }
}

// Everything the customer perceives, a bigger set than "everything that sends a message":
//   messages: every sender, current and future. A PRIVATE note is the one exemption (isPrivateSend).
//   .../reactions: addMessageReaction, an emoji on the customer's own message.
//   toggle_typing_status: `channel_listener.rb` forwards typing to the channel, so on WhatsApp the
//     customer watches the persona compose a reply that is never coming.
//   read_receipt: the fork's `mark_read`, which turns the ticks blue on the customer's phone.
// Label, attribute, status, assignment and kanban writes are internal; a watcher exists to make them.
const CUSTOMER_FACING_PATHS: readonly RegExp[] = [
  /\/conversations\/\d+\/messages\/?$/,
  /\/conversations\/\d+\/messages\/\d+\/reactions\/?$/,
  /\/conversations\/\d+\/toggle_typing_status\/?$/,
  /\/conversations\/\d+\/read_receipt\/?$/,
];

// The private-note exemption belongs to the MESSAGE path alone: a reaction, a typing indicator and
// a read receipt have no private variant to check for, so a body that happened to carry
// `private: true` must not buy one a pass.
const PRIVATE_CAPABLE_PATH = /\/conversations\/\d+\/messages\/?$/;

// Is this POST a PRIVATE note? Read off the body the caller actually built, in both shapes it can
// take: JSON for `sendMessage`/`sendTemplate`, multipart for the attachment senders (which set no
// `private` field at all, so they are outgoing and refused). A body that cannot be read is NOT
// assumed private: an unparseable send is exactly the one nobody has thought about.
function isPrivateSend(body: BodyInit | null | undefined): boolean {
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as { private?: unknown };
      return parsed?.private === true;
    } catch {
      return false;
    }
  }
  if (body instanceof FormData) return body.get("private") === "true";
  return false;
}

// The mute itself: one wrapper around the client's own fetch, so `request` and the multipart senders
// that build their own call are both covered without either of them knowing about it.
function mutedFetch(
  inner: typeof fetch,
  mute: boolean,
  expiresOn?: AbortSignal,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    // NOTE: First, before the method is even looked at: past the deadline this client answers nothing.
    if (expiresOn?.aborted) {
      throw new ChatwootExpiredError(new URL(url).pathname);
    }
    // The deadline rides along, not only gates the dispatch. Each request arms its own
    // `AbortSignal.timeout`, so without combining the two a call that started inside the budget runs
    // to that timeout and lands its effect after `runObserve` reported the tick as failed
    // (`recordResolutionOrigin` above all).
    const withBudget: RequestInit | undefined = expiresOn
      ? { ...(init ?? {}), signal: withDeadline(init?.signal, expiresOn) }
      : init;
    if (!mute) return inner(input, withBudget);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (method === "POST") {
      const { pathname } = new URL(url);
      const facing = CUSTOMER_FACING_PATHS.some((re) => re.test(pathname));
      const exempt =
        PRIVATE_CAPABLE_PATH.test(pathname) && isPrivateSend(init?.body);
      if (facing && !exempt) throw new ChatwootMutedError(`POST ${pathname}`);
    }
    return inner(input, withBudget);
  }) as typeof fetch;
}

export interface ChatwootClientDeps {
  fetchImpl?: typeof fetch;
  assertSafe?: (url: string) => Promise<URL>;
}

export interface AttachmentDownloadOptions {
  // Opt-in bounded retry for the write race described on ATTACHMENT_RETRY_DELAYS_MS. The eager media
  // path (STT/vision, right off the webhook) sets it; the interactive media proxy does NOT — there a
  // 404 means the attachment is really gone and the operator must not wait out the backoff.
  retryOnMissing?: boolean;
  // Injectable for tests (no real waiting).
  sleep?: (ms: number) => Promise<void>;
}

export type ChatwootMessageType = "outgoing" | "incoming";

// A Chatwoot custom-attribute definition (account-level). `model` is one of conversation_attribute |
// contact_attribute | task_attribute | company_attribute; `values` is populated only for list types.
// Surfaced to the set_custom_attribute tool so the agent writes known keys (and known list values).
export interface CustomAttributeDef {
  key: string;
  displayName: string;
  model: string;
  displayType: string;
  values: string[];
}

// A custom_attributes bag as Chatwoot renders it, or {} for anything that is not a plain object.
// Arrays are excluded on purpose: spreading one produces index keys, which would then be written
// back as real attributes.
function attributeBag(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

// Normalizes a Chatwoot list response (a bare array OR `{ payload: [...] }`) into a clean
// {id, name}[], dropping entries without a positive integer id.
function normalizeIdName(res: unknown): Array<{ id: number; name: string }> {
  const arr = Array.isArray(res)
    ? res
    : res &&
        typeof res === "object" &&
        Array.isArray((res as { payload?: unknown }).payload)
      ? (res as { payload: unknown[] }).payload
      : [];
  const out: Array<{ id: number; name: string }> = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const id = Number((item as { id?: unknown }).id);
    if (!Number.isInteger(id) || id <= 0) continue;
    out.push({ id, name: String((item as { name?: unknown }).name ?? "") });
  }
  return out;
}

export interface ChatwootContact {
  id: number;
  name: string | null;
  email: string | null;
  phoneNumber: string | null;
}

// `id` is the conversation's display_id: the API serializes `display_id` under that name.
export interface ChatwootConversationRef {
  id: number;
  inboxId: number | null;
  status: string | null;
  // Chatwoot's own reading of the channel's reply window (`can_reply`): false on an official WhatsApp
  // inbox, or a Twilio one on WhatsApp, where the customer has not written in the last 24h.
  canReply: boolean | null;
  // The conversation's `custom_attributes`, null when the payload carries none.
  customAttributes?: Record<string, unknown> | null;
}

// A search that has not found an exact address in this many pages of 15 is not going to: the query
// is the full address, and only substrings of it can match.
const CONTACT_SEARCH_MAX_PAGES = 5;

function parseContact(raw: unknown): ChatwootContact | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = Number(o.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const s = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
  return {
    id,
    name: s(o.name),
    email: s(o.email),
    phoneNumber: s(o.phone_number),
  };
}

function parseConversationRef(raw: unknown): ChatwootConversationRef | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = Number(o.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const inboxId = Number(o.inbox_id);
  return {
    id,
    inboxId: Number.isInteger(inboxId) && inboxId > 0 ? inboxId : null,
    status: typeof o.status === "string" ? o.status : null,
    canReply: typeof o.can_reply === "boolean" ? o.can_reply : null,
    customAttributes:
      o.custom_attributes && typeof o.custom_attributes === "object"
        ? (o.custom_attributes as Record<string, unknown>)
        : null,
  };
}

// A Channel::WebWidget inbox's provisioning fields, parsed from the inbox create/detail payload
// (_inbox.json.jbuilder). `hmacToken` is serialized ONLY when the admin token belongs to an account
// administrator (jbuilder gate); it is null otherwise. The WhatsApp→chat redirect merge needs it (to
// compute the per-lead identifier_hash), so provisioning must verify it came back non-null.
export interface WebWidgetInbox {
  inboxId: number;
  name: string;
  channelType: string | null;
  websiteToken: string | null;
  hmacToken: string | null;
  websiteUrl: string | null;
}

function parseWebWidgetInbox(res: unknown): WebWidgetInbox | null {
  if (!res || typeof res !== "object") return null;
  const o = res as Record<string, unknown>;
  const inboxId = Number(o.id);
  if (!Number.isInteger(inboxId) || inboxId <= 0) return null;
  const s = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;
  return {
    inboxId,
    name: typeof o.name === "string" ? o.name : "",
    channelType: s(o.channel_type),
    websiteToken: s(o.website_token),
    hmacToken: s(o.hmac_token),
    websiteUrl: s(o.website_url),
  };
}

export class ChatwootClient {
  private readonly fetchImpl: typeof fetch;
  private readonly accountBase: string;

  constructor(
    private readonly config: ChatwootClientConfig,
    fetchImpl: typeof fetch,
  ) {
    this.fetchImpl =
      config.mute || config.expiresOn
        ? mutedFetch(fetchImpl, config.mute === true, config.expiresOn)
        : fetchImpl;
    const root = config.baseUrl.replace(/\/+$/, "");
    this.accountBase = `${root}/api/v1/accounts/${config.accountId}`;
  }

  // Asked by a queued write at the last moment before it sends. Absent ⇒ the write proceeds, which
  // is what every caller with no fence to offer means. A fence that THROWS is not a withdrawal
  // either: the write goes out, exactly as every other fence in this codebase decides.
  private async assertStillWanted(
    stillWanted: (() => Promise<boolean>) | undefined,
    endpoint: string,
  ): Promise<void> {
    if (!stillWanted) return;
    const wanted = await stillWanted().catch(() => true);
    if (!wanted) throw new ChatwootCalledOffError(endpoint);
  }

  // Whether anything this client does can reach the customer. Asked by callers that arm an effect the
  // transport cannot see: a scheduled reminder runs later, through the inbox's responder and a client
  // of its own, so a mute here does not reach it. Derived from the field the wrapper reads, so the two
  // cannot disagree about the same client.
  get muted(): boolean {
    return this.config.mute === true;
  }

  // A client can legitimately be built with only the admin token (callers that never act as the
  // persona). Sending the empty token gets a 401 that a best-effort catch reports as a rejected
  // credential; refusing here names the actual fault. Called by `request` AND by the multipart
  // senders, which build their own fetch and would otherwise slip past.
  private assertToken(token: string, endpoint: string): void {
    if (token === "") throw new ChatwootMissingTokenError(endpoint);
  }

  // Scoped by accountBase so two installs (or two accounts) never queue behind each other on the
  // same numeric id.
  private targetKey(scope: string, id: number): string {
    return `${this.accountBase}:${scope}:${id}`;
  }

  private async request(
    token: string,
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    this.assertToken(token, `${method} ${path}`);
    const res = await this.fetchImpl(`${this.accountBase}${path}`, {
      method,
      headers: {
        [CHATWOOT_AUTH_HEADER]: token,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new ChatwootApiError(
        res.status,
        `${method} ${path}`,
        await authFailureDetail(res),
      );
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ── bot-token (the gate loop) ──

  sendMessage(
    conversationId: number,
    content: string,
    opts: {
      private?: boolean;
      messageType?: ChatwootMessageType;
      // A name for this send, echoed back by Chatwoot so a delivery can be proved without comparing
      // text. Passed only by callers with a resend to decide: elsewhere there is nothing to
      // reconcile, and a key written for nobody to read is debt.
      sendId?: string;
    } = {},
  ): Promise<unknown> {
    return this.request(
      this.config.botToken,
      "POST",
      `/conversations/${conversationId}/messages`,
      {
        content,
        private: opts.private ?? false,
        message_type: opts.messageType ?? "outgoing",
        // NOTE: Omitted rather than sent empty, so a send with no name leaves the bag untouched (the
        // fork stores `content_attributes` verbatim). Only an opaque send name goes here: this bag
        // reaches the CONTACT on a website inbox (the widget's messages jbuilder renders it, and
        // `Message#push_event_data` ships it), so nothing about the account's own state belongs in it.
        ...(opts.sendId === undefined
          ? {}
          : { content_attributes: { [CHATWOOT_SEND_ID_KEY]: opts.sendId } }),
      },
    );
  }

  // Transfer-with-summary posts the summary as a private note BEFORE the human takes over.
  sendPrivateNote(
    conversationId: number,
    content: string,
    opts: { sendId?: string } = {},
  ): Promise<unknown> {
    return this.sendMessage(conversationId, content, {
      private: true,
      sendId: opts.sendId,
    });
  }

  // Sends an audio reply as a WhatsApp voice note (multipart; bot token). `is_recorded_audio` makes
  // Chatwoot/WhatsApp render it as a recording (not a file attachment); the spoken text is stored in
  // the attachment meta for accessibility/search. Multipart shape confirmed against the fork's
  // sendFile (@fazer-ai/n8n-nodes-chatwoot). No content-type header — fetch sets the boundary.
  async sendAudioMessage(
    conversationId: number,
    audio: ArrayBuffer,
    fileName: string,
    mime: string,
    opts: {
      transcribedText?: string;
      replyText?: string;
      byOperator?: boolean;
    } = {},
  ): Promise<unknown> {
    this.assertToken(this.config.botToken, "POST audio message");
    const form = new FormData();
    // NOTE: Um `File`, e não um `Blob` com o nome no terceiro argumento: no fio, o nome do Blob
    // depende da implementação de FormData carregada (a do Bun o preserva, a do happy-dom que o
    // preload dos testes instala escreve `filename="blob"`). O fork casa os metadados deste envio pelo
    // nome (`uploaded_filename` no `message_builder`): sem ele caem o `transcribed_text` e o
    // `is_recorded_audio`, e o áudio chega ao WhatsApp como arquivo anexado em vez de gravação.
    form.append("attachments[]", new File([audio], fileName, { type: mime }));
    form.append("message_type", "outgoing");
    form.append("is_recorded_audio", JSON.stringify([fileName]));
    if (opts.transcribedText) {
      form.append(
        `attachments_metadata[${fileName}][transcribed_text]`,
        opts.transcribedText,
      );
    }
    // NOTE: The whole reply, only when the speech is not it: the text that replaces a refused voice
    // note reads it from here. A JSON string, which is how the builder takes the bag on a multipart
    // create.
    if (opts.replyText || opts.byOperator) {
      form.append(
        "content_attributes",
        JSON.stringify({
          ...(opts.replyText
            ? { [CHATWOOT_REPLY_TEXT_KEY]: opts.replyText }
            : {}),
          ...(opts.byOperator
            ? { [CHATWOOT_REPLY_BY_OPERATOR_KEY]: true }
            : {}),
        }),
      );
    }
    const res = await this.fetchImpl(
      `${this.accountBase}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: { [CHATWOOT_AUTH_HEADER]: this.config.botToken },
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      throw new ChatwootApiError(
        res.status,
        "POST audio message",
        await authFailureDetail(res),
      );
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // Sends a generic file/document/image as an outgoing attachment (multipart; bot token). Mirrors
  // sendAudioMessage WITHOUT is_recorded_audio, so Chatwoot renders it as a normal file attachment
  // (not a voice note). An optional caption rides along as the message `content`. No content-type
  // header — fetch sets the multipart boundary.
  async sendFileAttachment(
    conversationId: number,
    bytes: ArrayBuffer,
    fileName: string,
    mime: string,
    opts: { caption?: string } = {},
  ): Promise<unknown> {
    this.assertToken(this.config.botToken, "POST file attachment");
    const form = new FormData();
    // NOTE: `File` pelo mesmo motivo do irmão acima, e aqui o nome é o que a pessoa lê na tela: um anexo
    // que chega chamado `blob` é um orçamento sem nome de arquivo na conversa.
    form.append("attachments[]", new File([bytes], fileName, { type: mime }));
    form.append("message_type", "outgoing");
    if (opts.caption) form.append("content", opts.caption);
    const res = await this.fetchImpl(
      `${this.accountBase}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: { [CHATWOOT_AUTH_HEADER]: this.config.botToken },
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      throw new ChatwootApiError(
        res.status,
        "POST file attachment",
        await authFailureDetail(res),
      );
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // Posts ONE message carrying several files (multipart; admin token), as a private note by default.
  // The admin token because the conversation can sit in an inbox the bot does not serve (a case opened
  // in another inbox). `private` rides in the form, which is also what lets a muted client through:
  // a note never reaches the customer.
  async sendFilesAsAdmin(
    conversationId: number,
    files: Array<{ bytes: ArrayBuffer; fileName: string; mime: string }>,
    opts: { content?: string; private?: boolean } = {},
  ): Promise<unknown> {
    this.assertToken(this.config.adminToken, "POST files");
    const form = new FormData();
    for (const f of files) {
      // NOTE: `File` and not a named Blob, for the same reason as the audio sender above.
      form.append(
        "attachments[]",
        new File([f.bytes], f.fileName, { type: f.mime }),
      );
    }
    form.append("message_type", "outgoing");
    form.append("private", opts.private === false ? "false" : "true");
    if (opts.content) form.append("content", opts.content);
    const res = await this.fetchImpl(
      `${this.accountBase}/conversations/${conversationId}/messages`,
      {
        method: "POST",
        headers: { [CHATWOOT_AUTH_HEADER]: this.config.adminToken },
        body: form,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!res.ok) {
      throw new ChatwootApiError(
        res.status,
        "POST files",
        await authFailureDetail(res),
      );
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // Sends an approved WhatsApp template (HSM) — the only message allowed outside the 24h service
  // window. Shape confirmed against the fork's sendTemplate (content + template_params). NOTE
  // (open-validation): processed_params is BODY-only here and the bot-token path for template_params
  // should be confirmed against a live approved template.
  sendTemplate(
    conversationId: number,
    p: {
      content: string;
      name: string;
      category: string;
      language: string;
      processedParams: Record<string, unknown>;
    },
  ): Promise<unknown> {
    return this.request(
      this.config.botToken,
      "POST",
      `/conversations/${conversationId}/messages`,
      {
        content: p.content,
        message_type: "outgoing",
        template_params: {
          name: p.name,
          category: p.category,
          language: p.language,
          processed_params: p.processedParams,
        },
      },
    );
  }

  // Handoff: assign to a human (assignee_type becomes "User" → the gate stops the bot).
  // asAdmin routes the call through the instance admin token instead of the persona bot, so an
  // OPERATOR-initiated action shows up as the admin in Chatwoot's audit, not as the persona.
  assignToAgent(
    conversationId: number,
    assigneeId: number,
    opts: { asAdmin?: boolean } = {},
  ): Promise<unknown> {
    return this.request(
      opts.asAdmin ? this.config.adminToken : this.config.botToken,
      "POST",
      `/conversations/${conversationId}/assignments`,
      { assignee_id: assigneeId },
    );
  }

  // Assign a TEAM (same assignments endpoint, `team_id` instead of `assignee_id`). Bot-accessible like
  // assignToAgent. Used by the handoff "pinned"/"agent_choice" targeting.
  assignTeam(
    conversationId: number,
    teamId: number,
    opts: { asAdmin?: boolean } = {},
  ): Promise<unknown> {
    return this.request(
      opts.asAdmin ? this.config.adminToken : this.config.botToken,
      "POST",
      `/conversations/${conversationId}/assignments`,
      { team_id: teamId },
    );
  }

  // Unassign the conversation's owner. `assignee_id: 0` → Chatwoot's AssignmentService does
  // `account.users.find_by(id: 0)` = nil → `conversation.assignee = nil` (source-confirmed in
  // conversations/assignment_service.rb). Required to return a conversation to the bot:
  // `toggle_status → pending` does NOT clear the assignee, so without this the gate
  // (`assignee_type !== "User"`) would keep the bot silent. assignments#create is bot-accessible.
  unassignConversation(
    conversationId: number,
    opts: { asAdmin?: boolean } = {},
  ): Promise<unknown> {
    return this.request(
      opts.asAdmin ? this.config.adminToken : this.config.botToken,
      "POST",
      `/conversations/${conversationId}/assignments`,
      { assignee_id: 0 },
    );
  }

  // Hand the conversation to an Agent Bot: on the fork, one locked write removes the person, sets the
  // bot as assignee and leaves the conversation `pending`. Says who the answer names: "bot" when it is
  // that bot (`agent_bot_slim` carries `bot_type`), "user" when a Chatwoot that ignores
  // `assignee_type` assigned the USER with that id, and null otherwise (a bot it cannot find answers
  // null). Anything but "bot" sends the caller to the plain unassign.
  async assignAgentBot(
    conversationId: number,
    agentBotId: number,
    opts: { asAdmin?: boolean } = {},
  ): Promise<"bot" | "user" | null> {
    const res = (await this.request(
      opts.asAdmin ? this.config.adminToken : this.config.botToken,
      "POST",
      `/conversations/${conversationId}/assignments`,
      { assignee_id: agentBotId, assignee_type: "AgentBot" },
    )) as { id?: unknown; bot_type?: unknown } | null;
    if (typeof res !== "object" || res === null || res.id !== agentBotId)
      return null;
    return res.bot_type !== undefined ? "bot" : "user";
  }

  // `expectedStatus` is the status the caller read before deciding: the fork applies the change only while
  // the conversation still holds it, under a row lock, and otherwise answers 409 and changes nothing,
  // raised here as ChatwootStatusConflictError. A Chatwoot without that support ignores the field.
  async toggleStatus(
    conversationId: number,
    status: "open" | "pending" | "resolved",
    opts: { asAdmin?: boolean; expectedStatus?: string } = {},
  ): Promise<unknown> {
    try {
      return await this.request(
        opts.asAdmin ? this.config.adminToken : this.config.botToken,
        "POST",
        `/conversations/${conversationId}/toggle_status`,
        opts.expectedStatus === undefined
          ? { status }
          : { status, expected_status: opts.expectedStatus },
      );
    } catch (err) {
      if (
        opts.expectedStatus !== undefined &&
        err instanceof ChatwootApiError &&
        err.status === 409
      ) {
        throw new ChatwootStatusConflictError(conversationId);
      }
      throw err;
    }
  }

  // Both custom-attribute endpoints ASSIGN the hash they are given (a plain
  // `@conversation.custom_attributes = params[...]` + `save!`, in the fork and upstream alike), so a
  // partial update reads, merges and writes; the `/reset` clear below depends on it not merging. The
  // merge base is what Chatwoot holds, never our mirror, which can lag (bots never receive
  // contact_updated) and would erase an attribute an operator just set in the UI. Serialized per
  // target because one turn's tool calls run concurrently (LangGraph's ToolNode uses Promise.all),
  // and unserialized they would merge into the same snapshot and drop each other's keys.
  setConversationCustomAttributes(
    conversationId: number,
    attributes: Record<string, unknown>,
    // The caller's fence, asked INSIDE the queue right before the write. See the note at the call.
    // `asAdmin` writes with the admin token: a conversation in an inbox the bot does not serve (a
    // case opened in another inbox) refuses the bot.
    opts: { stillWanted?: () => Promise<boolean>; asAdmin?: boolean } = {},
  ): Promise<unknown> {
    return withKeyedQueue(
      this.targetKey("conversation", conversationId),
      async () => {
        // The read uses the admin token although the write is a bot-token call:
        // `conversations#show` is in BOT_ACCESSIBLE_ENDPOINTS only on Chatwoot from 2026-06-05 on, so
        // an older instance answers a bot-token GET with 401 and every attribute write would fail.
        // The admin token is also the one guaranteed to exist (the bot token is empty outside a persona).
        const existing = (await this.request(
          this.config.adminToken,
          "GET",
          `/conversations/${conversationId}`,
        )) as { custom_attributes?: unknown } | null;
        // NOTE: The last moment before the write, inside the critical section on purpose: between the
        // caller's own fence check and this line sit the queue's wait and the GET above, and `/reset`
        // clears the attributes in that window, so a call admitted before it would put the old
        // episode's values back. Only an explicit `false` stops the write.
        await this.assertStillWanted(opts.stillWanted, "custom_attributes");
        return this.request(
          opts.asAdmin ? this.config.adminToken : this.config.botToken,
          "POST",
          `/conversations/${conversationId}/custom_attributes`,
          {
            custom_attributes: {
              ...attributeBag(existing?.custom_attributes),
              ...attributes,
            },
          },
        );
      },
    );
  }

  // The `/reset` command wipes the conversation's attributes, and it is the one caller that wants
  // the endpoint's replacing semantics. It stays a separate operation instead of being expressed as
  // `setConversationCustomAttributes(id, {})`, which the merge above turns into a no-op.
  clearConversationCustomAttributes(conversationId: number): Promise<unknown> {
    return withKeyedQueue(this.targetKey("conversation", conversationId), () =>
      this.request(
        this.config.botToken,
        "POST",
        `/conversations/${conversationId}/custom_attributes`,
        { custom_attributes: {} },
      ),
    );
  }

  // Conversation labels. The POST REPLACES the whole set, so set_labels reads the current labels
  // first and writes the set it derived. LabelConcern + labels/{index,create}.json.jbuilder render
  // `json.payload @labels`; create permits `labels: []` and calls `update_labels`. The read stays on
  // the admin token: `conversations/labels` is bot-accessible only on Chatwoot from 2026-06-05 on,
  // self-hosted versions are not ours to pick, and a read attributes nothing, so a 401 buys nothing.
  async getConversationLabels(conversationId: number): Promise<string[]> {
    const res = (await this.request(
      this.config.adminToken,
      "GET",
      `/conversations/${conversationId}/labels`,
    )) as { payload?: unknown } | null;
    const payload = res?.payload;
    return Array.isArray(payload)
      ? payload.filter((l): l is string => typeof l === "string")
      : [];
  }

  // The write is the persona's: Chatwoot names the requester on the activity line it writes, so with
  // the admin token an automated verdict would be signed by the person whose token provisioned the
  // instance. The bot token is authorized: `conversations/labels` create is in
  // BOT_ACCESSIBLE_ENDPOINTS, and the controller authorizes against `ConversationPolicy#show?`, which
  // accepts an agent bot. `asAdmin` is for an operator-initiated write, as on assignToAgent and
  // toggleStatus: /reset peels an episode's labels off because a person asked.
  async setConversationLabels(
    conversationId: number,
    labels: string[],
    opts: { asAdmin?: boolean } = {},
  ): Promise<unknown> {
    const path = `/conversations/${conversationId}/labels`;
    if (opts.asAdmin)
      return this.request(this.config.adminToken, "POST", path, { labels });
    // NOTE: Falls back to the admin token, logged, on exactly two refusals: a client built outside a
    // persona has no bot token, and an instance older than 2026-06-05 answers with
    // BOT_ENDPOINT_NOT_AUTHORIZED. Losing the attribution beats losing the label (for an observer the
    // label is the product), and a silent fallback would hide it. Not on any other 401: a revoked
    // token or a bot from another account would hide a broken credential behind a write signed by a
    // person. See the "two profiles" client section of docs/chatwoot.md.
    try {
      return await this.request(this.config.botToken, "POST", path, { labels });
    } catch (err) {
      const refused =
        err instanceof ChatwootMissingTokenError ||
        (err instanceof ChatwootApiError &&
          err.status === 401 &&
          err.reason === BOT_ENDPOINT_NOT_AUTHORIZED);
      if (!refused) throw err;
      logger.warn(
        // NOTE: Redacted: `accountBase` is the operator's base URL with only the trailing slashes
        // trimmed, so a URL carrying userinfo keeps it here. `redactEndpoint` keeps the scheme and
        // host; the account is named separately because the path it lived in is dropped.
        {
          err,
          conversationId,
          instance: redactEndpoint(this.accountBase),
          accountId: this.config.accountId,
        },
        "chatwoot: the bot could not write the labels, falling back to the admin token — the activity line will name the admin, not the agent",
      );
      return this.request(this.config.adminToken, "POST", path, { labels });
    }
  }

  // Contact labels (admin token, same LabelConcern as conversation labels — POST REPLACES the whole
  // set, so set_labels reads then writes the whole set). Shapes CONFIRMED against the chatwoot-pro fork:
  // contacts/labels/{index,create}.json.jbuilder render `json.payload @labels`; LabelsController
  // includes LabelConcern (create → model.update_labels). Route: /contacts/{id}/labels.
  async getContactLabels(contactId: number): Promise<string[]> {
    const res = (await this.request(
      this.config.adminToken,
      "GET",
      `/contacts/${contactId}/labels`,
    )) as { payload?: unknown } | null;
    const payload = res?.payload;
    return Array.isArray(payload)
      ? payload.filter((l): l is string => typeof l === "string")
      : [];
  }

  setContactLabels(contactId: number, labels: string[]): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "POST",
      `/contacts/${contactId}/labels`,
      { labels },
    );
  }

  // Account-level label TITLES (admin token). Surfaced in the set_labels description so the agent
  // picks an existing tag. Shape: GET /labels → { payload: [{ title }] }.
  async listLabels(): Promise<string[]> {
    const res = (await this.request(
      this.config.adminToken,
      "GET",
      "/labels",
    )) as { payload?: unknown } | null;
    const payload = res?.payload;
    if (!Array.isArray(payload)) return [];
    return payload
      .map((l) =>
        l && typeof l === "object"
          ? (l as { title?: unknown }).title
          : undefined,
      )
      .filter((t): t is string => typeof t === "string" && t.length > 0);
  }

  // Account labels WITH their color (admin token), for the editor's label picker. Shape confirmed
  // against the chatwoot-pro fork: labels/index.json.jbuilder renders `json.title` AND `json.color`.
  async listLabelsDetailed(): Promise<
    { title: string; color: string | null }[]
  > {
    const res = (await this.request(
      this.config.adminToken,
      "GET",
      "/labels",
    )) as { payload?: unknown } | null;
    const payload = res?.payload;
    if (!Array.isArray(payload)) return [];
    const out: { title: string; color: string | null }[] = [];
    for (const l of payload) {
      if (!l || typeof l !== "object") continue;
      const o = l as { title?: unknown; color?: unknown };
      if (typeof o.title !== "string" || o.title.length === 0) continue;
      out.push({
        title: o.title,
        color: typeof o.color === "string" ? o.color : null,
      });
    }
    return out;
  }

  // Adds (or toggles off) an emoji reaction on a message. ADMIN token: the fork's reactions controller
  // builds the reaction as an OUTGOING message authored by `Current.user`, so an AgentBot token (which
  // has no Current.user) would fail — only a real user (admin) can react. The endpoint TOGGLES:
  // re-sending the same emoji, or "", removes the active reaction. Route + shape confirmed against the
  // chatwoot-pro fork (messages/reactions#create: POST { emoji }, a single grapheme ≤ 32 bytes).
  // NOTE (open-validation): the live POST + WhatsApp delivery should be confirmed once before relying
  // on this in production (like the HSM template path).
  addMessageReaction(
    conversationId: number,
    messageId: number,
    emoji: string,
  ): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "POST",
      `/conversations/${conversationId}/messages/${messageId}/reactions`,
      { emoji },
    );
  }

  // The newest INCOMING (customer) message in the conversation — the target for react_to_message (the
  // model can't know message ids). INCLUDES reactions (with a flag) so the tool can refuse to react
  // when the customer's last message is itself a reaction (WhatsApp can't react to a reaction; reacting
  // would otherwise target the wrong, penultimate message). Admin token. Returns null when there is no
  // incoming message. message_type 0 = incoming; content_attributes.is_reaction marks a reaction.
  async getLatestIncomingMessage(
    conversationId: number,
  ): Promise<{ id: number; isReaction: boolean } | null> {
    const res = (await this.request(
      this.config.adminToken,
      "GET",
      `/conversations/${conversationId}/messages`,
      undefined,
      INTERACTIVE_TIMEOUT_MS,
    )) as { payload?: unknown } | null;
    const arr = Array.isArray(res)
      ? res
      : Array.isArray(res?.payload)
        ? res.payload
        : [];
    let best: { id: number; isReaction: boolean } | null = null;
    for (const m of arr) {
      if (!m || typeof m !== "object") continue;
      const o = m as {
        id?: unknown;
        message_type?: unknown;
        content_attributes?: { is_reaction?: unknown } | null;
      };
      if (o.message_type !== 0) continue;
      const id = Number(o.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      if (best == null || id > best.id) {
        best = { id, isReaction: o.content_attributes?.is_reaction === true };
      }
    }
    return best;
  }

  // Account custom-attribute definitions (admin token). Shape confirmed against the
  // chatwoot-pro fork: a bare array of { attribute_key, attribute_display_name, attribute_model,
  // attribute_display_type, attribute_values }.
  async listCustomAttributeDefinitions(): Promise<CustomAttributeDef[]> {
    const res = await this.request(
      this.config.adminToken,
      "GET",
      "/custom_attribute_definitions",
    );
    const arr = Array.isArray(res) ? res : [];
    const out: CustomAttributeDef[] = [];
    for (const r of arr) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      const key = typeof o.attribute_key === "string" ? o.attribute_key : "";
      if (!key) continue;
      out.push({
        key,
        displayName:
          typeof o.attribute_display_name === "string"
            ? o.attribute_display_name
            : key,
        model: typeof o.attribute_model === "string" ? o.attribute_model : "",
        displayType:
          typeof o.attribute_display_type === "string"
            ? o.attribute_display_type
            : "",
        values: Array.isArray(o.attribute_values)
          ? o.attribute_values.filter((v): v is string => typeof v === "string")
          : [],
      });
    }
    return out;
  }

  // Contact custom attributes (admin token). Same read-merge-write as the conversation scope above,
  // and same reason for the queue: PUT /contacts/{id} assigns the whole hash, and concurrent calls
  // in one turn would otherwise each merge into the pre-write snapshot they all read.
  setContactCustomAttributes(
    contactId: number,
    attributes: Record<string, unknown>,
    // NOTE: Same fence, same position, same reason as the conversation scope above.
    opts: { stillWanted?: () => Promise<boolean> } = {},
  ): Promise<unknown> {
    return withKeyedQueue(this.targetKey("contact", contactId), async () => {
      const existing = (await this.request(
        this.config.adminToken,
        "GET",
        `/contacts/${contactId}`,
      )) as { payload?: { custom_attributes?: unknown } } | null;
      await this.assertStillWanted(opts.stillWanted, `contacts/${contactId}`);
      return this.request(
        this.config.adminToken,
        "PUT",
        `/contacts/${contactId}`,
        {
          custom_attributes: {
            ...attributeBag(existing?.payload?.custom_attributes),
            ...attributes,
          },
        },
      );
    });
  }

  // Typing indicator for the split/humanized delivery. `toggle_typing_status` IS in the fork's
  // BOT_ACCESSIBLE_ENDPOINTS (confirmed against access_token_auth_helper.rb), so we use the bot
  // token — the indicator is then attributed to our bot, not to the admin agent. Best-effort (the
  // caller ignores failures). typing_status: "on" | "off".
  toggleTyping(conversationId: number, on: boolean): Promise<unknown> {
    return this.request(
      this.config.botToken,
      "POST",
      `/conversations/${conversationId}/toggle_typing_status`,
      { typing_status: on ? "on" : "off" },
    );
  }

  // Tells WhatsApp the contact's messages were read (the ticks turn blue on their phone).
  // `read_receipt` is in the fork's BOT_ACCESSIBLE_ENDPOINTS, so the bot token carries it. It writes
  // no read state inside Chatwoot, so the human agents keep the unread badge. The ids are named
  // because omitting them makes the endpoint fall back to a window over the thread. Best-effort at
  // every call site: an instance older than the endpoint answers 401 or 404, and a blue tick is never
  // worth failing a turn over.
  markRead(conversationId: number, messageIds: number[]): Promise<unknown> {
    const ids = messageIds.filter((id) => Number.isInteger(id) && id > 0);
    // NOTE: An empty list means "I processed nothing", which acknowledges nothing. Not a call.
    if (ids.length === 0) return Promise.resolve(undefined);
    return this.request(
      this.config.botToken,
      "POST",
      `/conversations/${conversationId}/read_receipt`,
      { message_ids: ids },
    );
  }

  // ── admin-token (history, provisioning, anything outside the bot allowlist) ──

  getConversation(conversationId: number): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "GET",
      `/conversations/${conversationId}`,
    );
  }

  // `before` pages backwards through history (the fork's MessageFinder honors ?before=<message_id>);
  // omitted → the most recent page (~20), used by the console's "load older messages". `after` is the
  // fork's catch-up read (`MessageFinder#messages_after`): every message with a higher id, up to a
  // hundred, WITHOUT the default page's reaction window, which keeps a reaction only when its target
  // is among the page's last twenty in the same conversation.
  getMessages(
    conversationId: number,
    opts?: { before?: number; after?: number },
    timeoutMs: number = INTERACTIVE_TIMEOUT_MS,
  ): Promise<unknown> {
    const qs =
      opts?.before != null
        ? `?before=${encodeURIComponent(String(opts.before))}`
        : opts?.after != null
          ? `?after=${encodeURIComponent(String(opts.after))}`
          : "";
    return this.request(
      this.config.adminToken,
      "GET",
      `/conversations/${conversationId}/messages${qs}`,
      undefined,
      timeoutMs,
    );
  }

  // Writes a metadata blob onto a message attachment (fork route, confirmed against
  // @fazer-ai/n8n-nodes-chatwoot updateAttachmentMeta). STT writes { transcribed_text } here so the
  // debounce re-fetch reads the transcription from the attachment instead of mirroring the body.
  updateAttachmentMeta(
    conversationId: number,
    messageId: number,
    attachmentId: number,
    meta: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "PATCH",
      `/conversations/${conversationId}/messages/${messageId}/attachments/${attachmentId}`,
      { meta },
    );
  }

  // Whether a URL is on this instance's own host: the one place an attachment is fetched from when the
  // caller must not reach anywhere else (carrying a customer's files into a case).
  isInstanceUrl(url: string): boolean {
    try {
      return new URL(url).host === new URL(this.config.baseUrl).host;
    } catch {
      return false;
    }
  }

  // Downloads an attachment by its data_url (voice note). Anti-SSRF: the URL is validated
  // (blocks internal/loopback/link-local/metadata IPs, https-only); our admin token is sent ONLY
  // when the URL is on the instance's own host (never leaked to a third-party storage/CDN origin).
  // Storage-backend redirects (e.g. S3) are followed; a size cap bounds memory. NOTE: redirect
  // targets are not re-validated (TOCTOU) — the data_url comes from the HMAC-authenticated webhook
  // of the tenant's own Chatwoot, the same trust as every other call to this instance.
  // `opts.retryOnMissing` retries a 404 on the backoff above (the file-not-written-yet race).
  async downloadAttachment(
    dataUrl: string,
    opts: AttachmentDownloadOptions = {},
  ): Promise<{ bytes: ArrayBuffer; contentType: string | null }> {
    await assertSafeOutboundUrl(dataUrl);
    let sameHost = false;
    try {
      sameHost = new URL(dataUrl).host === new URL(this.config.baseUrl).host;
    } catch {
      throw new ChatwootApiError(400, "GET attachment");
    }
    const delays = opts.retryOnMissing ? ATTACHMENT_RETRY_DELAYS_MS : [];
    const sleep = opts.sleep ?? realSleep;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(dataUrl, {
        method: "GET",
        headers: sameHost
          ? { [CHATWOOT_AUTH_HEADER]: this.config.adminToken }
          : {},
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const bytes = await res.arrayBuffer();
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          throw new ChatwootApiError(413, "GET attachment");
        }
        return { bytes, contentType: res.headers.get("content-type") };
      }
      const delay = delays[attempt];
      if (res.status !== 404 || delay === undefined) {
        throw new ChatwootApiError(res.status, "GET attachment");
      }
      await sleep(delay);
    }
  }

  // The account's display name (admin token). `GET /api/v1/accounts/:id` (the account-base root)
  // returns the account object incl. `name`; used to refresh the stored name on inbox sync (Chatwoot
  // can rename the account). Best-effort caller — returns null when absent/unparseable.
  async getAccountName(): Promise<string | null> {
    const res = (await this.request(this.config.adminToken, "GET", "")) as {
      name?: unknown;
    } | null;
    return res && typeof res.name === "string" && res.name.length > 0
      ? res.name
      : null;
  }

  // Inbox list for the mirror sync. Response is `{ payload: [{ id, name, channel_type, … }] }`
  // (confirmed against the chatwoot-pro fork's InboxPolicy/inbox index serializer).
  listInboxes(): Promise<unknown> {
    return this.request(this.config.adminToken, "GET", "/inboxes");
  }

  // One inbox's detail (admin token). Answers one question before a mirror row is destroyed: does
  // this inbox still exist in Chatwoot? `fetch_inbox` runs `find` before `authorize @inbox, :show?`,
  // so a gone inbox answers 404 before any policy check (live id → 200, absent id → 404, missing
  // token → 401). Deliberately not parsed: the caller wants the status, and a parsed body would be a
  // second thing to be wrong about.
  getInbox(inboxId: number): Promise<unknown> {
    return this.request(this.config.adminToken, "GET", `/inboxes/${inboxId}`);
  }

  // WhatsApp Cloud (official) HSM templates of an inbox, read from the inbox detail's
  // `message_templates` (admin token), returned as { name, category, language } (approved only when a
  // status is present). NOTE: baileys/zapi inboxes are also `Channel::Whatsapp` but with an unofficial
  // `provider` (no 24h window/HSM), so they carry NONE here — the editor then keeps the free-text
  // field. Shape is the Meta template object; not live-validatable on the baileys demo server
  // (open-validation, like sendTemplate).
  async listMessageTemplates(
    inboxId: number,
  ): Promise<Array<{ name: string; category: string; language: string }>> {
    const inbox = (await this.request(
      this.config.adminToken,
      "GET",
      `/inboxes/${inboxId}`,
    )) as { message_templates?: unknown } | null;
    const arr = Array.isArray(inbox?.message_templates)
      ? inbox.message_templates
      : [];
    const out: Array<{ name: string; category: string; language: string }> = [];
    for (const tpl of arr) {
      if (!tpl || typeof tpl !== "object") continue;
      const o = tpl as Record<string, unknown>;
      const name = typeof o.name === "string" ? o.name : "";
      if (!name) continue;
      const status = typeof o.status === "string" ? o.status.toLowerCase() : "";
      if (status && status !== "approved") continue;
      out.push({
        name,
        category: typeof o.category === "string" ? o.category : "",
        language: typeof o.language === "string" ? o.language : "",
      });
    }
    return out;
  }

  // Agents + teams for the handoff targeting picker. Admin token (neither is in the bot allowlist).
  // Confirmed against the chatwoot-pro fork: `/agents` and `/teams` index views render a
  // bare `json.array!` whose items carry `id` + `name`. Returned normalized to {id,name}.
  async listAgents(): Promise<Array<{ id: number; name: string }>> {
    return normalizeIdName(
      await this.request(this.config.adminToken, "GET", "/agents"),
    );
  }

  async listTeams(): Promise<Array<{ id: number; name: string }>> {
    return normalizeIdName(
      await this.request(this.config.adminToken, "GET", "/teams"),
    );
  }

  // Provisioning. createAgentBot returns the bot incl. access_token + secret (persist both
  // encrypted on the ChatwootAgentBot row); setInboxAgentBot connects the bot to an inbox.
  createAgentBot(params: {
    name: string;
    outgoingUrl: string;
    description?: string;
  }): Promise<unknown> {
    return this.request(this.config.adminToken, "POST", "/agent_bots", {
      name: params.name,
      description: params.description ?? "fazer.ai agents",
      outgoing_url: params.outgoingUrl,
    });
  }

  // Lists the account's Agent Bots ({id,name}[]) — used to detect a bot deleted out-of-band on
  // Chatwoot so ensureAgentBot can re-provision instead of reusing a dead id/token.
  async listAgentBots(): Promise<Array<{ id: number; name: string }>> {
    return normalizeIdName(
      await this.request(this.config.adminToken, "GET", "/agent_bots"),
    );
  }

  // Rename an existing Agent Bot (keeps the Chatwoot-visible sender name in sync with the persona's
  // name). Best-effort caller; PATCH to the account-scoped agent_bots resource.
  updateAgentBot(
    agentBotId: number,
    params: { name: string },
  ): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "PATCH",
      `/agent_bots/${agentBotId}`,
      { name: params.name },
    );
  }

  // The bot actually attached to an inbox, as Chatwoot has it. Our `ChatwootAgentBot` row says a bot
  // was attached once, not that the attachment stands (a UI detach or a failed reattach leaves the
  // row), and `reconcileInboxBots` asks whether the bot exists, not whether it is attached. The view
  // always renders the `agent_bot` key, `{}` when none is attached, so its emptiness (never `res.id`)
  // carries the answer. A body without the key (a Chatwoot without this route, or an unknown shape)
  // is `undefined`, so "I could not tell" never reads as "there is none". A failed request throws: an
  // unreadable read must never become a refusal built on a network blip.
  async inboxAgentBotId(inboxId: number): Promise<number | null | undefined> {
    const res = await this.request(
      this.config.adminToken,
      "GET",
      `/inboxes/${inboxId}/agent_bot`,
    );
    const bag = res as { agent_bot?: unknown } | null;
    if (!bag || typeof bag !== "object" || !("agent_bot" in bag))
      return undefined;
    const bot = bag.agent_bot as { id?: unknown } | null;
    const id = bot && typeof bot === "object" ? bot.id : undefined;
    return typeof id === "number" && Number.isFinite(id) ? id : null;
  }

  // The fork's second binding: an OBSERVER receives the inbox's events on its own route and owns
  // nothing, while `set_agent_bot` below stays the one answering bot. Admin token: the routes are
  // administrator-only. POST is idempotent on the fork. DELETE answers 404 for an inbox that is gone
  // AND for a bot that was not observing it; a Chatwoot without these routes answers 404 to both
  // verbs, and `observeInbox` reads the POST's 404 as exactly that.
  addInboxObserver(inboxId: number, agentBotId: number): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "POST",
      `/inboxes/${inboxId}/agent_bot_observers`,
      { agent_bot: agentBotId },
    );
  }

  removeInboxObserver(inboxId: number, agentBotId: number): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "DELETE",
      `/inboxes/${inboxId}/agent_bot_observers/${agentBotId}`,
    );
  }

  // Connect (numeric id) or DISCONNECT (null) the bot for an inbox. The fork's `set_agent_bot`
  // destroys the agent_bot_inbox when `agent_bot` is blank, so Chatwoot stops delivering that inbox's
  // events to us (an unbound inbox never leaves conversations stuck `pending` on a bot we ignore).
  setInboxAgentBot(
    inboxId: number,
    agentBotId: number | null,
  ): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "POST",
      `/inboxes/${inboxId}/set_agent_bot`,
      { agent_bot: agentBotId },
    );
  }

  // ── admin-token: WhatsApp→chat redirect (web widget provisioning + contact identity/merge) ──

  // Provision a Channel::WebWidget inbox. The create response carries website_token + website_url
  // always, and hmac_token ONLY when the admin token belongs to an account administrator (jbuilder
  // gate) — the redirect merge needs it, so the caller must verify it came back. hmac_mandatory is set
  // at create so only HMAC-verified identities can claim a contact via the widget.
  async createWebWidgetInbox(params: {
    name: string;
    websiteUrl: string;
    hmacMandatory?: boolean;
  }): Promise<WebWidgetInbox | null> {
    const res = await this.request(this.config.adminToken, "POST", "/inboxes", {
      name: params.name,
      channel: {
        type: "web_widget",
        website_url: params.websiteUrl,
        hmac_mandatory: params.hmacMandatory ?? true,
      },
    });
    return parseWebWidgetInbox(res);
  }

  // Read a web widget inbox's provisioning fields (admin token). `GET /inboxes/:id` returns the same
  // shape as create (website_token / hmac_token / website_url), used to re-sync the stored blob.
  async getWebWidgetInbox(inboxId: number): Promise<WebWidgetInbox | null> {
    const res = await this.request(
      this.config.adminToken,
      "GET",
      `/inboxes/${inboxId}`,
    );
    return parseWebWidgetInbox(res);
  }

  // Update a contact's identity fields (admin token). `PUT /contacts/:id` assigns the provided
  // attributes; used to stamp a stable `identifier` on the WhatsApp contact so the widget's
  // setUser(identifier, …) merges the website conversation onto it. Only provided fields are sent.
  //
  // `identifier: null` CLEARS it, and null is the only way to clear it: the unique index is
  // `(identifier, account_id)` with no partial predicate, so an empty string is a value like any other
  // and a second contact cleared that way collides with the first. Postgres does not consider two
  // NULLs equal, so nulls never do.
  updateContact(
    contactId: number,
    fields: {
      identifier?: string | null;
      phone_number?: string;
      email?: string;
      name?: string;
      // NOTE: Merged by Chatwoot into what the contact already holds
      // (contacts_controller#contact_additional_attributes), so only the keys being written are sent.
      additional_attributes?: Partial<Record<AdditionalContactField, string>>;
    },
    // NOTE: `stillWanted` is asked inside the queue, right before the write, as
    // setContactCustomAttributes does. `afterWrite` runs inside it too, once Chatwoot accepted, so
    // whatever follows the write (a mirror update) lands in the order the writes did.
    opts: {
      stillWanted?: () => Promise<boolean>;
      afterWrite?: () => Promise<void>;
    } = {},
  ): Promise<unknown> {
    // NOTE: On the contact's own queue, the one setContactCustomAttributes uses: Chatwoot answers a
    // PUT by merging `additional_attributes` and rewriting `custom_attributes` from the snapshot that
    // request loaded, so two overlapping writes to one contact lose whichever saved first.
    return withKeyedQueue(this.targetKey("contact", contactId), async () => {
      await this.assertStillWanted(opts.stillWanted, `contacts/${contactId}`);
      const res = await this.request(
        this.config.adminToken,
        "PUT",
        `/contacts/${contactId}`,
        fields,
      );
      await opts.afterWrite?.();
      return res;
    });
  }

  // A contact's current email (admin token), or null when it has none. On the contact's keyed queue,
  // so a read issued while an update_contact PUT of the same turn is still in flight waits for it and
  // answers with the address just written.
  getContactEmail(contactId: number): Promise<string | null> {
    return withKeyedQueue(this.targetKey("contact", contactId), async () => {
      const res = (await this.request(
        this.config.adminToken,
        "GET",
        `/contacts/${contactId}`,
      )) as { payload?: { email?: unknown } } | null;
      const email = res?.payload?.email;
      return typeof email === "string" && email.trim().length > 0
        ? email.trim()
        : null;
    });
  }

  // A contact's current `identifier` (admin token), or null when it has none. Addressed by id, so
  // unlike the search and filter endpoints there is no paging, no case folding and no scope that can
  // hide the row: `GET /contacts/:id` answers about exactly the contact asked for.
  async getContactIdentifier(contactId: number): Promise<string | null> {
    const res = (await this.request(
      this.config.adminToken,
      "GET",
      `/contacts/${contactId}`,
    )) as { payload?: { identifier?: unknown } } | null;
    const id = res?.payload?.identifier;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  // Merge two contacts (admin token): moves the mergee's conversations/contact_inboxes onto the base
  // and destroys the mergee. Fallback for the redirect flow when identity-validation did not unify the
  // widget visitor with the WhatsApp contact. Route is the singular action resource (NOT
  // /contacts/:id/merge): POST /actions/contact_merge { base_contact_id, mergee_contact_id }.
  mergeContacts(
    baseContactId: number,
    mergeeContactId: number,
  ): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "POST",
      "/actions/contact_merge",
      { base_contact_id: baseContactId, mergee_contact_id: mergeeContactId },
    );
  }

  // ── admin-token: opening a case in another inbox ──
  // Every write on the DESTINATION side goes through the admin token. The persona's bot is not a
  // member of the destination inbox, and the fork's conversation reuse (`continue_open_conversation`)
  // asks `ConversationPolicy#show?` about the caller: a credential that is neither an administrator
  // nor a member of that inbox has the reuse refused in silence and gets a second conversation.

  // The operator-facing dashboard link of a conversation of this account. `displayId` is the number
  // the API calls `id` (the fork serializes `display_id` there), never the internal row id.
  conversationUrl(displayId: number): string {
    return `${this.config.baseUrl.replace(/\/+$/, "")}/app/accounts/${this.config.accountId}/conversations/${displayId}`;
  }

  async getContact(contactId: number): Promise<ChatwootContact | null> {
    const res = (await this.request(
      this.config.adminToken,
      "GET",
      `/contacts/${contactId}`,
    )) as { payload?: unknown } | null;
    return parseContact(res?.payload);
  }

  // The contact holding exactly this address, or null. `/contacts/search` matches a substring across
  // several fields and pages by 15, so the rows are compared here, case-insensitively (the fork's
  // uniqueness on email is case-insensitive too), and the walk stops at the first page without rows.
  async findContactIdByEmail(email: string): Promise<number | null> {
    const wanted = email.trim().toLowerCase();
    for (let page = 1; page <= CONTACT_SEARCH_MAX_PAGES; page++) {
      const res = (await this.request(
        this.config.adminToken,
        "GET",
        `/contacts/search?q=${encodeURIComponent(wanted)}&page=${page}`,
      )) as { payload?: unknown } | null;
      const rows = Array.isArray(res?.payload) ? res.payload : [];
      if (rows.length === 0) return null;
      for (const row of rows) {
        const c = parseContact(row);
        if (c?.email && c.email.toLowerCase() === wanted) return c.id;
      }
    }
    return null;
  }

  // The contact's conversations as `{ id: display_id, inboxId, status }`.
  async listContactConversations(
    contactId: number,
  ): Promise<ChatwootConversationRef[]> {
    const res = (await this.request(
      this.config.adminToken,
      "GET",
      `/contacts/${contactId}/conversations`,
    )) as { payload?: unknown } | null;
    const rows = Array.isArray(res?.payload) ? res.payload : [];
    return rows.flatMap((row) => {
      const ref = parseConversationRef(row);
      return ref ? [ref] : [];
    });
  }

  // The contact's conversations in one inbox that are not resolved, through the conversation filter,
  // which is not capped at the newest 25 the contact listing answers. First page only (25, newest
  // activity first): a contact with more unresolved conversations than that in one inbox is not a case.
  async listUnresolvedContactConversations(
    contactId: number,
    inboxId: number,
  ): Promise<ChatwootConversationRef[]> {
    const res = (await this.request(
      this.config.adminToken,
      "POST",
      "/conversations/filter",
      {
        payload: [
          {
            attribute_key: "contact_id",
            filter_operator: "equal_to",
            values: [contactId],
            query_operator: "and",
          },
          {
            attribute_key: "inbox_id",
            filter_operator: "equal_to",
            values: [inboxId],
            query_operator: "and",
          },
          {
            attribute_key: "status",
            filter_operator: "not_equal_to",
            values: ["resolved"],
            query_operator: null,
          },
        ],
      },
    )) as { payload?: unknown } | null;
    const rows = Array.isArray(res?.payload) ? res.payload : [];
    return rows.flatMap((row) => {
      const ref = parseConversationRef(row);
      return ref ? [ref] : [];
    });
  }

  // Opens (or, when the inbox is set to continue the contact's open case, continues) a conversation
  // for the contact in the inbox. No message rides along: on a continued case the fork would post it
  // into the existing thread, and the caller decides whether an opening message is owed.
  async createConversation(p: {
    inboxId: number;
    contactId: number;
    status: "open" | "pending";
    customAttributes: Record<string, unknown>;
    additionalAttributes?: Record<string, unknown>;
  }): Promise<ChatwootConversationRef> {
    const res = await this.request(
      this.config.adminToken,
      "POST",
      "/conversations",
      {
        inbox_id: p.inboxId,
        contact_id: p.contactId,
        status: p.status,
        custom_attributes: p.customAttributes,
        ...(p.additionalAttributes
          ? { additional_attributes: p.additionalAttributes }
          : {}),
      },
    );
    const ref = parseConversationRef(res);
    if (!ref) {
      throw new ChatwootApiError(502, "POST /conversations: missing id");
    }
    return ref;
  }

  sendMessageAsAdmin(
    conversationId: number,
    content: string,
    opts: { private: boolean },
  ): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "POST",
      `/conversations/${conversationId}/messages`,
      { content, private: opts.private, message_type: "outgoing" },
    );
  }

  // `originDisplayId` is the conversation the link is SENT ON (the WhatsApp entry thread): the mint
  // is the only moment both halves of a redirect episode are known together, since the resolve
  // endpoint identifies the CONTACT, not which of its conversations minted the link. The fork carries
  // it in the token and stamps it on the widget conversation, where it reaches us on the webhook
  // payload. An origin this token cannot see is REFUSED (404/401), not dropped, so a link whose
  // episode could not be paired is never handed back.
  async mintRedirectToken(p: {
    inboxId: number;
    identifier: string;
    // Whose identity this link carries. The identifier cannot answer it: `fzwa:<X>` is derived from a
    // sequential contact id (guessable), and it can move off the contact before the click, leaving the
    // lead with two contacts and a squatted identifier. The mint is admin-authenticated, so naming the
    // contact here is a fact the widget side can spend.
    contactId: number;
    message?: string;
    ttlSeconds?: number;
    originDisplayId?: number;
  }): Promise<{ token: string; websiteUrl: string | null }> {
    const res = (await this.request(
      this.config.adminToken,
      "POST",
      "/redirect_tokens",
      {
        inbox_id: p.inboxId,
        identifier: p.identifier,
        contact_id: p.contactId,
        message: p.message,
        ttl_seconds: p.ttlSeconds,
        origin_display_id: p.originDisplayId,
      },
    )) as { token?: string; website_url?: string | null } | null;
    if (!res?.token) {
      throw new ChatwootApiError(502, "mintRedirectToken: missing token");
    }
    return { token: res.token, websiteUrl: res.website_url ?? null };
  }

  // ── admin-token: Kanban driver (Pro) ──
  // Drives the funnel/board/step/card model the fazer.ai Chatwoot Pro owns (fazer.ai agents has no
  // Funnel/Card tables of its own). Routes: /kanban/{boards,boards/:id/steps,tasks}. The
  // create/update bodies wrap the Rails-required root key (board/step/task); their inner shape
  // is owned by the /desenhar-funil wizard, so they are passed through as records.
  // Move/bind params are fork-confirmed (board_step_id, inbox_ids, agent_ids).

  listKanbanBoards(): Promise<unknown> {
    return this.request(this.config.adminToken, "GET", "/kanban/boards");
  }

  createKanbanBoard(board: Record<string, unknown>): Promise<unknown> {
    return this.request(this.config.adminToken, "POST", "/kanban/boards", {
      board,
    });
  }

  updateKanbanBoard(
    boardId: number,
    board: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "PUT",
      `/kanban/boards/${boardId}`,
      { board },
    );
  }

  listKanbanSteps(boardId: number): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "GET",
      `/kanban/boards/${boardId}/steps`,
    );
  }

  createKanbanStep(
    boardId: number,
    step: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "POST",
      `/kanban/boards/${boardId}/steps`,
      { step },
    );
  }

  // Bind the board to a set of inboxes / agents (idempotent diff on the Chatwoot side).
  setBoardInboxes(boardId: number, inboxIds: number[]): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "POST",
      `/kanban/boards/${boardId}/update_inboxes`,
      { inbox_ids: inboxIds },
    );
  }

  setBoardAgents(boardId: number, agentIds: number[]): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "POST",
      `/kanban/boards/${boardId}/update_agents`,
      { agent_ids: agentIds },
    );
  }

  listKanbanTasks(boardId?: number): Promise<unknown> {
    const path =
      boardId != null ? `/kanban/tasks?board_id=${boardId}` : "/kanban/tasks";
    return this.request(this.config.adminToken, "GET", path);
  }

  createKanbanTask(task: Record<string, unknown>): Promise<unknown> {
    return this.request(this.config.adminToken, "POST", "/kanban/tasks", {
      task,
    });
  }

  // Move a card to another step (and optionally reorder before a sibling). board_step_id +
  // insert_before_task_id are the fork's tasks#move params.
  moveKanbanTask(
    taskId: number,
    boardStepId: number,
    insertBeforeTaskId?: number,
  ): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "POST",
      `/kanban/tasks/${taskId}/move`,
      {
        board_step_id: boardStepId,
        ...(insertBeforeTaskId != null
          ? { insert_before_task_id: insertBeforeTaskId }
          : {}),
      },
    );
  }

  // GET is the SHOW action, and its body is the bare task, not an envelope: `tasks/show.json.jbuilder`
  // is `json.partial! 'task', task: @task` and `_task.json.jbuilder:21` renders
  // `json.labels task.cached_label_list_array`, a plain array of strings. `set_labels` reads
  // `.labels` off this response directly, and an envelope would make that `undefined`, so an `add`
  // would write the card with only the added label and ZERO the rest.
  getKanbanTask(taskId: number): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "GET",
      `/kanban/tasks/${taskId}`,
    );
  }

  // Merge custom attributes onto a kanban task (PATCH wraps the Rails `task` root key; the task's
  // custom_attributes is a jsonb that the update assigns, so we merge in the caller).
  setKanbanTaskCustomAttributes(
    taskId: number,
    customAttributes: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "PATCH",
      `/kanban/tasks/${taskId}`,
      { task: { custom_attributes: customAttributes } },
    );
  }

  // Kanban task labels (admin token). The fork's tasks#update accepts `task: { labels: [...] }` and
  // calls update_labels, which REPLACES the whole set (same acts_as_taggable as conversation/contact),
  // so set_labels reads the current set (FRESH, by `getKanbanTask` at call time, not from the
  // turn-prep snapshot) and writes the whole one. Shape per the fork's
  // tasks_controller#update_task_labels; _task.json.jbuilder renders
  // `json.labels task.cached_label_list_array`.
  setKanbanTaskLabels(taskId: number, labels: string[]): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "PATCH",
      `/kanban/tasks/${taskId}`,
      { task: { labels } },
    );
  }

  // Update scalar fields of a kanban task (admin token, PATCH wraps the Rails `task` root key). The
  // fork's tasks#update permits title/description/priority/start_date/due_date among others (CONFIRMED
  // against chatwoot-pro-main: task_params permit list; priority ∈ Task::PRIORITIES urgent|high|medium|
  // low; start_date/due_date are :datetime with start ≤ due). Only the provided keys are sent (partial
  // update). value/board_step_id/labels/custom_attributes have their own paths and are NOT sent here.
  // Clearable fields (description/start_date/due_date) accept `null` to wipe the value (used by
  // /reset). NOTE (open-validation): nulling a :datetime via the fork's task_params should be
  // confirmed once against a live card.
  updateKanbanTask(
    taskId: number,
    fields: {
      title?: string;
      description?: string | null;
      priority?: "urgent" | "high" | "medium" | "low";
      startDate?: string | null;
      dueDate?: string | null;
    },
  ): Promise<unknown> {
    const task: Record<string, unknown> = {};
    if (fields.title !== undefined) task.title = fields.title;
    if (fields.description !== undefined) task.description = fields.description;
    if (fields.priority !== undefined) task.priority = fields.priority;
    if (fields.startDate !== undefined) task.start_date = fields.startDate;
    if (fields.dueDate !== undefined) task.due_date = fields.dueDate;
    return this.request(
      this.config.adminToken,
      "PATCH",
      `/kanban/tasks/${taskId}`,
      { task },
    );
  }

  // The kanban card (task) id linked to a conversation, read from the embedded `kanban_task` OBJECT the
  // Pro fork renders on the conversation payload, NOT a flat `kanban_task_id` (the jbuilder never emits
  // that key, so reading it leaves the card context empty). null when there is no card.
  async kanbanTaskIdForConversation(
    conversationId: number,
  ): Promise<number | null> {
    const conv = (await this.getConversation(conversationId)) as {
      kanban_task?: { id?: unknown } | null;
    } | null;
    const id = Number(conv?.kanban_task?.id);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  // The kanban card (task) OBJECT linked to a conversation. The Pro fork embeds the whole card under
  // `kanban_task` on the conversation payload (`json.kanban_task do … partial 'kanban/tasks/task'` —
  // SAME shape as GET /kanban/tasks/:id), per conversations/_conversation.json.jbuilder.
  // Returns the raw object so turn-prep builds the kanban context from ONE conversation
  // GET (no extra task fetch); null when the conversation has no card. NOTE: the embedded board.steps
  // carry only {id,name,color}; per-step description/cancelled come from the board_steps endpoint.
  async kanbanTaskForConversation(
    conversationId: number,
  ): Promise<Record<string, unknown> | null> {
    const conv = (await this.getConversation(conversationId)) as {
      kanban_task?: unknown;
    } | null;
    const task = conv?.kanban_task;
    return task && typeof task === "object" && !Array.isArray(task)
      ? (task as Record<string, unknown>)
      : null;
  }
}

// Validates the tenant-configured baseUrl (anti-SSRF, https-only) before any call is possible.
export async function createChatwootClient(
  config: ChatwootClientConfig,
  deps: ChatwootClientDeps = {},
): Promise<ChatwootClient> {
  const assertSafe = deps.assertSafe ?? assertSafeOutboundUrl;
  await assertSafe(config.baseUrl);
  return new ChatwootClient(config, deps.fetchImpl ?? fetch);
}

// Fetches the token owner's profile via the USER-scoped endpoint (`/api/v1/profile`, NOT
// `/api/v1/accounts/:id/...`). Used by instance setup to discover which accounts a (baseUrl, token)
// pair can reach BEFORE an instance — and therefore an accountId — exists, so the operator picks
// the account from a list instead of hunting for the numeric id. Anti-SSRF + https-only on baseUrl;
// the short interactive timeout keeps the setup form responsive. Never logs the token; the error
// carries only the status + endpoint. Returns the raw profile JSON for a pure parser to shape.
export async function fetchChatwootProfile(
  params: { baseUrl: string; token: string },
  deps: ChatwootClientDeps = {},
): Promise<unknown> {
  const assertSafe = deps.assertSafe ?? assertSafeOutboundUrl;
  await assertSafe(params.baseUrl);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const root = params.baseUrl.replace(/\/+$/, "");
  const res = await fetchImpl(`${root}/api/v1/profile`, {
    method: "GET",
    headers: {
      [CHATWOOT_AUTH_HEADER]: params.token,
      accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(INTERACTIVE_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new ChatwootApiError(
      res.status,
      "GET /profile",
      await authFailureDetail(res),
    );
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
