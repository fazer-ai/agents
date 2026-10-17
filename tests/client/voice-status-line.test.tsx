/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlaygroundCallView } from "@/client/pages/agents/PlaygroundCall";
import { VoiceStatusLine } from "@/client/pages/agents/VoiceAgentSettings";
import { VoicePlayground } from "@/client/pages/agents/VoicePlayground";
import { withI18n } from "../utils/i18n";

// The line beside the ElevenLabs key: a refused key is said by its sentence alone, and a refusal of the
// agent's settings carries what ElevenLabs said, without the JSON around it.

afterEach(cleanup);

describe("the voice agent's status beside its key", () => {
  test("a refused key is its sentence, without ElevenLabs' own words", () => {
    render(
      withI18n(
        <VoiceStatusLine
          provider="elevenlabs"
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
          provider="elevenlabs"
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

describe("a voice agent ready for calls", () => {
  test("links to the agent on its provider, warning that the settings are changed here", () => {
    render(
      withI18n(
        <VoiceStatusLine
          provider="elevenlabs"
          dirty={false}
          status={{ state: "ready", agentId: "agent_42" }}
        />,
      ),
    );
    expect(
      screen.getByText("Connection with ElevenLabs verified"),
    ).not.toBeNull();
    const link = screen.getByRole("link", {
      name: /See calls and transcripts on ElevenLabs/,
    });
    expect(link.getAttribute("href")).toBe(
      "https://elevenlabs.io/app/agents/agents/agent_42",
    );
    expect(link.getAttribute("title")).toContain("the next save overwrites");
  });

  test("has no link while the provider has not given the agent an id", () => {
    render(
      withI18n(
        <VoiceStatusLine
          provider="elevenlabs"
          dirty={false}
          status={{ state: "ready", agentId: null }}
        />,
      ),
    );
    expect(screen.queryByRole("link")).toBeNull();
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
        <PlaygroundCallView
          provider="elevenlabs"
          onOpenGeneral={() => {}}
          call={failed("invalid_key", "Invalid API key")}
        />,
      ),
    );
    expect(screen.getByText("ElevenLabs refused the key.")).not.toBeNull();
    expect(screen.queryByText("Invalid API key")).toBeNull();
  });

  test("carries what ElevenLabs said when it refused the settings", () => {
    render(
      withI18n(
        <PlaygroundCallView
          provider="elevenlabs"
          onOpenGeneral={() => {}}
          call={failed("sync_failed", "voice not found")}
        />,
      ),
    );
    expect(screen.getByText("voice not found")).not.toBeNull();
  });

  test("sends a key or settings problem to where it is fixed", () => {
    for (const [problem, button] of [
      ["invalid_key", "Review the key"],
      ["missing_permission", "Review the key"],
      ["no_credential", "Review the key"],
      ["sync_failed", "Review the settings"],
    ] as const) {
      let opened = 0;
      const { unmount } = render(
        withI18n(
          <PlaygroundCallView
            provider="elevenlabs"
            onOpenGeneral={() => opened++}
            call={failed(problem, "")}
          />,
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: button }));
      expect([problem, opened]).toEqual([problem, 1]);
      unmount();
    }
    // A problem of the browser is not fixed on General.
    render(
      withI18n(
        <PlaygroundCallView
          provider="elevenlabs"
          onOpenGeneral={() => {}}
          call={failed("microphone", "")}
        />,
      ),
    );
    expect(screen.queryByRole("button", { name: /Review/ })).toBeNull();
  });

  test("a call still being prepared can be cancelled", () => {
    let cancelled = 0;
    render(
      withI18n(
        <PlaygroundCallView
          provider="elevenlabs"
          onOpenGeneral={() => {}}
          call={
            {
              call: { state: "preparing" },
              lines: [],
              meters: { mic: 0, speaker: null },
              cancel: () => cancelled++,
            } as unknown as Parameters<typeof PlaygroundCallView>[0]["call"]
          }
        />,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelled).toBe(1);
  });
});

describe("the Playground with unsaved changes says what saving does to the customers' calls", () => {
  const cases = [
    {
      liveness: "goingLive",
      button: "Put in production and call",
      text: "Saving puts this agent in production: it starts answering the calls of the inboxes marked on Channels.",
    },
    {
      liveness: "leavingLive",
      button: "Save and call",
      text: "Saving takes this agent out of production: it stops answering the calls of the inboxes marked on Channels.",
    },
    {
      liveness: "live",
      button: "Save and call",
      text: "There are unsaved changes. This agent answers customers: saving puts them on its calls too.",
    },
    {
      liveness: "test",
      button: "Save and call",
      text: "There are unsaved changes. Save them to try them, or call the saved version.",
    },
  ] as const;
  for (const c of cases)
    test(c.liveness, () => {
      render(
        withI18n(
          <VoicePlayground
            agentId="7"
            provider="elevenlabs"
            hasKey
            unsaved
            liveness={c.liveness}
            onSave={async () => true}
            onOpenGeneral={() => {}}
          />,
        ),
      );
      expect(screen.getByRole("button", { name: c.button })).not.toBeNull();
      expect(screen.getByText(c.text)).not.toBeNull();
    });
});
