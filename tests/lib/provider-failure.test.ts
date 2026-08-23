import { describe, expect, test } from "bun:test";
import { asProviderFailure, providerFailure } from "@/lib/provider-failure";

// The decision table for what a provider failure may say once it leaves the call that made it. It
// lives beside the rule rather than beside any one caller, which is the whole point of the move: the
// same question is asked at every provider boundary in the tree, and a rule written once per call
// site is a rule the next call site is born without.
describe("providerFailure", () => {
  // NOTHING THE SERVER AUTHORED reaches the line — which is a stronger rule than "no prose", and the
  // weaker one is what an earlier revision shipped. `code` and `type` are vendor error identifiers by
  // convention only; the value is chosen by the server, this product accepts an arbitrary
  // OpenAI-compatible endpoint, and a bare token is exactly the shape of a phone number, a CPF or a
  // first name. So the fields are gone, not filtered.
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

    // The status is read from the client's NUMBER field and nowhere else. Digging it out of the text
    // was an earlier revision, and the digits were never the point: a 4xx-shaped number in a message
    // that echoes the transcript is the customer's PIN or their invoice total far more often than it is
    // a transport status, and naming a status the provider never returned sends the operator to the
    // wrong thing to fix.
    const rethrown = providerFailure(
      new Error(`Request failed with status 429 while processing "${marker}"`),
    );
    expect(rethrown).not.toContain(marker);
    expect(rethrown).toBe("provider error");

    // `name` reads like the SDK's class and is a plain writable property, so a wrapper can assign a
    // transcript-derived token to it — and a BARE one is exactly what would have survived a shape test.
    // The field is not read at all now, which is the same answer `code` and `type` got.
    const wrapped = providerFailure(
      Object.assign(new Error("boom"), { name: marker, status: 500 }),
    );
    expect(wrapped).not.toContain(marker);
    expect(wrapped).toBe("HTTP 500");

    // `status` is admissible because the client PARSED it into a number, and a number cannot carry a
    // transcript — so the type check is the whole of the guarantee, not a tidiness. It is not
    // hypothetical either: Google's error body puts a string in `status` (`INVALID_ARGUMENT`), so a
    // wrapper copying that field across lands a server-authored string in it.
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

    // A number is admissible because it cannot carry a transcript — which covers a number that IS a
    // status and nothing else. `HTTP NaN` was never in the vocabulary this promises, and 0 (never
    // connected) and a figure lifted out of the body are not statuses either.
    // 429.5 is the one that isolates the integer check: every other value here is already refused by
    // the range, so without it the list passes and `HTTP 429.5` ships.
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

  // The one reading of "it timed out" that the other side does not write. `AbortSignal.timeout` rejects
  // with a DOMException whose name is "TimeoutError" — a tell living in the same writable field the
  // rule above stopped trusting — so the signal itself is what decides, and the summariser holds it.
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

    // The SDKs raise a CLASS and leave `name` at "Error", with no status either, so reading `name`
    // alone reported a real timeout as "provider error" (round 5). Measured against both clients:
    // `APIConnectionTimeoutError` on each. Matched by suffix, so the next client needs no entry.
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

  // What the boundaries actually throw. The message is the vocabulary above; the original survives as
  // `cause`, which is what keeps this a RELOCATION rather than a deletion — the process log makes no
  // PII promise and is not exported by any product surface, so the vendor's own words stay readable
  // exactly where they are allowed to be.
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

  // Idempotence is not a tidiness here: the compaction job reduces a second time because it holds a
  // better reading of "it timed out", and without the status riding along that second pass would
  // downgrade `HTTP 429` to "provider error" — losing the one distinction an operator acts on, on the
  // lane that motivated the whole rule.
  test("reducing an already-reduced failure keeps the status", () => {
    const once = asProviderFailure(
      Object.assign(new Error("rate limited"), { status: 429 }),
    );
    expect(providerFailure(once)).toBe("HTTP 429");
    expect(asProviderFailure(once).message).toBe("HTTP 429");
  });

  // A failure with no status at all stays anonymous through the wrapper, so nothing downstream can
  // read a status that never existed.
  test("a connection that never opened carries no status", () => {
    const thrown = asProviderFailure(new Error("ECONNREFUSED"));
    expect(thrown.message).toBe("provider error");
    expect((thrown as unknown as { status?: unknown }).status).toBeUndefined();
  });
});
