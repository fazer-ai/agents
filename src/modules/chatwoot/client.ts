import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { CHATWOOT_AUTH_HEADER } from "./constants";

// Chatwoot Application API client with the dual-identity profiles (validated against the
// chatwoot-pro fork's BOT_ACCESSIBLE_ENDPOINTS):
//   * bot-token  → send messages (outgoing + private note), assign (handoff), toggle status,
//     set custom attributes. This is the whole gate loop.
//   * admin-token → read history (conversation/messages), provision the bot, connect inboxes,
//     and everything else not in the bot allowlist (labels, contacts, agents, Kanban).
// Auth header is CHATWOOT_AUTH_HEADER (hyphenated; see constants.ts for the proxy reason). The
// conversation id in these paths is the display_id.
//
// The baseUrl is tenant-configured → validated once at construction (anti-SSRF, https-only).
// The host is fixed for every call and the path is our code, so per-call revalidation is
// unnecessary; the DNS-rebinding caveat from src/lib/ssrf.ts applies (tracked).

const REQUEST_TIMEOUT_MS = 15_000;

// Cap a downloaded attachment (voice note) so a hostile/huge file cannot exhaust memory. WhatsApp
// voice notes are small; 25 MB is generous headroom.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// A shorter ceiling for interactive reads (the conversation-detail UI). The default 15s is fine for
// background/agent calls, but an operator clicking a conversation must not hang 15s when Chatwoot is
// slow/unreachable — fail fast so the caller can degrade gracefully (serve metadata + a retry).
const INTERACTIVE_TIMEOUT_MS = 10_000;

