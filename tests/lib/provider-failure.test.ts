import { describe, expect, test } from "bun:test";
import { asProviderFailure, providerFailure } from "@/lib/provider-failure";

// The decision table for what a provider failure may say once it leaves the call that made it. It
// lives beside the rule, not beside a caller: every provider boundary asks the same question, and a
// rule written once per call site is one the next call site is born without.
describe("providerFailure", () => {
  // NOTE: NOTHING THE SERVER AUTHORED reaches the line, a stronger rule than "no prose". `code` and `type`
  // are vendor identifiers by convention only: the server chooses the value, the product accepts any
  // OpenAI-compatible endpoint, and a bare token is the shape of a phone number, a CPF or a first
  // name. So the fields are dropped, not filtered.
  test("nothing the provider authored reaches the line, however clean it looks", () => {
    const marker = "carambola-com-manjericao-8812";
    // A single bare token in `code`: no whitespace, no prose, and it would have passed a shape test.
    const tokenised = providerFailure(
      Object.assign(new Error("rejected"), {
        name: "BadRequestError",
        status: 400,
        code: marker,
        type: "invalid_request_error",
      }),
    );
    expect(tokenised).not.toContain(marker);
    expect(tokenised).not.toContain("invalid_request_error");
    expect(tokenised).toBe("HTTP 400");

    // The status is read from the client's NUMBER field only, never from the text: a 4xx-shaped
    // number in a message that echoes the transcript is more often the customer's PIN or invoice
    // total, and naming a status the provider never returned sends the operator to the wrong fix.
    const rethrown = providerFailure(
      new Error(`Request failed with status 429 while processing "${marker}"`),
    );
    expect(rethrown).not.toContain(marker);
    expect(rethrown).toBe("provider error");

    // `name` reads like the SDK's class but is a plain writable property, so a wrapper can put a
    // BARE transcript-derived token in it that a shape test would pass. Like `code` and `type`, it is
    // not read.
    const wrapped = providerFailure(
      Object.assign(new Error("boom"), { name: marker, status: 500 }),
    );
    expect(wrapped).not.toContain(marker);
    expect(wrapped).toBe("HTTP 500");

    // `status` is admissible because the client PARSED it into a number, which cannot carry a
    // transcript, so the type check is the whole guarantee. Google's error body puts a string in
    // `status` (`INVALID_ARGUMENT`), so a wrapper copying that field lands server text in it.
    const stringStatus = providerFailure(
      Object.assign(new Error("boom"), { status: `REJECTED_${marker}` }),
    );
    expect(stringStatus).not.toContain(marker);
    expect(stringStatus).toBe("provider error");
    // Both spellings go through the one check, so neither is the one that gets it wrong.
    expect(
      providerFailure(
        Object.assign(new Error("boom"), { statusCode: `REJECTED_${marker}` }),
      ),
    ).toBe("provider error");
    expect(
      providerFailure(Object.assign(new Error("boom"), { statusCode: 503 })),
    ).toBe("HTTP 503");

    // NOTE: Only an integer in the HTTP status range is a status: not NaN, not 0 (never connected),
    // not a figure lifted out of the body. 429.5 isolates the integer check: every other value here
    // fails the range, so without it the list passes and `HTTP 429.5` ships.
    for (const notAStatus of [0, Number.NaN, 429.5, 3.7, 4500, -1, 99]) {
      expect(
        providerFailure(
          Object.assign(new Error("boom"), { status: notAStatus }),
        ),
      ).toBe("provider error");
    }
    expect(
      providerFailure(Object.assign(new Error("boom"), { status: 100 })),
    ).toBe("HTTP 100");
    expect(
      providerFailure(Object.assign(new Error("boom"), { status: 599 })),
    ).toBe("HTTP 599");

    // With nothing to go on, a fixed literal rather than whatever the error happened to be called.
    const opaque = providerFailure(
      Object.assign(new Error(marker), { name: marker }),
    );
    expect(opaque).toBe("provider error");
  });

  // NOTE: the one reading of "it timed out" that the other side does not write. `AbortSignal.timeout` rejects
  // with a DOMException named "TimeoutError", a tell in the same writable field the rule above does
  // not trust, so the signal itself decides, and the summariser holds it.
  test("a summariser that ran out of time says so, from our own signal", () => {
    const marker = "carambola-com-manjericao-8812";
    const controller = new AbortController();
    controller.abort();
    expect(
      providerFailure(
        new Error(`aborted while sending ${marker}`),
        controller.signal.aborted,
      ),
    ).toBe("timeout");
  });

  // The abort tell is read as a PREDICATE choosing between two of our own constants, never published.
  // A caller holding its own signal still has the better reading and says so explicitly; this is for
  // the boundaries that hold none, where the alternative is reporting a timeout as "provider error".
  test("an abort names itself, and a server cannot smuggle anything through that field", () => {
    const marker = "carambola-com-manjericao-8812";
    for (const name of ["AbortError", "TimeoutError"]) {
      expect(
        providerFailure(
          Object.assign(new Error(`aborted while sending ${marker}`), { name }),
        ),
      ).toBe("timeout");
    }

    // Both SDKs raise a CLASS (`APIConnectionTimeoutError`) and leave `name` at "Error" with no
    // status, so reading `name` alone reports a real timeout as "provider error". Matched by suffix,
    // so the next client needs no entry.
    class APIConnectionTimeoutError extends Error {}
    const sdkTimeout = new APIConnectionTimeoutError(
      `Request timed out while sending ${marker}`,
    );
    expect(sdkTimeout.name).toBe("Error");
    expect(providerFailure(sdkTimeout)).toBe("timeout");

    // A caller cancelling is not the endpoint being slow, and does not match.
    class APIUserAbortError extends Error {}
    expect(providerFailure(new APIUserAbortError("aborted"))).toBe(
      "provider error",
    );

    // A status still wins nothing back for a timeout: the naming is checked first, on purpose, since
    // an SDK that attaches both is describing one event.
    const withStatus = Object.assign(
      new APIConnectionTimeoutError("timed out"),
      { status: 408 },
    );
    expect(providerFailure(withStatus)).toBe("timeout");
    // The field is only ever consulted; whatever it holds, the answer is one of ours.
    const lying = providerFailure(
      Object.assign(new Error(marker), { name: `AbortError_${marker}` }),
    );
    expect(lying).not.toContain(marker);
    expect(lying).toBe("provider error");
  });

  // NOTE: what the boundaries throw. The message is the vocabulary above; the original survives as `cause`,
  // a RELOCATION rather than a deletion: the process log makes no PII promise and no product surface
  // exports it, so the vendor's words stay readable where they are allowed to be.
  test("the thrown error carries our words, and keeps the provider's as the cause", () => {
    const marker = "carambola-com-manjericao-8812";
    const original = Object.assign(
      new Error(`400 Invalid prompt: "${marker}"`),
      { status: 400 },
    );
    const thrown = asProviderFailure(original);
    expect(thrown.message).toBe("HTTP 400");
    expect(thrown.message).not.toContain(marker);
    expect(thrown.cause).toBe(original);
  });

  // NOTE: the compaction job reduces a second time because it holds a better reading of "it timed out";
  // without the status riding along, that pass would downgrade `HTTP 429` to "provider error", losing
  // the one distinction an operator acts on.
  test("reducing an already-reduced failure keeps the status", () => {
    const once = asProviderFailure(
      Object.assign(new Error("rate limited"), { status: 429 }),
    );
    expect(providerFailure(once)).toBe("HTTP 429");
    expect(asProviderFailure(once).message).toBe("HTTP 429");
  });

  // And a timeout: the wrapper's name is plain "Error", so a second reading (the stage around a model
  // call) would otherwise call it a "provider error", and a provider timing out would never be a rate.
  test("reducing an already-reduced timeout keeps the timeout", () => {
    const once = asProviderFailure(
      Object.assign(new Error("deadline"), { name: "TimeoutError" }),
    );
    expect(once.name).toBe("Error");
    expect(providerFailure(once)).toBe("timeout");
    expect(asProviderFailure(once).message).toBe("timeout");
    // Only the wrapper built for a timeout: an error that merely says the word is not one.
    expect(providerFailure(new Error("timeout"))).toBe("provider error");
  });

  // A failure with no status at all stays anonymous through the wrapper, so nothing downstream can
  // read a status that never existed.
  test("a connection that never opened carries no status", () => {
    const thrown = asProviderFailure(new Error("ECONNREFUSED"));
    expect(thrown.message).toBe("provider error");
    expect((thrown as unknown as { status?: unknown }).status).toBeUndefined();
  });
});
