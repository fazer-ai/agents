import { describe, expect, test } from "bun:test";
import { ingestDedupeKey, ingestKeyPrefix } from "@/graph/ingest-job";
import { aboveKeyedMessageId } from "@/modules/scheduler/service";

// THE RULE THE /reset REVOKE READS A KEY WITH (issue #736), on its own because it is pure and
// because the round that wrote it got its direction wrong twice before landing here.
//
// The revoke has to answer "is this row's message ABOVE the command's?" for every row under a
// thread's prefix. It cannot ask the payload: `payload.messageId` is a convenience copy that a row
// could be missing, and Prisma renders every JSON path comparison with a
// `JSONB_TYPEOF(...) = 'number'` guard, so a row without it matches no filter either way round.
// The key always answers, because `ingestDedupeKey` builds `ingest:<thread>:<messageId>` and the
// prefix is everything up to the id.
describe("aboveKeyedMessageId", () => {
  // "Above" is what SPARES a row, so every unreadable shape answers
  // false: a key that is not under the prefix, a suffix that is not decimal, and an id too large to
  // compare. Sparing on evidence nobody has is the failure this asymmetry exists to prevent.
  test("spares only what it can read as a higher id", () => {
    const p = "ingest:1:1:ci:5:";
    expect(aboveKeyedMessageId(`${p}900`, p, 800)).toBe(true);
    expect(aboveKeyedMessageId(`${p}800`, p, 800)).toBe(false);
    expect(aboveKeyedMessageId(`${p}700`, p, 800)).toBe(false);
    // Not under the prefix at all: another thread's row, which the caller's `startsWith` already
    // excludes, asserted here so the helper is safe on its own.
    expect(aboveKeyedMessageId("ingest:1:1:ci:50:900", p, 800)).toBe(false);
    // Unreadable suffixes.
    expect(aboveKeyedMessageId(`${p}`, p, 800)).toBe(false);
    expect(aboveKeyedMessageId(`${p}9a0`, p, 800)).toBe(false);
    expect(aboveKeyedMessageId(`${p}-900`, p, 800)).toBe(false);
    expect(aboveKeyedMessageId(`${p}9007199254740993`, p, 800)).toBe(false);
  });
  // THE TWO ENDS TOUCH HERE, and this is the case that earns the import above. Every assertion in
  // the test before this one spells the key out as a literal, so all of them would keep passing if
  // `ingestDedupeKey` grew a field — while the reader, unable to parse any key on the thread, would
  // answer false for every row and the revoke would delete the whole thread's queued ingestion,
  // silently, which is the loss #736 exists to close. Built from the constructor, that change fails
  // in CI instead: it lands here first.
  test("reads back exactly what ingestDedupeKey writes", () => {
    const thread = "7:3:ci:4210";
    const prefix = ingestKeyPrefix(thread);
    expect(ingestDedupeKey(thread, 1004)).toBe(`${prefix}1004`);
    expect(
      aboveKeyedMessageId(ingestDedupeKey(thread, 1004), prefix, 1000),
    ).toBe(true);
    expect(
      aboveKeyedMessageId(ingestDedupeKey(thread, 1000), prefix, 1000),
    ).toBe(false);
    expect(
      aboveKeyedMessageId(ingestDedupeKey(thread, 995), prefix, 1000),
    ).toBe(false);
    // And the trailing colon does its job: a thread whose id is a prefix of another's does not
    // reach the other's rows.
    const vizinha = ingestKeyPrefix("7:3:ci:42");
    expect(
      aboveKeyedMessageId(ingestDedupeKey(thread, 1004), vizinha, 1000),
    ).toBe(false);
  });
});
