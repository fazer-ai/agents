import { describe, expect, test } from "bun:test";
import {
  type DocumentRowState,
  mergeDocumentEvent,
} from "@/client/lib/knowledgeDocs";

// Decision table for the realtime merge behind the documents modal. The row the operator is looking
// at is patched from the event without a re-fetch, so whatever this function inherits stays on
// screen until a reload — which is what made the stale reason in issue #80 reachable once an
// UNINDEXED badge started rendering `error`.

const blocked: DocumentRowState = {
  status: "UNINDEXED",
  chunkCount: 0,
  error: "errors.embeddingNotConfigured",
};

describe("mergeDocumentEvent", () => {
  test("a block reason on the event reaches the row", () => {
    const row = mergeDocumentEvent(
      { status: "PENDING", chunkCount: 0, error: null } as DocumentRowState,
      { status: "UNINDEXED", error: "errors.embeddingPending" },
    );
    expect(row.status).toBe("UNINDEXED");
    expect(row.error).toBe("errors.embeddingPending");
  });

  // The regression this function exists for: re-index writes `error: null` server-side, so the row
  // must stop claiming a block it no longer has.
  test("a re-queue clears a reason the row was carrying", () => {
    const row = mergeDocumentEvent(blocked, { status: "PENDING" });
    expect(row.status).toBe("PENDING");
    expect(row.error).toBeNull();
  });

  test("reaching READY clears it too", () => {
    const row = mergeDocumentEvent(blocked, { status: "READY", chunkCount: 7 });
    expect(row.error).toBeNull();
    expect(row.chunkCount).toBe(7);
  });

  test("a genuine failure replaces a previous reason instead of merging with it", () => {
    const row = mergeDocumentEvent(blocked, {
      status: "FAILED",
      error: "boom",
    });
    expect(row.error).toBe("boom");
  });

  // The opposite of `error`: the count is only sent on the event that establishes it, and the
  // intermediate states do not mean the document lost its chunks.
  test("chunkCount is inherited when the event does not carry one", () => {
    const row = mergeDocumentEvent(
      { status: "READY", chunkCount: 12, error: null } as DocumentRowState,
      { status: "PENDING" },
    );
    expect(row.chunkCount).toBe(12);
  });

  // The review finding this rule was rewritten for: a title-only PATCH leaves `error` untouched in
  // the database and broadcasts the SAME status with no error, so clearing on it would drop a live
  // failure from every open modal.
  test("an event repeating the status does not clear a live reason", () => {
    const failed: DocumentRowState = {
      status: "FAILED",
      chunkCount: 0,
      error: "boom",
    };
    expect(mergeDocumentEvent(failed, { status: "FAILED" }).error).toBe("boom");
    expect(mergeDocumentEvent(blocked, { status: "UNINDEXED" }).error).toBe(
      "errors.embeddingNotConfigured",
    );
  });

  test("a restated status still takes a NEW reason when the event carries one", () => {
    const failed: DocumentRowState = {
      status: "FAILED",
      chunkCount: 0,
      error: "boom",
    };
    expect(
      mergeDocumentEvent(failed, { status: "FAILED", error: "outra falha" })
        .error,
    ).toBe("outra falha");
  });

  test("fields the event does not describe are left alone", () => {
    const row = mergeDocumentEvent(
      { status: "READY", chunkCount: 3, error: null, title: "Contrato" },
      { status: "PENDING" },
    );
    expect(row.title).toBe("Contrato");
  });
});
