# External guardrail check

An operator who already runs their own checks (a verifier that compares a reply with the sources it was built from, a compliance rule engine, a review desk) can put them in front of delivery. Before a reply to a customer message is delivered, the agent POSTs the turn to an endpoint the operator configures, and the endpoint decides. Issue #1514; code in `src/modules/guardrails/external.ts`.

## Configuration

`settings.guardrails.external`, on the agent's Guardrails tab (section "External check"), REST and MCP:

| field | meaning |
| --- | --- |
| `url` | `https` only, with no credentials in it. Null turns the check off. |
| `credentialRef` | Vault reference of the HMAC signing secret, a plain string (a managed OAuth entry is refused at write). Null sends the request unsigned. |
| `sendToolValues` | Default `true`. `false` sends each tool call's name and sizes without its arguments and result. |

The section's "Request and response format" button opens this contract in the console, in the operator's language (sample values only; keys, decisions and headers stay as on the wire), with a copy button per example and one that copies the whole thing as Markdown. `tests/client/external-check-contract.test.tsx` holds its examples to `buildExternalRequest` and `readExternalAnswer`.

The check runs when `guardrails.enabled` is on and `url` is set. It does not need the built-in output direction to be on, but a `block` uses that direction's action and messages (`output.action`, `templateMessage`, `handoffMessage`). The call goes through the same outbound guard as every other outbound request (`assertSafeOutboundUrl`): a private or loopback address is refused at call time unless the instance allows private targets (`SSRF_ALLOW_PRIVATE_TARGETS`).

## When it runs

On a reply that answers an inbound message, in the inbox, in the playground and on the client channel ([`client-channel.md`](client-channel.md), where a `block` or a held failure returns the output template, since there is no team to hand over to), written by the primary or the fallback model. The closing line the model writes when it hands the conversation over is a reply too and is asked about the same way; since the transfer already happened, a block there replaces or silences the line and hands nothing over again. Once per reply: after the built-in output screening, on the text that would go out, before it is split, turned into audio or signed. When the built-in screening already put the operator's own text in its place (a template or a hand-over line), there is nothing of the model's left to judge and the endpoint is not asked. Proactive sends (follow-ups, nudges) and the input direction are not covered.

A person who takes the conversation over while the endpoint is answering wins: the turn re-reads ownership after the answer and delivers nothing.

## Request

`POST <url>` with `content-type: application/json` and the outbound webhook headers (`docs/api-and-fleet.md`): `x-fazerai-delivery`, and with a secret `x-fazerai-timestamp` and `x-fazerai-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.

```json
{
  "version": 1,
  "type": "guardrail.output",
  "candidateId": "<sha256 of the turn id and the candidate text>",
  "tenantId": "1",
  "agentId": "2",
  "conversationId": "3",
  "chatwootConversationId": 42,
  "turnId": "<uuid>",
  "customerMessage": "<the message, or the debounced burst, the turn answers>",
  "toolCalls": [
    { "name": "search_knowledge", "args": {}, "result": "...", "argsSize": 2, "resultSize": 3, "isError": false }
  ],
  "candidate": {
    "text": "<the reply>",
    "attachments": [{ "kind": "image", "fileName": "x.png", "caption": "...", "text": "..." }],
    "model": "primary"
  }
}
```

`conversationId` and `chatwootConversationId` are null in the playground and on the client channel. Tool calls are this turn's, in the order the model made them, at most 50, each value cut to 8000 characters (`argsSize` and `resultSize` are the sizes before the cut); secrets are redacted the way the playground trace redacts them. `candidate.attachments` are the files the reply sends with it, with the caption and the model-written text inside a document; a reply that is only files is asked about too, with an empty `text`, and a `replace` or a `block` drops them. The full prompt (system prompt, memory, history) is not sent.

## Response

A 2xx with a JSON body that echoes `candidateId`:

| `decision` | effect |
| --- | --- |
| `allow` | delivered as usual |
| `replace` | `text` (non-empty, at most 4096 characters) is delivered instead, through split, audio and signature, escaped for Chatwoot like model text, and not screened again |
| `block` | not delivered; `output.action` fires: `template` sends `templateMessage`, `silent` sends nothing, `handoff` hands the conversation to the team with `handoffMessage`, and `generated` sends the template, since no judge wrote a replacement. `reason` (optional, clipped to 500 characters) goes to the note and the log line |

## Failure

The budget is 15 s, DNS lookup and body included. A timeout, a non-2xx, a body that is not a decision, an answer without the request's `candidateId`, a URL the outbound guard refuses, and a signing secret that no longer resolves all follow `guardrails.onFailure` (`docs/logs.md`): `pass` (default) delivers the reply unchecked, `hold` stops it and hands the conversation to the team with `output.handoffMessage`.

## What the operator sees

- A private note in the conversation for `replace`, `block` and a held failure, naming the external check, the decision, the latency, and the reason when there is one.
- A `guardrail` flow line with `detail.check: "external"`: `{direction: "output", decision, latencyMs, action?}` on an answer (`info` for allow, `warn` otherwise), plus the reason: as `endpointReason` only while `observability.logToolValues` is on, since it is free text that may quote the customer, and otherwise as its length, `reasonChars` (the note and the playground trace always carry it), and `{outcome: "external_failed", cause, httpStatus?, latencyMs, unchecked | held}` on a failure. `cause` is one of `timeout`, `http_status`, `network`, `malformed`, `unverifiable`, `unsafe_url`, `secret_not_found`. The Logs page shows the line as a sentence under the row.
- In the playground, a trace entry "External check on the reply" with the decision, the latency, and the reason or the failure.