// NOTE: Chatwoot fires `message_created` (with the attachment's data_url already in the payload)
// BEFORE ActiveStorage finishes writing the file, so an immediate GET on a fresh voice note loses the
// race and the storage service answers 404. Measured on a disk-backed instance: the blob row is
// committed ~400ms before the file lands, and the eager-media download fires ~70ms after the webhook.
// These delays cover that window with headroom while staying well inside a typical debounce window.
// Only 404 is retried (missing file); every other status is a real error and fails immediately.
const ATTACHMENT_RETRY_DELAYS_MS = [250, 750, 1500];

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class ChatwootApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  constructor(status: number, endpoint: string) {
    // NOTE: never capture the response body — it carries customer PII / message content.
    super(`Chatwoot API ${status} for ${endpoint}`);
    this.name = "ChatwootApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

export interface ChatwootClientConfig {
  baseUrl: string;
  accountId: number;
  adminToken: string;
  botToken: string;
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
    this.fetchImpl = fetchImpl;
    const root = config.baseUrl.replace(/\/+$/, "");
    this.accountBase = `${root}/api/v1/accounts/${config.accountId}`;
  }

  private async request(
    token: string,
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
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
    if (!res.ok) throw new ChatwootApiError(res.status, `${method} ${path}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // ── bot-token (the gate loop) ──

  sendMessage(
    conversationId: number,
    content: string,
    opts: { private?: boolean; messageType?: ChatwootMessageType } = {},
  ): Promise<unknown> {
    return this.request(
      this.config.botToken,
      "POST",
      `/conversations/${conversationId}/messages`,
      {
        content,
        private: opts.private ?? false,
        message_type: opts.messageType ?? "outgoing",
      },
    );
  }

  // Transfer-with-summary posts the summary as a private note BEFORE the human takes over.
  sendPrivateNote(conversationId: number, content: string): Promise<unknown> {
    return this.sendMessage(conversationId, content, { private: true });
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
    opts: { transcribedText?: string } = {},
  ): Promise<unknown> {
    const form = new FormData();
    form.append("attachments[]", new Blob([audio], { type: mime }), fileName);
    form.append("message_type", "outgoing");
    form.append("is_recorded_audio", JSON.stringify([fileName]));
    if (opts.transcribedText) {
      form.append(
        `attachments_metadata[${fileName}][transcribed_text]`,
        opts.transcribedText,
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
    if (!res.ok) throw new ChatwootApiError(res.status, "POST audio message");
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
    const form = new FormData();
    form.append("attachments[]", new Blob([bytes], { type: mime }), fileName);
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
    if (!res.ok) throw new ChatwootApiError(res.status, "POST file attachment");
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
  assignTeam(conversationId: number, teamId: number): Promise<unknown> {
    return this.request(
      this.config.botToken,
      "POST",
      `/conversations/${conversationId}/assignments`,
      { team_id: teamId },
    );
  }

  // Unassign the conversation's owner. `assignee_id: 0` → Chatwoot's AssignmentService does
  // `account.users.find_by(id: 0)` = nil → `conversation.assignee = nil` (source-confirmed in
  // conversations/assignment_service.rb). Required to return a conversation to the bot: a live probe
  // confirmed `toggle_status → pending` does NOT clear the assignee, so without this the gate
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

  toggleStatus(
    conversationId: number,
    status: "open" | "pending" | "resolved",
    opts: { asAdmin?: boolean } = {},
  ): Promise<unknown> {
    return this.request(
      opts.asAdmin ? this.config.adminToken : this.config.botToken,
      "POST",
      `/conversations/${conversationId}/toggle_status`,
      { status },
    );
  }

  setConversationCustomAttributes(
    conversationId: number,
    attributes: Record<string, unknown>,
  ): Promise<unknown> {
    return this.request(
      this.config.botToken,
      "POST",
      `/conversations/${conversationId}/custom_attributes`,
      { custom_attributes: attributes },
    );
  }

  // Conversation labels (admin token — labels are NOT in the bot allowlist). The POST REPLACES the
  // whole set, so the assign_label native tool reads the current labels first and appends. Shapes
  // CONFIRMED against the chatwoot-pro fork (2026-06-14): LabelConcern + labels/{index,create}.json
  // .jbuilder render `json.payload @labels`; create permits `labels: []` and calls `update_labels`.
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

  setConversationLabels(
    conversationId: number,
    labels: string[],
  ): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "POST",
      `/conversations/${conversationId}/labels`,
      { labels },
    );
  }

  // Contact labels (admin token, same LabelConcern as conversation labels — POST REPLACES the whole
  // set, so assign_label reads then appends). Shapes CONFIRMED against the chatwoot-pro fork:
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

  // Account-level label TITLES (admin token). Surfaced in the assign_label description so the agent
  // picks an existing tag. Shape confirmed (2026-06-14): GET /labels → { payload: [{ title }] }.
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

  // Account custom-attribute definitions (admin token). Shape confirmed (2026-06-14) against the
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

  // Contact custom attributes (admin token). PUT /contacts/{id} assigns the whole custom_attributes
  // hash, so we READ-MERGE-WRITE to avoid clobbering other attributes (the conversation endpoint
  // merges server-side; the contact one does not).
  async setContactCustomAttributes(
    contactId: number,
    attributes: Record<string, unknown>,
  ): Promise<unknown> {
    const existing = (await this.request(
      this.config.adminToken,
      "GET",
      `/contacts/${contactId}`,
    )) as { payload?: { custom_attributes?: unknown } } | null;
    const current =
      existing?.payload?.custom_attributes &&
      typeof existing.payload.custom_attributes === "object"
        ? (existing.payload.custom_attributes as Record<string, unknown>)
        : {};
    return this.request(
      this.config.adminToken,
      "PUT",
      `/contacts/${contactId}`,
      { custom_attributes: { ...current, ...attributes } },
    );
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

  // ── admin-token (history, provisioning, anything outside the bot allowlist) ──

  getConversation(conversationId: number): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "GET",
      `/conversations/${conversationId}`,
    );
  }

  // `before` pages backwards through history (the fork's MessageFinder honors ?before=<message_id>,
  // returning the page of messages older than that id). Omitted → the most recent page (~20). Used by
  // the console's "load older messages" on scroll-up.
  getMessages(
    conversationId: number,
    opts?: { before?: number },
    timeoutMs: number = INTERACTIVE_TIMEOUT_MS,
  ): Promise<unknown> {
    const qs =
      opts?.before != null
        ? `?before=${encodeURIComponent(String(opts.before))}`
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
  // CONFIRMED against the chatwoot-pro fork (2026-06-14): `/agents` and `/teams` index views render a
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

  // Connect (numeric id) or DISCONNECT (null) the bot for an inbox. The fork's `set_agent_bot`
  // destroys the agent_bot_inbox when `agent_bot` is blank — disconnecting stops Chatwoot from
  // delivering that inbox's events to us (so an unbound inbox never leaves conversations stuck
  // `pending` on a bot we ignore).
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
  updateContact(
    contactId: number,
    fields: {
      identifier?: string;
      phone_number?: string;
      email?: string;
      name?: string;
    },
  ): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "PUT",
      `/contacts/${contactId}`,
      fields,
    );
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

  async mintRedirectToken(p: {
    inboxId: number;
    identifier: string;
    message?: string;
    ttlSeconds?: number;
  }): Promise<{ token: string; websiteUrl: string | null }> {
    const res = (await this.request(
      this.config.adminToken,
      "POST",
      "/redirect_tokens",
      {
        inbox_id: p.inboxId,
        identifier: p.identifier,
        message: p.message,
        ttl_seconds: p.ttlSeconds,
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
  // so assign_label reads the current set (from the card snapshot) then appends. Shape CONFIRMED
  // against the chatwoot-pro `feat-kanban-task-labels` branch (tasks_controller#update_task_labels;
  // _task.json.jbuilder renders `json.labels task.cached_label_list_array`).
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
  // Pro fork renders on the conversation payload — NOT a flat `kanban_task_id` (the jbuilder never emits
  // that key, which is the bug that left the card context empty). null when there is no card.
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
  // SAME shape as GET /kanban/tasks/:id), confirmed against conversations/_conversation.json.jbuilder
  // (2026-06-21). Returns the raw object so turn-prep builds the kanban context from ONE conversation
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
  if (!res.ok) throw new ChatwootApiError(res.status, "GET /profile");
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
