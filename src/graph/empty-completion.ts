// THE ONE PROVIDER FAULT LANGCHAIN CANNOT SEE, as a predicate two callers share.
//
// It lived inside `model-limit` while `runModelCall`'s retry was its only reader. The fallback
// policy is the second (`model-fallback`), and the two cannot import each other, so the predicate
// moved out rather than being written twice — a rule written twice is a rule the second copy gets
// wrong.
//
// `TypeError` is the predicate, and it is narrow by design. LangChain's AsyncCaller already retries
// everything the PROVIDER answered, and the OpenAI SDK's own retry is disabled in favour of it. What
// no retry covers is a 200 whose body carries no completion: the provider returns `choices: []`,
// `_generate` returns `{ generations: [] }`, the call RESOLVES, and only afterwards does
// BaseChatModel.invoke raise a TypeError reading `generations[0][0].message`. That is issue #63 — an
// intermittent fault ended the turn and the customer got no reply at all.
//
// The failing expression is the only signal there is: the provider answered 200, so there is no
// status, no code and no typed error to match on. Bun (JavaScriptCore) puts that expression in the
// message — `undefined is not an object (evaluating '…generations[0][0].message')` — and Bun is what
// the deploy runs. Matching it, rather than any TypeError, matters because `runModelCall` wraps
// `invoke`, and LangChain runs its callback handlers INSIDE that: a TypeError from a tracing
// callback fires after the provider already answered and was already billed, so retrying it would
// pay for the same completion twice, every turn, until the callback is fixed.
//
// If a future runtime words the message differently the retry stops firing, which is the behaviour
// that shipped before this change — a silent no-op, never a wrong retry.
export function isEmptyCompletionFault(err: unknown): boolean {
  return err instanceof TypeError && err.message.includes("generations");
}

// What the operator reads when the fault survived its own retry. Ours rather than the provider's,
// because the diagnosis is ours: nothing in the response says it, we concluded it from the
// expression that failed.
export const EMPTY_COMPLETION_MESSAGE =
  "the model provider returned no completion (empty generations)";
