import { describe, expect, test } from "bun:test";
import {
  buildReplyAsTextTool,
  REPLY_AS_TEXT_DONE,
  REPLY_AS_TEXT_TOOL,
  type ReplyChoice,
} from "@/graph/tools/reply-as-text";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import {
  collectOversizedTextChanges,
  TOOL_INSTRUCTIONS_MAX,
} from "@/modules/agents/text-caps";
import {
  plannedReplyIsAudio,
  spokenNoticeFor,
  staticTtsImpossibility,
} from "@/modules/tts/modality";
import { readTtsConfig } from "@/modules/tts/settings";
import {
  SPOKEN_NOTICE_DEFAULT,
  VOICE_CHOICE_TEXT_MAX,
} from "@/modules/tts/settings-shared";

// Issue #859: the model is told when its reply will be spoken, and may choose text for one reply.
// Both are the operator's, per agent, and both are OFF until the operator turns them on.

const cfg = (tts: Record<string, unknown>) =>
  readTtsConfig({
    tts: {
      mode: "mirror",
      provider: "openai",
      credentialRef: "vault:1",
      ...tts,
    },
  });

describe("the settings", () => {
  test("an agent saved before the switches existed has both off and no text", () => {
    const c = readTtsConfig({ tts: { mode: "mirror" } });
    expect([
      c.spokenNotice,
      c.spokenNoticeText,
      c.textChoice,
      c.textChoiceNote,
    ]).toEqual([false, null, false, null]);
    expect(readTtsConfig({}).spokenNotice).toBe(false);
  });

  test("a switch is on only when stored as true", () => {
    expect(cfg({ spokenNotice: "true", textChoice: 1 }).spokenNotice).toBe(
      false,
    );
    expect(cfg({ spokenNotice: true, textChoice: true })).toMatchObject({
      spokenNotice: true,
      textChoice: true,
    });
  });

  test("a blank text reads as none, and a long one is clamped at the ceiling", () => {
    expect(cfg({ spokenNoticeText: "  \n " }).spokenNoticeText).toBeNull();
    expect(cfg({ textChoiceNote: "  nota  " }).textChoiceNote).toBe("nota");
    expect(
      cfg({ spokenNoticeText: "x".repeat(VOICE_CHOICE_TEXT_MAX + 50) })
        .spokenNoticeText?.length,
    ).toBe(VOICE_CHOICE_TEXT_MAX);
  });

  // The reader's clamp and the write boundary's refusal are one number, or text the operator saved
  // would reach the model shorter than the editor shows it.
  test("the write boundary refuses what the reader would cut", () => {
    expect(VOICE_CHOICE_TEXT_MAX).toBe(TOOL_INSTRUCTIONS_MAX);
    const over = "x".repeat(TOOL_INSTRUCTIONS_MAX + 1);
    expect(
      collectOversizedTextChanges(
        { tts: { spokenNoticeText: over, textChoiceNote: over } },
        undefined,
      ).map((o) => o.path),
    ).toEqual(["tts.spokenNoticeText", "tts.textChoiceNote"]);
  });

  test("the patch schema accepts the four keys and refuses a blank text by name", () => {
    const shape = BEHAVIOR_PATCH_SHAPE.tts;
    expect(
      shape.safeParse({
        spokenNotice: true,
        spokenNoticeText: "AVISO",
        textChoice: true,
        textChoiceNote: null,
      }).success,
    ).toBe(true);
    const r = shape.safeParse({ spokenNoticeText: "   " });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("spokenNoticeText");
  });
});

