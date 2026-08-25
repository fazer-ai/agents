import { describe, expect, test } from "bun:test";
import {
  type DocumentRowState,
  docErrorEntry,
  mergeDocumentEvent,
} from "@/client/lib/knowledgeDocs";
import {
  EMBEDDING_BLOCK_KEY,
  type EmbeddingBlockReason,
} from "@/lib/embedding-block";

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

// The reason a blocked document carries is written by the SERVER and read by the console, and until
// now the two spelled it differently: `resolveEmbeddingConfig` threw `errors.embedding.<snake_case>`,
// the ingest catch stored that `translationKey` verbatim in `KnowledgeDocument.error`, and the
// console matched `errors.embeddingCamelCase`. Neither branch ever fired, so the operator read the
// raw token off a tooltip.
//
// The assertion is over the PRODUCER's map rather than a list written here, which is the only form
// that survives a reason being added: a new entry in `EMBEDDING_BLOCK_KEY` with no console branch
// fails this test instead of shipping a token to a tooltip.
describe("every reason the server can emit is localizable", () => {
  test("EMBEDDING_BLOCK_KEY is covered by docErrorEntry, entry for entry", () => {
    const reasons = Object.keys(EMBEDDING_BLOCK_KEY) as EmbeddingBlockReason[];
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      const token = EMBEDDING_BLOCK_KEY[reason];
      const entry = docErrorEntry(token);
      expect(entry, `no console branch for ${token}`).not.toBeNull();
      expect(entry?.key).toStartWith("knowledge.docError.");
      expect(entry?.fallback.length ?? 0).toBeGreaterThan(10);
    }
  });

  // Covered is not enough: two reasons pointing at ONE token type-check, pass the coverage check
  // above, and silently tell the operator to fix the wrong thing. A reason is only distinguishable
  // if its token is.
  test("each reason has a token of its own", () => {
    const tokens = Object.values(EMBEDDING_BLOCK_KEY);
    expect(new Set(tokens).size).toBe(tokens.length);
    const sentences = tokens.map((t) => docErrorEntry(t)?.key);
    expect(new Set(sentences).size).toBe(tokens.length);
  });

  // `KnowledgeDocument.error` is STORED, and nothing rewrites it when the producer changes spelling.
  // Every row that failed before issue #256 still carries `errors.embedding.<snake_case>`, so the
  // console has to answer those too or the history reads as raw tokens forever.
  //
  // Derived from EMBEDDING_BLOCK_KEY rather than listed, so a reason added later cannot get a modern
  // token and be forgotten here — the same coupling the coverage test above enforces going forward.
  test("a row written before the rename still gets its sentence", () => {
    for (const reason of Object.keys(
      EMBEDDING_BLOCK_KEY,
    ) as EmbeddingBlockReason[]) {
      const legacy = `errors.embedding.${reason}`;
      const entry = docErrorEntry(legacy);
      expect(entry, `no console branch for legacy ${legacy}`).not.toBeNull();
      // The SAME sentence as the modern token, not merely some sentence: an alias that pointed at
      // another reason would tell the operator to fix the wrong thing and still pass a null check.
      expect(entry).toEqual(docErrorEntry(EMBEDDING_BLOCK_KEY[reason]));
    }
  });

  // The negative case, and it is the design decision: anything that is NOT one of those tokens is a
  // raw provider diagnostic, and the console shows it as-is rather than inventing a sentence.
  test("a diagnostic message is not mistaken for a token", () => {
    expect(docErrorEntry("connect ECONNREFUSED 10.0.0.4:443")).toBeNull();
    expect(docErrorEntry("errors.embeddingSomethingElse")).toBeNull();
    // The dotted shape is not a blanket pass: only the three spellings the producer actually wrote.
    expect(docErrorEntry("errors.embedding.something_else")).toBeNull();
  });
});
