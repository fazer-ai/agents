export interface ApiErrorPayload {
  error?: string;
  // The value the server refused, by ITS name for it: a column (`systemPrompt`), a key of a patch
  // (`document`), or a dotted path into a settings bag (`guardrails.output.templateMessage`): the
  // same strings TEXT_CAP_TARGETS already routes on. Absent whenever the refusal is not about one
  // input, which is most of them. See src/api/lib/refusal.ts.
  field?: string;
}
