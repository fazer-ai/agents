import { AppError } from "@/lib/errors";

// READING A PROVIDER'S ANSWER, for the two surfaces that list options from one (the chat/vision/STT
// model list and the TTS voice list). It exists for the seam it draws, not for the two lines of
// parsing: everything that goes wrong AFTER a Response exists is about the answer, and only what
// goes wrong before it is about reaching the host.
//
// Both callers wrap the whole request in one `try` and answer its catch with "could not reach the
// provider". A body that is not JSON, or is the literal `null`, throws inside that try — so the
// catch reported a network the operator should go and check, about a host that answered. Found by
// review on issue #292: before that PR both branches shared one vague sentence, and a mis-aimed
// branch cost nothing; a sentence specific enough to be useful is specific enough to be wrong.
export async function readProviderJson(
  res: Response,
  provider: string,
): Promise<unknown> {
  const parsed = await res.json().then(
    (value: unknown) => ({ ok: true, value }),
    () => ({ ok: false, value: undefined }),
  );
  // NOTE: `null` is refused HERE rather than at the property access that follows every call site.
  // It is valid JSON, and reading a field off it throws a TypeError — in the caller's try, landing
  // in the same catch as a connection failure. A primitive needs no guard: reading a missing field
  // off a string or a number is `undefined`, which every caller already treats as a bad shape.
  if (!parsed.ok || parsed.value === null || parsed.value === undefined) {
    throw new AppError(
      `unexpected ${provider} response`,
      502,
      "errors.providerListUnexpectedResponse",
      { provider },
    );
  }
  return parsed.value;
}
