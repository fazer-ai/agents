// What the model form still lacks before the playground can run the live draft. baseURL is not
// checked: it can come from the credential at runtime, and a missing one surfaces as a reply error.
// openai-compatible needs neither a model name (the server's default) nor a credential (an endpoint
// that needs no key gets a placeholder, `createChatModel`), the same rule the General tab saves by.
export function playgroundModelMissing(model: {
  provider: string;
  model: string;
  credentialRef: string | null | undefined;
}): string[] {
  const missing: string[] = [];
  if (!model.provider) missing.push("provider");
  const compatible = model.provider === "openai-compatible";
  if (!model.model.trim() && !compatible) missing.push("model");
  if (!model.credentialRef && !compatible) missing.push("credential");
  return missing;
}
