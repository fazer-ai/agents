import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearContactAuthState,
  mediaAdmissionKey,
  mediaAlreadyAdmitted,
  mediaRefusedHereThrough,
  rememberMediaAdmission,
  rememberMediaRefusal,
} from "@/modules/contact-auth/state";

// The per-message memory of a media admission is only a shortcut: it may forget, and
// forgetting costs one more ask to the endpoint. What it must never do is answer past its window.
describe("media admission memory", () => {
  beforeEach(() => clearContactAuthState());

  test("a message is remembered for its window and forgotten after it", () => {
    const key = mediaAdmissionKey(1n, 2n, 3);
    const t0 = 1_000_000;
    rememberMediaAdmission(key, t0);
    expect(mediaAlreadyAdmitted(key, t0 + 14 * 60_000)).toBe(true);
    expect(mediaAlreadyAdmitted(key, t0 + 15 * 60_000)).toBe(false);
    // ...and stays forgotten.
    expect(mediaAlreadyAdmitted(key, t0)).toBe(false);
  });

  test("keyed per tenant, instance and message", () => {
    rememberMediaAdmission(mediaAdmissionKey(1n, 2n, 3), 0);
    expect(mediaAlreadyAdmitted(mediaAdmissionKey(1n, 2n, 4), 0)).toBe(false);
    expect(mediaAlreadyAdmitted(mediaAdmissionKey(1n, 9n, 3), 0)).toBe(false);
    expect(mediaAlreadyAdmitted(mediaAdmissionKey(9n, 2n, 3), 0)).toBe(false);
  });

  test("a refusal kept in process only moves up", () => {
    rememberMediaRefusal("1:2", 50);
    rememberMediaRefusal("1:2", 40);
    expect(mediaRefusedHereThrough("1:2")).toBe(50);
    expect(mediaRefusedHereThrough("1:3")).toBeNull();
  });

  test("a refusal kept in process is never evicted", () => {
    for (let i = 0; i < 10_050; i++) rememberMediaRefusal(`1:${i}`, 7);
    expect(mediaRefusedHereThrough("1:0")).toBe(7);
  });
});
