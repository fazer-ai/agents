import { withKeyedQueue } from "@/lib/locks";
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

// An auth failure names three very different operator actions under ONE status. Checked against the
// fork's source (chatwoot-pro at 4.16.2): `render_unauthorized(message)` answers `{error: message}`
// with **401** for both "Invalid Access Token" (the token is absent or wrong) and "Access to this
// endpoint is not authorized for bots" (the endpoint is outside BOT_ACCESSIBLE_ENDPOINTS), so the
// status alone cannot tell a missing credential from a forbidden endpoint. Every `status: :forbidden`
// in that tree renders a fixed English string the same way ("API access is not enabled for this
// account", "Access Denied", …), and none of those bodies carries conversation or contact data.
//
// That is why the body is read HERE and only here, and even here nothing from it is ever repeated:
// the parsed reason has to MATCH one of the strings below to be named. Parsing as JSON does not prove
// the response came from Chatwoot — the base URL is tenant-configured and a proxy in front of it can
// answer whatever it likes, including `{"error":"<customer data>"}`, which would land in shared logs
// through the callers' `errMsg(err)`. An allowlist keeps the three cases this exists to separate and
// gives up on everything else, which is exactly the old behavior for anything unrecognized.
const KNOWN_AUTH_REASONS: ReadonlySet<string> = new Set([
  // access_token_auth_helper.rb: the token is blank or matches no user.
  "Invalid Access Token",
  // access_token_auth_helper.rb: the endpoint is outside BOT_ACCESSIBLE_ENDPOINTS.
  "Access to this endpoint is not authorized for bots",
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
// A custom_attributes bag as Chatwoot renders it, or {} for anything that is not a plain object.
// Arrays are excluded on purpose: spreading one produces index keys, which would then be written
// back as real attributes.
function attributeBag(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

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

  // A client can legitimately be built with only the admin token (callers that never act as the
  // persona). Sending the empty one anyway is what issue #79 was: Chatwoot answers 401 and a
  // best-effort catch reports it as if the remote had rejected a real credential. Refusing here names
  // the actual fault — this process built a client without the token this call needs. Called by
  // `request` AND by the multipart senders, which build their own fetch and would otherwise slip past.
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
    this.assertToken(this.config.botToken, "POST audio message");
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

  // Both custom-attribute endpoints ASSIGN the hash they are given, so a partial update has to
  // read-merge-write against either one. MEASURED against the deployed fork on 2026-08-18 with a
  // rolled-back `rails runner` probe: POST /conversations/{id}/custom_attributes with {produto:"A"}
  // then {medida:"B"} leaves {medida:"B"} — `produto` is gone. The action is a plain
  // `@conversation.custom_attributes = params[...]` + `save!`, with no setter override on the model,
  // and it is byte-identical in upstream Chatwoot. The comment that used to sit here claimed the
  // conversation endpoint merged server-side; it never did, and the `/reset` clear below is the
  // caller that always depended on it not merging.
  //
  // The merge base is what CHATWOOT holds, never our mirror: the mirror is a projection that can lag
  // (bots never receive contact_updated), and merging from it would erase an attribute an operator
  // had just set in the UI.
  //
  // Serialized per target because one turn's tool calls run CONCURRENTLY — LangGraph's ToolNode runs
  // them with Promise.all — and unserialized they would all merge into the same pre-write snapshot,
  // so the last write would drop the others' keys (issue #112).
  setConversationCustomAttributes(
    conversationId: number,
    attributes: Record<string, unknown>,
  ): Promise<unknown> {
    return withKeyedQueue(
      this.targetKey("conversation", conversationId),
      async () => {
        // The READ goes out with the admin token even though the write next to it is a bot-token
        // call. `conversations#show` only entered Chatwoot's BOT_ACCESSIBLE_ENDPOINTS on 2026-06-05
        // (upstream #14655, "allow agent bots to read conversations and manage labels"), so on any
        // older instance a bot-token GET is answered with 401 and every attribute write would fail
        // before the POST. The admin token is also the one guaranteed to exist: it comes from the
        // deployment row, while the bot token is empty for clients built outside a persona.
        const existing = (await this.request(
          this.config.adminToken,
          "GET",
          `/conversations/${conversationId}`,
        )) as { custom_attributes?: unknown } | null;
        return this.request(
          this.config.botToken,
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

  // Contact custom attributes (admin token). Same read-merge-write as the conversation scope above,
  // and same reason for the queue: PUT /contacts/{id} assigns the whole hash, and concurrent calls
  // in one turn would otherwise each merge into the pre-write snapshot they all read.
  setContactCustomAttributes(
    contactId: number,
    attributes: Record<string, unknown>,
  ): Promise<unknown> {
    return withKeyedQueue(this.targetKey("contact", contactId), async () => {
      const existing = (await this.request(
        this.config.adminToken,
        "GET",
        `/contacts/${contactId}`,
      )) as { payload?: { custom_attributes?: unknown } } | null;
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

  // One inbox's detail (admin token). Exists to answer ONE question before a mirror row is
  // destroyed: does this inbox still exist in Chatwoot? `fetch_inbox` resolves it with
  // `Current.account.inboxes.find(params[:id])` and only THEN runs `authorize @inbox, :show?`, so an
  // inbox that is gone raises RecordNotFound before any policy check and Rails answers 404.
  // Measured live against the fork (2026-08-25): live id → 200 with the inbox JSON, absent id → 404
  // {"error":"Resource could not be found"}, missing token → 401. Deliberately NOT parsed here — the
  // caller wants the STATUS, and any body we could parse would be a second thing to be wrong about.
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
    },
  ): Promise<unknown> {
    return this.request(
      this.config.adminToken,
      "PUT",
      `/contacts/${contactId}`,
      fields,
    );
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

  // NOTE: `originDisplayId` is the conversation the link is being SENT ON (the WhatsApp entry
  // thread), and the mint is the only moment the two halves of a redirect episode are known
  // together — the resolve endpoint identifies the CONTACT, and a contact does not say which of its
  // conversations minted the link (issue #222). The fork carries it in the token and stamps it on
  // the widget conversation, where it reaches us on the webhook payload. It authorizes the value
  // against the caller: an origin this token cannot see is REFUSED (404/401), not dropped, so a
  // link whose episode could not be paired is never handed back.
  async mintRedirectToken(p: {
    inboxId: number;
    identifier: string;
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
