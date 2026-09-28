import { AppError } from "@/lib/errors";

// Reading a provider's answer, for the two surfaces that list options from one (the chat/vision/STT
// model list and the TTS voice list). It draws the seam: what goes wrong AFTER a Response exists is
// about the answer, and only what goes wrong before it is about reaching the host. Both callers
// answer their catch with "could not reach the provider", so a non-JSON or `null` body must not throw
// into it and send the operator to check a network that answered.
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