describe("the reply's planned modality", () => {
  const turn = (
    over: Partial<Parameters<typeof plannedReplyIsAudio>[1]> = {},
  ) => ({
    userSentAudio: true,
    contactVoiceReply: null,
    channelType: null,
    ...over,
  });

  test("follows the mode, what the customer sent and their preference", () => {
    expect(plannedReplyIsAudio(cfg({ mode: "never" }), turn())).toBe(false);
    expect(plannedReplyIsAudio(cfg({}), turn())).toBe(true);
    expect(plannedReplyIsAudio(cfg({}), turn({ userSentAudio: false }))).toBe(
      false,
    );
    const pref = cfg({ mode: "preference" });
    expect(
      plannedReplyIsAudio(
        pref,
        turn({ userSentAudio: false, contactVoiceReply: true }),
      ),
    ).toBe(true);
    expect(plannedReplyIsAudio(pref, turn({ contactVoiceReply: false }))).toBe(
      false,
    );
  });

  test("the playground switch overrides the mode, not what cannot work", () => {
    expect(
      plannedReplyIsAudio(
        cfg({ mode: "never" }),
        turn({ userSentAudio: false, forceAudio: true }),
      ),
    ).toBe(true);
    expect(
      plannedReplyIsAudio(
        cfg({ credentialRef: null }),
        turn({ forceAudio: true }),
      ),
    ).toBe(false);
  });

  test("a reply certain to go as text is planned as text", () => {
    expect(
      plannedReplyIsAudio(
        cfg({ provider: "openrouter" }),
        turn({ channelType: "Channel::Instagram" }),
      ),
    ).toBe(false);
    // The same provider where it can deliver: planned as audio, so the case above is the channel.
    expect(plannedReplyIsAudio(cfg({ provider: "openrouter" }), turn())).toBe(
      true,
    );
    expect(plannedReplyIsAudio(cfg({ credentialRef: null }), turn())).toBe(
      false,
    );
    expect(
      plannedReplyIsAudio(cfg({ provider: "elevenlabs", voice: "" }), turn()),
    ).toBe(false);
  });

  // The synthesis skips on the same four, in the same order, so the plan and the skip line cannot
  // name different reasons for one reply.
  test("names the reason the synthesis would skip with", () => {
    const base = readTtsConfig({ tts: { mode: "mirror" } });
    expect(staticTtsImpossibility({ ...base, provider: "nope" }, null)).toBe(
      "unknown_provider",
    );
    expect(
      staticTtsImpossibility(cfg({ provider: "elevenlabs", voice: "" }), null),
    ).toBe("no_voice");
    expect(
      staticTtsImpossibility(
        cfg({ provider: "openrouter" }),
        "Channel::Instagram",
      ),
    ).toBe("channel_format_unsupported");
    expect(staticTtsImpossibility(cfg({ credentialRef: null }), null)).toBe(
      "no_credential",
    );
    expect(staticTtsImpossibility(cfg({}), null)).toBeNull();
  });
});

describe("the notice", () => {
  test("only on a turn planned as audio, and only when turned on", () => {
    expect(spokenNoticeFor(cfg({ spokenNotice: true }), false)).toBeNull();
    expect(spokenNoticeFor(cfg({}), true)).toBeNull();
    expect(spokenNoticeFor(cfg({ spokenNotice: true }), true)).toBe(
      SPOKEN_NOTICE_DEFAULT,
    );
    expect(
      spokenNoticeFor(
        cfg({ spokenNotice: true, spokenNoticeText: "  AVISO  " }),
        true,
      ),
    ).toBe("AVISO");
  });

  test("the default says what the issue asks the model to do", () => {
    expect(SPOKEN_NOTICE_DEFAULT).toContain("mensagem de voz");
    expect(SPOKEN_NOTICE_DEFAULT).toContain("curta");
    expect(SPOKEN_NOTICE_DEFAULT).toContain("sem listas");
    expect(SPOKEN_NOTICE_DEFAULT).toContain("essencial primeiro");
    expect(SPOKEN_NOTICE_DEFAULT).toContain("por escrito");
  });
});

describe("reply_as_text", () => {
  test("records the choice, takes no arguments and carries the operator's note", async () => {
    const choice: ReplyChoice = { textChosen: false };
    const t = buildReplyAsTextTool({ choice, note: " NOTA " });
    expect(t.name).toBe(REPLY_AS_TEXT_TOOL);
    expect(t.description).toContain("Operator guidance: NOTA");
    expect(await t.invoke({})).toBe(REPLY_AS_TEXT_DONE);
    expect(choice.textChosen).toBe(true);
    expect(Object.keys((t.schema as { shape: object }).shape)).toEqual([]);
  });

  test("without a note the description is the capability alone", () => {
    const t = buildReplyAsTextTool({
      choice: { textChosen: false },
      note: null,
    });
    expect(t.description).not.toContain("Operator guidance");
  });
});
