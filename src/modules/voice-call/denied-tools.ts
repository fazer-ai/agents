// What a call never offers out of an agent's tools, shared by the call's toolset and
// the voice agent's Tools tab so the tab draws exactly what a call can run. Browser-safe: no imports.
// Out: sending files or images, replying in text, closing the conversation under the call, and what
// must not happen without a person confirming (a charge, an email). Document tools deliver a file
// too, and are named after their template (`send_<slug>`), so a call drops the agent's document
// grants whole where its tools are assembled rather than by name here.

export const VOICE_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "send_image",
  "react_to_message",
  "open_case_in_inbox",
  "drive_send_file",
  "reply_as_text",
  "set_voice_preference",
  "skip_reply",
  "suggest_kb_entry",
  "resolve_conversation",
  "handoff_to_human",
  "asaas_payment_link_create",
  "asaas_create_pix_charge",
  "resend_send_email",
  // The engine's own hang-up, declared beside the agent's tools: a custom tool of that name would
  // make two declarations of it, and the engine could not tell the action from ending the call.
  "end_call",
]);

export function isVoiceDeniedTool(name: string): boolean {
  return VOICE_DENIED_TOOLS.has(name);
}
