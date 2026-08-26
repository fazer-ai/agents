import { describe, expect, test } from "bun:test";
import {
  observabilityToForm,
  observabilityToStored,
} from "@/client/pages/agents/observabilityFormState";
import { readObservabilityConfig } from "@/modules/flowlog/settings";

// The Behavior save REPLACES the `observability` block, so a key this pair drops is DELETED from the
// agent's bag on the next save — silently, and only for whoever hits Save. `tts.baseURL` was lost
// exactly that way. The guard is the round trip: everything a bag can hold has to survive going out
// to the form and coming back.

describe("observability form ↔ stored round trip", () => {
  test("every stored key survives the trip", () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const stored = {
      observability: { logToolValues: true, fullDetailUntil: until },
    };
    expect(observabilityToStored(observabilityToForm(stored))).toEqual({
      logToolValues: true,
      fullDetailUntil: until,
    });
  });

  // The counter-assertion that makes the one above mean something: the pair is checked against the
  // READER's own field list, so a key added to the block and forgotten here fails this test rather
  // than being discovered as data loss.
  test("the pair covers every key the reader answers", () => {
    const read = Object.keys(readObservabilityConfig({})).sort();
    const written = Object.keys(
      observabilityToStored(observabilityToForm({})),
    ).sort();
    // `fullDetail` is derived, so it is read and never written; everything else is both.
    expect(read).toEqual(["fullDetail", "fullDetailUntil", "logToolValues"]);
    expect(written).toEqual(["fullDetailUntil", "logToolValues"]);
  });

  test("an empty bag round-trips to the defaults, not to nothing", () => {
    expect(observabilityToStored(observabilityToForm({}))).toEqual({
      logToolValues: false,
      fullDetailUntil: null,
    });
  });

  // A window that already closed reads as off, and writing it back as null is correct: a spent
  // instant is not a state anyone can act on, and keeping it would make "off" ambiguous.
  test("an expired window is written back as off", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(
      observabilityToStored(
        observabilityToForm({ observability: { fullDetailUntil: past } }),
      ).fullDetailUntil,
    ).toBeNull();
  });

  // The string spelling a bag can carry is honored on read (the runtime honors it), so it must not
  // be silently dropped by the trip out and back.
  test("the string spelling of the boolean survives as a boolean", () => {
    expect(
      observabilityToStored(
        observabilityToForm({ observability: { logToolValues: "true" } }),
      ).logToolValues,
    ).toBe(true);
  });
});

// The read that PERSISTS. The component judges the window against a ticking instant of its own, and
// that was not the whole family: this is where the deadline is decoded on load, and whatever it
// decides is what the next save writes back. A window read as expired here is a window disarmed by
// a save that had nothing to do with it.
const FORM_SOURCE = await Bun.file(
  new URL(
    "../../src/client/pages/agents/observabilityFormState.ts",
    import.meta.url,
  ),
).text();

describe("the form decodes the deadline on the server's clock", () => {
  test("a window still open on the server survives a browser running ahead", () => {
    // The server's window has 30 minutes left; this browser thinks it is an hour from now, which
    // reads the deadline as spent.
    const until = new Date(Date.now() + 30 * 60_000);
    const stored = {
      observability: {
        logToolValues: false,
        fullDetailUntil: until.toISOString(),
      },
    };
    const browserAhead = new Date(Date.now() + 60 * 60_000);
    expect(
      observabilityToForm(stored, browserAhead).fullDetailUntil,
    ).toBeNull();
    // Judged on the server's own instant, it is still armed — and the round trip preserves it, so
    // an unrelated save does not clear it.
    const onServer = observabilityToForm(stored, new Date());
    expect(onServer.fullDetailUntil?.toISOString()).toBe(until.toISOString());
    expect(observabilityToStored(onServer).fullDetailUntil).toBe(
      until.toISOString(),
    );
  });

  test("the default instant is the server's, not the browser's", () => {
    // A property of the SOURCE: the default is what every call site gets, and a call site that
    // forgot to pass one is exactly how this was missed the first time.
    expect(FORM_SOURCE).toContain("now: Date = serverNowDate()");
    expect(FORM_SOURCE).toContain("readObservabilityConfig(settings, now)");
    expect(FORM_SOURCE).not.toContain("readObservabilityConfig(settings)");
  });
});
