// The one provider fault LangChain cannot see, as a predicate shared by `model-limit` and
// `model-fallback`, which cannot import each other. LangChain's AsyncCaller retries everything the
// provider answered (the OpenAI SDK's own retry is off); what it misses is a 200 with `choices: []`,
// after which BaseChatModel.invoke throws a TypeError reading `generations[0][0].message` and the turn
// ends with no reply. That expression is the only signal (no status, no typed error), and Bun puts it
// in the message. Matching it rather than any TypeError matters: LangChain runs callback handlers
// inside `invoke`, and retrying a tracing callback's TypeError would bill the same completion twice.
// A runtime that words it differently makes this a silent no-op, never a wrong retry.
export function isEmptyCompletionFault(err: unknown): boolean {
  return err instanceof TypeError && err.message.includes("generations");
}

// What the operator reads when the fault survived its own retry. Ours rather than the provider's,
// because the diagnosis is ours: nothing in the response says it, we concluded it from the
// expression that failed.
export const EMPTY_COMPLETION_MESSAGE =
  "the model provider returned no completion (empty generations)";
