/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { PlaygroundCallView } from "@/client/pages/agents/PlaygroundCall";
import { VoiceStatusLine } from "@/client/pages/agents/VoiceAgentSettings";
import { withI18n } from "../utils/i18n";

// The line beside the ElevenLabs key: a refused key is said by its sentence alone, and a refusal of the
// agent's settings carries what ElevenLabs said, without the JSON around it.

afterEach(cleanup);

describe("the voice agent's status beside its key", () => {
  test("a refused key is its sentence, without ElevenLabs' own words", () => {
    render(
      withI18n(
        <VoiceStatusLine
          dirty={false}
          status={{
            state: "problem",
            problem: "invalid_key",
            detail: "Invalid API key",
          }}
        />,
      ),
    );
    expect(screen.getByText("ElevenLabs refused the key.")).not.toBeNull();
    expect(screen.queryByText("Invalid API key")).toBeNull();
  });

  test("a refusal of the settings carries what ElevenLabs said", () => {
    render(
      withI18n(
        <VoiceStatusLine
          dirty={false}
          status={{
            state: "problem",
            problem: "sync_failed",
            detail: "voice not found",
          }}
        />,
      ),
    );
    expect(screen.getByText("voice not found")).not.toBeNull();
  });
});

describe("the Playground's call that did not start", () => {
  const failed = (problem: string, detail: string) =>
    ({
      call: { state: "failed", problem, detail },
      lines: [],
      meters: { mic: 0, speaker: null },
      start: async () => {},
      hangUp: () => {},
      dismiss: () => {},
    }) as unknown as Parameters<typeof PlaygroundCallView>[0]["call"];

  test("says a refused key as the key's tab does, without ElevenLabs' own words", () => {
    render(
      withI18n(
        <PlaygroundCallView call={failed("invalid_key", "Invalid API key")} />,
      ),
    );
    expect(screen.getByText("ElevenLabs refused the key.")).not.toBeNull();
    expect(screen.queryByText("Invalid API key")).toBeNull();
  });

  test("carries what ElevenLabs said when it refused the settings", () => {
    render(
      withI18n(
        <PlaygroundCallView call={failed("sync_failed", "voice not found")} />,
      ),
    );
    expect(screen.getByText("voice not found")).not.toBeNull();
  });
});
