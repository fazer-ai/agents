// The HTTP header fazer.ai agents uses to authenticate to a Chatwoot instance. Chatwoot documents
// `api_access_token`, but reverse proxies drop request headers whose names contain underscores
// (nginx `underscores_in_headers off`, and the Caddy bundled with Chatwoot), so that spelling 401s
// through a proxied public URL. Rack reads `-` and `_` as the same `HTTP_API_ACCESS_TOKEN`, so the
// hyphen is read identically by Chatwoot and survives every proxy. Every Chatwoot call sends it: the
// client (client.ts) and the `chatwoot_api_token` vault injection (secret-types.ts).
export const CHATWOOT_AUTH_HEADER = "api-access-token";

// The name a send gives itself, so a delivery can be proved without comparing text. A
// `POST /messages` that hits its deadline may or may not have landed. Content is no identity (a
// conversation can hold the same words twice, and a content search needs a boundary read that an
// overloaded Chatwoot drops first), so the read-back asks for this name. The fork persists
// `content_attributes` from the create verbatim (`Messages::MessageBuilder#message_params`) and
// returns it on `GET /conversations/:id/messages`. Namespaced because the bag is shared with
// Chatwoot's own keys (`in_reply_to`, `is_reaction`) and with the operator's own automations.
export const CHATWOOT_SEND_ID_KEY = "fazer_ai_send_id";

// The whole reply a voice note was cut from, set when the cut took something out. The attachment's
// `transcribed_text` is the words actually said, so a URL or an address leaves a hole in it; when
// the channel refuses the audio, the text sent in its place is read from here. It comes back on the
// failure webhook because Chatwoot merges `external_error` into this bag. A website inbox showing
// the bag to the contact shows only the reply they were already being sent.
export const CHATWOOT_REPLY_TEXT_KEY = "fazer_ai_reply_text";

// Set on a voice note whose words are the operator's (a guardrail's template or hand-over message),
// so the text sent in its place keeps Chatwoot's Liquid instead of being escaped as a model's.
export const CHATWOOT_REPLY_BY_OPERATOR_KEY = "fazer_ai_reply_by_operator";

// The name `/reset` puts on its own acknowledgement, so a reader can tell where the command's
// cleanup ended: every row the cleanup writes carries an id above `reset_at_message_id`, and the ack
// is posted only after every cleanup step has run, so its id closes that stretch. Carries the
// command's message id so a reader holding one boundary matches that reset's ack and no other. The
// labels the cleanup removed live in `conversations.reset_cleared_labels`, not in this bag: a public
// message's `content_attributes` reaches the contact on a website inbox (the widget's messages
// jbuilder renders it verbatim), and internal label names are not the customer's.
export function resetAckSendId(commandMessageId: number): string {
  return `reset-ack:${commandMessageId}`;
}
