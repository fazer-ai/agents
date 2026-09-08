import { describe, expect, test } from "bun:test";
import { turnHadTheWords } from "@/modules/chatwoot/webhook";

// The one question the late-media gate asks of a turn: did its input carry the customer's WORDS, or
// only the placeholder a voice note is until STT writes back (issue #576).
describe("turnHadTheWords", () => {
  test("a message with no audio is the message itself", () => {
    expect(turnHadTheWords({ hasAudio: false, transcribedText: null })).toBe(
      true,
    );
  });

  test("audio already transcribed carries its words", () => {
    expect(turnHadTheWords({ hasAudio: true, transcribedText: "alô" })).toBe(
      true,
    );
  });

  // THE CASE THE COLUMN EXISTS NOT TO BREAK: a turn that ran on the placeholder must not claim the
  // message, or the write-back's own ingest is suppressed and the words reach nobody.
  test("audio still waiting on STT does not", () => {
    expect(turnHadTheWords({ hasAudio: true, transcribedText: null })).toBe(
      false,
    );
    expect(
      turnHadTheWords({ hasAudio: true, transcribedText: undefined }),
    ).toBe(false);
    // An empty transcription is not words either.
    expect(turnHadTheWords({ hasAudio: true, transcribedText: "" })).toBe(
      false,
    );
  });

  // AND THE DIRECT PATH ASKS IT WITH THE FILE TYPES, at the source, because the difference is
  // invisible in the answer (PR review, round 9). `firstAudioAttachment` reports whether STT could
  // RUN — it requires a usable id and data_url — so an audio whose url has not landed reads as "no
  // audio", the turn claims the message, and the transcription that follows is suppressed. The
  // debounce path was already asking the file types; a fence is what keeps the two the same
  // question, since either spelling type-checks and only one is right.
  test("the direct path derives hasAudio from the attachment file types", async () => {
    const src = await Bun.file("src/modules/chatwoot/webhook.ts").text();
    const call = src
      .slice(
        src.indexOf("!turnHadTheWords({"),
        src.indexOf("transcribedText: n.message?.transcribedText"),
      )
      // The prose above the call NAMES the wrong spelling in order to warn about it, so read the
      // code and not the commentary — otherwise the fence fails on its own explanation.
      .replaceAll(/^\s*\/\/.*$/gm, "");
    expect(call).toContain('fileType === "audio"');
    expect(call).not.toContain("firstAudioAttachment");
  });
});
