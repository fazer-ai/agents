// The channel a call comes through, shared with the console (no server imports here): only a WhatsApp
// inbox carried by the fazer.ai connector takes calls.
export const WHATSAPP_CHANNEL = "Channel::Whatsapp";
// The WhatsApp provider the connector carries. The fork refuses a voice agent on any other (Cloud,
// 360dialog, Baileys, Z-API); an inbox whose provider is not synced yet (null) is left to the fork.
export const CONNECTOR_PROVIDER = "native";

/** Whether the inbox can take a voice agent's calls: WhatsApp, on the connector or not yet known. */
export function takesCalls(inbox: {
  channelType: string | null;
  provider: string | null;
}): boolean {
  return (
    inbox.channelType === WHATSAPP_CHANNEL &&
    (inbox.provider === null || inbox.provider === CONNECTOR_PROVIDER)
  );
}
