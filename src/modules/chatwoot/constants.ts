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
