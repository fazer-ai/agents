import { describe, expect, test } from "bun:test";
import { documentVerdict } from "@/modules/documents/deliverable";

// The delivery rule as a table. Small on purpose: the whole decision is two questions, and the
// reason it is tested here rather than only through the REST route is that the route's own
// file-existence check masks it — a row with no storage key produces a path of "<dir>/null", which
// does not exist, so the route answers 404 either way and reports a missing guard as clean.

describe("documentVerdict", () => {
  test("a rendered, live document is served, and carries its key", () => {
    expect(
      documentVerdict({ pdfStorageKey: "1/2.pdf", revoked: false }),
    ).toEqual({ ok: true, pdfStorageKey: "1/2.pdf" });
  });

  test("a document with no file yet is not rendered", () => {
    expect(documentVerdict({ pdfStorageKey: null, revoked: false })).toEqual({
      ok: false,
      block: "not_rendered",
    });
    // An empty key is the shape that makes this more than tidiness: "<dir>/" is a DIRECTORY, and a
    // caller that skipped this clause would hand it to the file reader instead of answering.
    expect(documentVerdict({ pdfStorageKey: "", revoked: false })).toEqual({
      ok: false,
      block: "not_rendered",
    });
  });

  // Revoked wins over not-yet-rendered: a document the team pulled back is a decision, and "still
  // rendering" is a state — reporting the state would tell the caller to try again.
  test("revoked wins, even over a document that never rendered", () => {
    expect(
      documentVerdict({ pdfStorageKey: "1/2.pdf", revoked: true }),
    ).toEqual({ ok: false, block: "revoked" });
    expect(documentVerdict({ pdfStorageKey: null, revoked: true })).toEqual({
      ok: false,
      block: "revoked",
    });
  });
});
