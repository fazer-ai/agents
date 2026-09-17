// The HTTP header fazer.ai agents uses to authenticate to a Chatwoot instance.
//
// Chatwoot documents this header as `api_access_token` (underscore), but reverse proxies DROP request
// headers whose names contain underscores — a long-standing CGI/RFC-3875 ambiguity defense (both `-`
// and `_` collapse to `_` in the CGI var, so an underscore header could spoof a hyphen one the proxy
// itself sets; nginx ships `underscores_in_headers off`, and the Caddy bundled with Chatwoot drops them
// too). So the underscore spelling 401s through a proxied public URL while working only on a direct or
// internal hop.
//
// Rails (Rack) normalizes `-` and `_` to the same `HTTP_API_ACCESS_TOKEN`, so the HYPHEN spelling is
// read identically by Chatwoot AND survives every proxy. We therefore send the hyphen everywhere we
// authenticate to Chatwoot: the client calls (client.ts) AND the `chatwoot_api_token` vault injection
// (secret-types.ts), which agent HTTP tools and the credential connectivity test go through. Verified
// end-to-end against a live Chatwoot Pro: hyphen returns 200 both through Caddy and direct to puma;
// underscore 401s through Caddy and 200s direct (proving the proxy, not Chatwoot, is what drops it).
export const CHATWOOT_AUTH_HEADER = "api-access-token";

// THE NAME A SEND GIVES ITSELF, so a delivery can be proved without comparing text (issue #499).
//
// A `POST /messages` that hits its deadline may or may not have been written on the far side, and
// the only party that knows is Chatwoot. Asking it used to mean looking for the CONTENT, which is
// not an identity: a conversation legitimately holds the same words twice, so the search needed a
// boundary, the boundary needed a read of its own, and that read is the first thing an overloaded
// Chatwoot drops — the same overload that caused the timeout. Two production duplicates came
// through that gap (issue #499).
//
// A key inside `content_attributes` closes it: the send names itself before it leaves, and the
// read-back asks for that name. MEASURED against the fork (chatwoot-pro, `Messages::MessageBuilder`,
// `message_params`): `content_attributes` handed to the create is persisted verbatim and comes back
// on `GET /conversations/:id/messages`, with no migration and no allowlist to add to.
//
// Namespaced because the bag is shared with Chatwoot's own keys (`in_reply_to`, `is_reaction`) and
// with anything the operator's own automations write there.
export const CHATWOOT_SEND_ID_KEY = "fazer_ai_send_id";

// THE NAME `/reset` PUTS ON ITS OWN ACKNOWLEDGEMENT, so a later reader can tell where the command's
// cleanup ENDED (issue #642, round 21).
//
// `reset_at_message_id` is the id of the command's own MESSAGE, and the cleanup that follows is a
// dozen un-serialized Chatwoot calls, so every row the command wrote — the label removal above all
// — carries an id ABOVE that boundary and looks like history of the episode the reset just erased.
// The acknowledgement is posted only once every cleanup step has run, so its own id is the end of
// that stretch, exactly, and a customer message racing the cleanup cannot be mistaken for it.
//
// Carries the command's message id so a reader holding one boundary matches that reset's ack and no
// other. `content_attributes` is written by whoever posts the message, which is this build.
// THE LABELS `/reset` REMOVED, on its own acknowledgement (issue #645).
//
// The ack's id was the end of the cleanup, and that was an ORDER test: the label-change activity is
// not written by the labels request, it is handed to `Conversations::ActivityMessageJob.perform_later`,
// so on an install whose queues are backed up the row lands ABOVE the ack and the cut does not see
// it. Naming the SET instead makes the reader's question a content one, and the order stops
// mattering — which is why this key replaces that cut rather than joining it.
//
// Same bag and the same reason as `CHATWOOT_SEND_ID_KEY`: written by whoever posts the message,
// which is this build, and echoed back on `GET /conversations/:id/messages`, with no migration and
// no allowlist to add to. Namespaced because the bag is shared.
export const CHATWOOT_RESET_CLEARED_LABELS_KEY = "fazer_ai_reset_cleared";

export function resetAckSendId(commandMessageId: number): string {
  return `reset-ack:${commandMessageId}`;
}
